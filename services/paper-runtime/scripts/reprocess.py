"""
reprocess.py — re-run postprocess passes on an already-converted vault paper,
without re-running MinerU. For iterating on cleanup passes.

Usage:
    python reprocess.py <20_Papers/Paper Title.md> [--pdf <original.pdf>] [--write]
    python reprocess.py --all [--write]          # every paper in 20_Papers

The MD filename is the full paper title; the citekey (read from frontmatter)
keys the service-side store: ./store/<citekey>.content_list.json.
The original PDF (for TOC-based headings) comes from the frontmatter
`pdf-path:` field, falling back to Zotero storage via the attachment key
in the `pdf:` field. Without --write, outputs <stem>.preview.md.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from unizero_runtime.pipeline.postprocess import PostCtx, read_pdf_toc, run_passes

HERE = Path(__file__).resolve().parent
STORE = HERE / "store"
ZOTERO_STORAGE = Path.home() / "Zotero" / "storage"
_FM = re.compile(r"\A(---\n.*?\n---\n)", re.S)


def _fm_field(fm: str, key: str) -> str:
    m = re.search(rf"^{re.escape(key)}:\s*(.+)$", fm, re.M)
    return m.group(1).strip().strip('"') if m else ""


def process(md_path: Path, pdf: Path | None, write: bool,
            images_mode: str, table_mode: str,
            strip_references: bool = True) -> None:
    text = md_path.read_text(encoding="utf-8")
    m = _FM.match(text)
    fm, body = (m.group(1), text[m.end():]) if m else ("", text)

    title = _fm_field(fm, "title")
    # filename is the full title; the citekey (frontmatter) keys the store
    citekey = _fm_field(fm, "citekey") or md_path.stem

    zuri = ""
    zm = re.search(r"^pdf:\s*(zotero://open-pdf/\S+)", fm, re.M)
    if zm:
        zuri = zm.group(1)

    cl_path = STORE / f"{citekey}.content_list.json"
    content_list = []
    if cl_path.exists():
        content_list = json.loads(cl_path.read_text(encoding="utf-8"))
    else:
        print(f"  warning: no content_list in store for {citekey}", file=sys.stderr)

    if pdf is None:
        pp = _fm_field(fm, "pdf-path")
        if pp and Path(pp).is_file():
            pdf = Path(pp)
    if pdf is None and zuri:
        km = re.search(r"open-pdf/library/items/([A-Z0-9]+)", zuri)
        if km:
            att_dir = ZOTERO_STORAGE / km.group(1)
            pdfs = list(att_dir.glob("*.pdf")) if att_dir.is_dir() else []
            if pdfs:
                pdf = pdfs[0]
    toc = read_pdf_toc(pdf) if pdf else []

    ctx = PostCtx(
        content_list=content_list, toc=toc, zotero_pdf_uri=zuri, title=title,
        images_mode=images_mode, table_mode=table_mode,
        strip_references=strip_references,
        log=lambda s: print("   " + s),
    )
    new_body = run_passes(body, ctx)

    out = md_path if write else md_path.with_suffix(".preview.md")
    out.write_text(fm + new_body, encoding="utf-8")
    print(f"   wrote {out}")

    # prune attachments the final MD no longer references
    if write:
        att_dir = md_path.parent / "attachments" / citekey
        if att_dir.is_dir():
            referenced = {
                Path(p.replace("\\", "/")).name
                for p in re.findall(r"!\[[^\]]*\]\(([^)\s]+)", new_body)
            }
            removed = 0
            for f in att_dir.iterdir():
                if f.is_file() and f.name not in referenced:
                    f.unlink()
                    removed += 1
            if not any(att_dir.iterdir()):
                att_dir.rmdir()
            if removed:
                print(f"   pruned {removed} unreferenced image(s)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("md", nargs="?", type=Path, help="path to the paper .md")
    ap.add_argument("--all", action="store_true", help="all papers in 20_Papers")
    ap.add_argument("--pdf", type=Path, default=None)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--images-mode", default="none", choices=["none", "all"])
    ap.add_argument("--table-mode", default="none", choices=["none", "md", "html"])
    ap.add_argument("--keep-references", action="store_true",
                    help="do not strip the References section")
    args = ap.parse_args()

    if args.all:
        papers_dir = HERE.parents[1] / "20_Papers"
        targets = sorted(p for p in papers_dir.glob("*.md")
                         if not p.name.endswith(".preview.md"))
    elif args.md:
        targets = [args.md]
    else:
        ap.error("give a .md path or --all")

    for t in targets:
        print(f"== {t.stem}")
        process(t, args.pdf, args.write, args.images_mode, args.table_mode,
                strip_references=not args.keep_references)
    return 0


if __name__ == "__main__":
    sys.exit(main())
