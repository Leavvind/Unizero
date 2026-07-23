"""
migrate_flat.py — one-time migration of vault papers from
  20_Papers/<citekey>/<citekey>.md  (+ images/, content_list.json)
to the flat layout
  20_Papers/<citekey>.md  (+ attachments/<citekey>/, content_list -> service store)

Also re-runs the current postprocess passes (incl. preamble trim) and adds
Semantic Scholar frontmatter fields.

Usage: python migrate_flat.py [--papers-dir D:/code/Academic/20_Papers]
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

from unizero_runtime.pipeline.postprocess import PostCtx, read_pdf_toc, run_passes
from unizero_runtime.providers.semantic_scholar import s2_lookup

HERE = Path(__file__).resolve().parent
STORE = HERE / "store"
ZOTERO_STORAGE = Path.home() / "Zotero" / "storage"

_FM = re.compile(r"\A(---\n.*?\n---\n)", re.S)
_IMG_REF = re.compile(r"(!\[[^\]]*\]\()(?P<path>[^)\s]+)([^)]*\))")


def fm_get(fm: str, key: str) -> str:
    m = re.search(rf"^{key}:\s*(.+)$", fm, re.M)
    if not m:
        return ""
    return m.group(1).strip().strip('"')


def migrate_one(d: Path, papers_dir: Path) -> None:
    name = d.name
    md_path = d / f"{name}.md"
    if not md_path.exists():
        cands = [p for p in d.glob("*.md") if not p.name.endswith(".preview.md")]
        if not cands:
            print(f"  !! no md in {name}, skipped")
            return
        md_path = cands[0]

    text = md_path.read_text(encoding="utf-8")
    m = _FM.match(text)
    fm, body = (m.group(1), text[m.end():]) if m else ("", text)

    title = fm_get(fm, "title")
    doi = fm_get(fm, "doi")
    zuri = ""
    zm = re.search(r"^pdf:\s*(zotero://open-pdf/\S+)", fm, re.M)
    if zm:
        zuri = zm.group(1)

    # content_list -> store
    content_list: list[dict] = []
    STORE.mkdir(exist_ok=True)
    for cl in d.glob("*_content_list.json"):
        try:
            content_list = json.loads(cl.read_text(encoding="utf-8"))
        except Exception:
            pass
        shutil.copy2(cl, STORE / f"{name}.content_list.json")

    # original PDF for TOC (via attachment key in zotero URI)
    toc = []
    km = re.search(r"open-pdf/library/items/([A-Z0-9]+)", zuri)
    if km:
        att_dir = ZOTERO_STORAGE / km.group(1)
        pdfs = list(att_dir.glob("*.pdf")) if att_dir.is_dir() else []
        if pdfs:
            toc = read_pdf_toc(pdfs[0])

    ctx = PostCtx(
        content_list=content_list, toc=toc, zotero_pdf_uri=zuri, title=title,
        log=lambda s: print("   " + s),
    )
    body = run_passes(body, ctx)

    # move referenced images to attachments/<citekey>/, rewrite refs
    referenced = {
        Path(mm.group("path").replace("\\", "/")).name
        for mm in _IMG_REF.finditer(body)
    }
    img_src = d / "images"
    if referenced and img_src.is_dir():
        att_dir = papers_dir / "attachments" / name
        att_dir.mkdir(parents=True, exist_ok=True)
        moved = 0
        for f in img_src.iterdir():
            if f.is_file() and f.name in referenced:
                shutil.copy2(f, att_dir / f.name)
                moved += 1
        body = _IMG_REF.sub(
            lambda mm: mm.group(1) + f"attachments/{name}/"
            + Path(mm.group("path").replace("\\", "/")).name + mm.group(3),
            body,
        )
        print(f"   [migrate] moved {moved} image(s) -> attachments/{name}/")

    # frontmatter: add aliases + semantic scholar
    if title and "aliases:" not in fm:
        fm = re.sub(r"^(title:.*)$", r"\1\naliases:\n  - " + title, fm, count=1, flags=re.M)
    if "semantic-scholar:" not in fm:
        s2 = s2_lookup(doi=doi, title=title)
        if s2:
            add = f"semantic-scholar: {s2['s2_url']}\n"
            if s2.get("citations") is not None:
                add += f"citations: {s2['citations']}\n"
            if not doi and s2.get("doi"):
                add += f"doi: {s2['doi']}\n"
            fm = re.sub(r"^tags:$", add + "tags:", fm, count=1, flags=re.M)
            print(f"   [s2] {s2['s2_url']} (citations: {s2.get('citations')})")
        else:
            print("   [s2] no match")

    (papers_dir / f"{name}.md").write_text(fm + body, encoding="utf-8")
    shutil.rmtree(d)
    print(f"   -> {papers_dir / (name + '.md')}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--papers-dir", type=Path,
                    default=Path(__file__).resolve().parents[2] / "20_Papers")
    args = ap.parse_args()

    for d in sorted(args.papers_dir.iterdir()):
        if not d.is_dir() or d.name == "attachments":
            continue
        print(f"== {d.name}")
        migrate_one(d, args.papers_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
