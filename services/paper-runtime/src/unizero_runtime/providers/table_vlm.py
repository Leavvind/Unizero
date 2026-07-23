"""
table_vlm.py — refine complex tables with MinerU's VLM backend.

The pipeline backend garbles complex tables (merged cells, significance
stars). This module re-runs ONLY the pages containing flagged tables through
`mineru -b vlm-engine` (one invocation, model load amortized) and swaps the
better <table> HTML into the markdown.

Matching is positional: tables appear in the same (page, order-within-page)
sequence in both backends' content_lists.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable, Optional

LogFn = Callable[[str], None]

_TABLE_BLOCK = re.compile(r"<table\b.*?</table>", re.S | re.I)
_COMPLEX = re.compile(r"\b(rowspan|colspan)\s*=", re.I)


def is_complex_table(html: str) -> bool:
    return bool(_COMPLEX.search(html or ""))


def refine_tables(
    pdf_path: Path,
    content_list: list[dict],
    md_text: str,
    work_dir: Path,
    log: LogFn,
    device: str = "cuda",
) -> tuple[str, list[dict], int]:
    """
    Returns (patched_md, patched_content_list, refined_count).
    content_list table entries that were refined gain "vlm_refined": True.
    """
    tables = [e for e in content_list if e.get("type") == "table"]
    flagged_ix = [
        i for i, e in enumerate(tables)
        if is_complex_table(e.get("table_body", "")) and e.get("page_idx") is not None
    ]
    if not flagged_ix:
        return md_text, content_list, 0

    pages = sorted({tables[i]["page_idx"] for i in flagged_ix})
    log(f"[vlm] {len(flagged_ix)} complex table(s) on {len(pages)} page(s) -> vlm-engine")

    # ---- build mini-PDF of flagged pages ----
    import pymupdf
    work_dir.mkdir(parents=True, exist_ok=True)
    mini = work_dir / "vlm_pages.pdf"
    src = pymupdf.open(str(pdf_path))
    try:
        out = pymupdf.open()
        for p in pages:
            if 0 <= p < src.page_count:
                out.insert_pdf(src, from_page=p, to_page=p)
        out.save(str(mini))
        out.close()
    finally:
        src.close()
    mini_to_orig = {mi: p for mi, p in enumerate(pages)}

    # ---- run VLM backend once ----
    vlm_out = work_dir / "vlm_out"
    sibling = Path(sys.executable).with_name(
        "mineru.exe" if sys.platform == "win32" else "mineru"
    )
    mineru = str(sibling) if sibling.is_file() else (shutil.which("mineru") or "mineru")
    cmd = [mineru, "-p", str(mini), "-o", str(vlm_out), "-b", "vlm-engine"]
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", creationflags=creationflags,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        s = line.strip()
        if s and not s.startswith(("Layout", "Predict", "Extract", "Post", "Processing")):
            log("[vlm] " + s[-160:])
    if proc.wait() != 0:
        log("[vlm] vlm-engine failed — tables left as-is")
        return md_text, content_list, 0

    cl_files = list(vlm_out.rglob("*_content_list.json"))
    if not cl_files:
        log("[vlm] no content_list from vlm run — tables left as-is")
        return md_text, content_list, 0
    vlm_cl = json.loads(cl_files[0].read_text(encoding="utf-8"))

    # ---- index VLM tables by (orig_page, order-within-page) ----
    vlm_tables: dict[tuple[int, int], str] = {}
    per_page_count: dict[int, int] = {}
    for e in vlm_cl:
        if e.get("type") != "table" or not e.get("table_body"):
            continue
        orig = mini_to_orig.get(e.get("page_idx", -1))
        if orig is None:
            continue
        order = per_page_count.get(orig, 0)
        per_page_count[orig] = order + 1
        vlm_tables[(orig, order)] = e["table_body"]

    # ---- pipeline tables: (page, order) for each ----
    pl_order: list[tuple[int, int]] = []
    seen: dict[int, int] = {}
    for e in tables:
        p = e.get("page_idx", -1)
        o = seen.get(p, 0)
        seen[p] = o + 1
        pl_order.append((p, o))

    # ---- swap table blocks in md (positional: i-th <table> == tables[i]) ----
    matches = list(_TABLE_BLOCK.finditer(md_text))
    refined = 0
    out_parts: list[str] = []
    last = 0
    for i, m in enumerate(matches):
        repl = None
        if i < len(tables) and i in flagged_ix:
            key = pl_order[i]
            new_html = vlm_tables.get(key)
            if new_html:
                # extract bare <table> from vlm table_body (may carry wrappers)
                tm = _TABLE_BLOCK.search(new_html)
                if tm:
                    repl = tm.group(0)
                    tables[i]["table_body"] = repl
                    tables[i]["vlm_refined"] = True
                    refined += 1
        out_parts.append(md_text[last:m.start()])
        out_parts.append(repl if repl is not None else m.group(0))
        last = m.end()
    out_parts.append(md_text[last:])

    log(f"[vlm] refined {refined}/{len(flagged_ix)} flagged table(s)")
    return "".join(out_parts), content_list, refined
