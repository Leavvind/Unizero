"""
tables_export.py — collect the tables MinerU detected into one self-contained
HTML file (stored as a Zotero attachment).

Everything comes from content_list: caption / footnote / cropped image
(img_path) / page number. Cropped images reuse the files MinerU already
exported; when a file is missing the crop is rendered straight from the source
PDF using the bbox — content_list bboxes are normalised to 0–1000 against page
width/height, so store/<citekey>.content_list.json plus a local PDF is enough to
backfill previously converted papers:

    python tables_export.py <citekey> --pdf <source PDF> [--attachment-key KEY]
"""

from __future__ import annotations

import argparse
import base64
import html
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

_BBOX_SCALE = 1000  # normalised coordinate system of content_list bboxes
_BBOX_PAD = 3       # crop padding (normalised units) so rules are not clipped
_CROP_DPI = 200


@dataclass
class TableEntry:
    kind: str                    # table | figure
    caption: str
    footnote: str
    page_idx: Optional[int]      # 0-based
    img_name: str                # basename of the MinerU crop; may be empty
    bbox: Optional[list]


def collect_entries(
    content_list: list[dict[str, Any]],
    include_figures: bool = False,
) -> list[TableEntry]:
    entries: list[TableEntry] = []
    for item in content_list:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "table":
            caption = " ".join(item.get("table_caption") or []).strip()
            footnote = " ".join(item.get("table_footnote") or []).strip()
        elif kind == "image" and include_figures:
            kind = "figure"
            caption = " ".join(item.get("image_caption") or []).strip()
            footnote = " ".join(item.get("image_footnote") or []).strip()
        else:
            continue
        img_path = str(item.get("img_path") or "").replace("\\", "/")
        entries.append(TableEntry(
            kind=kind,
            caption=caption,
            footnote=footnote,
            page_idx=item.get("page_idx"),
            img_name=Path(img_path).name if img_path else "",
            bbox=item.get("bbox"),
        ))
    return entries


def _index_images(images_root: Optional[Path]) -> dict[str, Path]:
    """basename → file path; after chunk merging crops live in images/<chunk>/."""
    if images_root is None or not images_root.is_dir():
        return {}
    return {p.name: p for p in images_root.rglob("*") if p.is_file()}


def _render_crop(doc: Any, entry: TableEntry) -> Optional[bytes]:
    """Render a crop (PNG) from the PDF page using the normalised bbox."""
    import fitz  # PyMuPDF, installed as a mineru dependency

    if entry.page_idx is None or not entry.bbox or len(entry.bbox) != 4:
        return None
    if not 0 <= entry.page_idx < doc.page_count:
        return None
    page = doc[entry.page_idx]
    rect = page.rect
    x0, y0, x1, y1 = entry.bbox
    clip = fitz.Rect(
        (x0 - _BBOX_PAD) / _BBOX_SCALE * rect.width,
        (y0 - _BBOX_PAD) / _BBOX_SCALE * rect.height,
        (x1 + _BBOX_PAD) / _BBOX_SCALE * rect.width,
        (y1 + _BBOX_PAD) / _BBOX_SCALE * rect.height,
    ) & rect
    if clip.is_empty:
        return None
    return page.get_pixmap(clip=clip, dpi=_CROP_DPI).tobytes("png")


def _block_html(
    entry: TableEntry,
    image_data: Optional[bytes],
    mime: str,
    zotero_pdf_uri: str,
) -> str:
    page = entry.page_idx + 1 if entry.page_idx is not None else None
    heading = entry.caption or (
        ("Table" if entry.kind == "table" else "Figure")
        + (f" (p{page})" if page else "")
    )
    parts = [f"<section>\n<h2>{html.escape(heading)}</h2>"]
    if image_data is not None:
        encoded = base64.b64encode(image_data).decode("ascii")
        parts.append(
            f'<img src="data:{mime};base64,{encoded}" '
            f'alt="{html.escape(entry.caption or entry.kind)}">'
        )
    else:
        parts.append('<p class="missing">(crop unavailable — see PDF)</p>')
    if entry.footnote:
        parts.append(f'<p class="footnote">{html.escape(entry.footnote)}</p>')
    if page is not None and zotero_pdf_uri:
        parts.append(
            f'<p class="pointer"><a href="{html.escape(zotero_pdf_uri)}'
            f'?page={page}">PDF p{page}</a></p>'
        )
    elif page is not None:
        parts.append(f'<p class="pointer">PDF p{page}</p>')
    parts.append("</section>")
    return "\n".join(parts)


