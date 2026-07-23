"""
tables_export.py — 把 MinerU 识别的表格汇成一个自包含 HTML（作为 Zotero 附件）。

素材全部来自 content_list：caption / footnote / 裁剪图（img_path）/ 页码。
裁剪图优先复用 MinerU 已导出的图片文件；文件缺失时按 bbox 从原 PDF 直接
渲染 —— content_list 的 bbox 是按页宽/页高归一化到 0–1000 的坐标，因此
仅凭 store/<citekey>.content_list.json 加本地 PDF 也能为存量论文回填：

    python tables_export.py <citekey> --pdf <原PDF> [--attachment-key KEY]
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

_BBOX_SCALE = 1000  # content_list bbox 的归一化坐标系
_BBOX_PAD = 3       # 裁剪四周留白（归一化单位），避免线条贴边
_CROP_DPI = 200


@dataclass
class TableEntry:
    kind: str                    # table | figure
    caption: str
    footnote: str
    page_idx: Optional[int]      # 0-based
    img_name: str                # MinerU 裁剪图 basename，可为空
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
    """basename → 文件路径；分块合并后裁剪图位于 images/<chunk>/ 子目录。"""
    if images_root is None or not images_root.is_dir():
        return {}
    return {p.name: p for p in images_root.rglob("*") if p.is_file()}


def _render_crop(doc: Any, entry: TableEntry) -> Optional[bytes]:
    """按归一化 bbox 从 PDF 页面渲染裁剪图（PNG）。"""
    import fitz  # PyMuPDF，随 mineru 依赖安装

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
        parts.append('<p class="missing">（裁剪图不可用 — 见 PDF）</p>')
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
<html lang="zh">
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
<p class="meta">{count} · ZoMiner 表格汇总（自动生成，重新转换会覆盖）</p>
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
    """生成表格汇总 HTML；论文没有表格时返回 None（不写文件）。"""
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
        description="用 store/ 里的 content_list 为已转换论文生成/回填表格汇总 HTML",
    )
    parser.add_argument("citekey", help="store/<citekey>.content_list.json 的 citekey")
    parser.add_argument("--pdf", help="原 PDF 路径（渲染裁剪图；存量论文必需）")
    parser.add_argument("--attachment-key", default="",
                        help="Zotero PDF 附件 key（生成 zotero:// 页码链接）")
    parser.add_argument("--title", default="", help="论文标题（HTML 页首显示）")
    parser.add_argument("--include-figures", action="store_true", help="同时包含插图")
    parser.add_argument("--out", help="输出路径，默认 store/<citekey>.tables.html")
    args = parser.parse_args()

    cl_path = here / "store" / f"{args.citekey}.content_list.json"
    if not cl_path.is_file():
        print(f"未找到 {cl_path}")
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