_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tables — {title}</title>
<style>
body {{ font: 15px/1.6 -apple-system, "Segoe UI", "PingFang SC", sans-serif;
       max-width: 62em; margin: 2em auto; padding: 0 1em; color: #222; }}
h1 {{ font-size: 1.3em; }} h1 small {{ color: #888; font-weight: normal; }}
h2 {{ font-size: 1.05em; margin: 2.2em 0 0.6em; }}
section {{ border-top: 1px solid #eee; }}
img {{ max-width: 100%; border: 1px solid #ddd; border-radius: 4px; }}
.meta, .footnote {{ color: #555; font-size: 0.85em; }}
.missing {{ color: #a66; }}
.pointer a {{ color: #4a6fa5; text-decoration: none; }}
</style>
</head>
<body>
<h1>{title} <small>{citekey}</small></h1>
<p class="meta">{count} · ZoMiner table digest (generated; re-conversion overwrites it)</p>
{blocks}
</body>
</html>
"""


def export_tables_html(
    content_list: list[dict[str, Any]],
    out_path: Path,
    *,
    title: str = "",
    citekey: str = "",
    zotero_pdf_uri: str = "",
    pdf_path: Optional[Path] = None,
    images_root: Optional[Path] = None,
    include_figures: bool = False,
    log: LogFn = print,
) -> Optional[Path]:
    """Write the table digest HTML; return None (and write nothing) if the
    paper has no tables."""
    entries = collect_entries(content_list, include_figures)
    if not entries:
        log("[tables-export] no tables in content_list — skipped")
        return None

    index = _index_images(images_root)
    doc = None
    blocks: list[str] = []
    rendered = missing = 0
    try:
        for entry in entries:
            image_data: Optional[bytes] = None
            mime = "image/png"
            crop = index.get(entry.img_name) if entry.img_name else None
            if crop is not None:
                image_data = crop.read_bytes()
                if crop.suffix.lower() in (".jpg", ".jpeg"):
                    mime = "image/jpeg"
            elif pdf_path is not None:
                if doc is None:
                    import fitz
                    doc = fitz.open(pdf_path)
                image_data = _render_crop(doc, entry)
                if image_data is not None:
                    rendered += 1
            if image_data is None:
                missing += 1
            blocks.append(_block_html(entry, image_data, mime, zotero_pdf_uri))
    finally:
        if doc is not None:
            doc.close()

    n_tables = sum(1 for e in entries if e.kind == "table")
    n_figures = len(entries) - n_tables
    count = f"{n_tables} tables" + (f" · {n_figures} figures" if n_figures else "")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        _PAGE_TEMPLATE.format(
            title=html.escape(title or citekey),
            citekey=html.escape(citekey),
            count=count,
            blocks="\n".join(blocks),
        ),
        encoding="utf-8",
    )
    log(f"[tables-export] {len(entries)} entr(ies) -> {out_path}"
        + (f" ({rendered} rendered from PDF)" if rendered else "")
        + (f" ({missing} without image)" if missing else ""))
    return out_path


def main() -> int:
    here = Path(__file__).parent
    parser = argparse.ArgumentParser(
        description=(
            "Generate or backfill the table digest HTML for an already "
            "converted paper from the content_list in store/"
        ),
    )
    parser.add_argument("citekey",
                        help="citekey of store/<citekey>.content_list.json")
    parser.add_argument("--pdf",
                        help="source PDF path (renders crops; required for "
                             "previously converted papers)")
    parser.add_argument("--attachment-key", default="",
                        help="Zotero PDF attachment key (used for zotero:// "
                             "page links)")
    parser.add_argument("--title", default="",
                        help="paper title (shown in the HTML header)")
    parser.add_argument("--include-figures", action="store_true",
                        help="include figures as well")
    parser.add_argument("--out",
                        help="output path; defaults to "
                             "store/<citekey>.tables.html")
    args = parser.parse_args()

    cl_path = here / "store" / f"{args.citekey}.content_list.json"
    if not cl_path.is_file():
        print(f"not found: {cl_path}")
        return 1
    content_list = json.loads(cl_path.read_text(encoding="utf-8"))
    out = export_tables_html(
        content_list,
        Path(args.out) if args.out else here / "store" / f"{args.citekey}.tables.html",
        title=args.title or args.citekey,
        citekey=args.citekey,
        zotero_pdf_uri=(
            f"zotero://open-pdf/library/items/{args.attachment_key}"
            if args.attachment_key else ""
        ),
        pdf_path=Path(args.pdf) if args.pdf else None,
        include_figures=args.include_figures,
    )
    return 0 if out is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
