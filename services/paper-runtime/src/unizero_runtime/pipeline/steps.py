"""
pipeline.py — PDF → Markdown conversion pipeline (extracted from C:\\Miner\\zotero_browser.py).

Pure functions + a single `convert_pdf()` entry point. No Qt, no GUI.
Steps: (optional split) → mineru CLI → merge → inject zotero page links →
frontmatter → copy into vault.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Callable, Optional

from .postprocess import PostCtx, read_pdf_toc, run_passes
from ..providers.references import extract_references
from ..providers.table_vlm import refine_tables
from ..providers.tables import export_tables_html
from .workflow import ModuleRegistry, WorkflowModule, WorkflowRunner, WorkflowTemplate

LogFn = Callable[[str], None]

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

MIN_CHUNK_SIZE = 5
MAX_CHUNK_SIZE = 500
_MINERU_OCR_LANGS = {
    "ch", "ch_server", "korean", "ta", "te", "ka", "th", "el",
    "arabic", "east_slavic", "cyrillic", "devanagari",
}

_IMG_REF_RE = re.compile(r"""(!\[[^\]]*\]\()(?P<path>[^)\s]+)([^)]*\))""", re.VERBOSE)
_NORM_WS = re.compile(r"\s+")
_MIN_ANCHOR_LEN = 6
_MAX_LINE_JUMP = 300


# --------------------------------------------------------------------------- #
# PDF splitting (for very long documents)
# --------------------------------------------------------------------------- #

def count_pdf_pages(pdf_path: Path) -> int:
    import pymupdf
    doc = pymupdf.open(str(pdf_path))
    try:
        return doc.page_count
    finally:
        doc.close()


def split_pdf_into_chunks(
    pdf_path: Path, chunks_dir: Path, chunk_size: int,
) -> list[tuple[Path, int, int]]:
    """Split into N-page chunks. Returns [(chunk_path, start_1based, end_1based), ...]."""
    import pymupdf

    chunks_dir.mkdir(parents=True, exist_ok=True)
    src = pymupdf.open(str(pdf_path))
    try:
        total = src.page_count
        if total == 0:
            raise RuntimeError(f"{pdf_path} has 0 pages")
        out: list[tuple[Path, int, int]] = []
        w = max(3, len(str(total)))
        # 分块名不带原文件名：超长书名会被 MinerU 截断输出目录名，
        # 导致各分块输出互相覆盖且合并时找不到目录
        for s in range(0, total, chunk_size):
            e = min(s + chunk_size - 1, total - 1)
            cp = chunks_dir / f"chunk_p{s+1:0{w}d}-{e+1:0{w}d}.pdf"
            nd = pymupdf.open()
            try:
                nd.insert_pdf(src, from_page=s, to_page=e)
                nd.save(str(cp))
            finally:
                nd.close()
            out.append((cp, s + 1, e + 1))
        return out
    finally:
        src.close()


def _rewrite_image_refs(md_text: str, prefix: str) -> str:
    """Rewrite relative image refs to point into a per-chunk subdir."""
    def repl(m: re.Match) -> str:
        path = m.group("path")
        if path.startswith(("http://", "https://", "/", "data:")) or (
            len(path) > 1 and path[1] == ":"
        ):
            return m.group(0)
        norm = path.replace("\\", "/")
        if "images/" in norm:
            tail = norm.split("images/", 1)[1]
            return f"{m.group(1)}images/{prefix}/{tail}{m.group(3)}"
        return m.group(0)
    return _IMG_REF_RE.sub(repl, md_text)


def merge_chunk_outputs(
    chunks_info: list[tuple[Path, int, int]],
    chunk_out_root: Path,
    final_md_path: Path,
    final_images_dir: Path,
) -> tuple[int, list[str]]:
    """Concatenate per-chunk markdown + images + content_list JSON into one file."""
    final_md_path.parent.mkdir(parents=True, exist_ok=True)
    final_images_dir.mkdir(parents=True, exist_ok=True)
    parts: list[str] = []
    warnings: list[str] = []
    merged_content_list: list[dict] = []
    count = 0

    for chunk_pdf, sp, ep in chunks_info:
        cs = chunk_pdf.stem
        cdir = chunk_out_root / cs
        if not cdir.exists():
            warnings.append(f"no output for chunk {cs}")
            continue
        md_files = list(cdir.rglob("*.md"))
        if not md_files:
            warnings.append(f"no markdown for chunk {cs}")
            continue
        preferred = [p for p in md_files if p.stem == cs]
        md_path = preferred[0] if preferred else max(md_files, key=lambda p: p.stat().st_size)

        try:
            md_text = md_path.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            warnings.append(f"failed to read {md_path}: {exc}")
            continue

        imgs_dir = md_path.parent / "images"
        if imgs_dir.is_dir() and any(imgs_dir.iterdir()):
            dest = final_images_dir / cs
            try:
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(imgs_dir, dest)
            except Exception as exc:
                warnings.append(f"images copy failed for {cs}: {exc}")

        md_text = _rewrite_image_refs(md_text, cs)
        parts.append(f"\n\n<!-- chunk: pages {sp}-{ep} ({cs}) -->\n\n{md_text.rstrip()}\n")
        count += 1

        cl_files = list(md_path.parent.glob("*_content_list.json"))
        if not cl_files:
            cl_files = list(cdir.rglob("*_content_list.json"))
        if cl_files:
            try:
                cl_data = json.loads(cl_files[0].read_text(encoding="utf-8"))
                page_offset = sp - 1
                for entry in cl_data:
                    if isinstance(entry, dict) and "page_idx" in entry:
                        entry["page_idx"] = entry["page_idx"] + page_offset
                    merged_content_list.append(entry)
            except Exception as exc:
                warnings.append(f"failed to merge content_list for {cs}: {exc}")
        else:
            warnings.append(f"no _content_list.json found for chunk {cs}")

    final_md_path.write_text("".join(parts), encoding="utf-8")

    if merged_content_list:
        cl_out = final_md_path.parent / f"{final_md_path.stem}_content_list.json"
        try:
            cl_out.write_text(
                json.dumps(merged_content_list, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            warnings.append(f"failed to write merged content_list: {exc}")

    return count, warnings


# --------------------------------------------------------------------------- #
# Zotero page-link injection
# --------------------------------------------------------------------------- #

def inject_zotero_page_links(
    md_path: Path,
    content_list_path: Path,
    attachment_key: str,
    page_offset: int = 0,
) -> tuple[int, int]:
    """
    Inject `[pN](zotero://open-pdf/...)` links into a MinerU-generated Markdown
    file, one per page, anchored at the first sufficiently long text block of
    that page (per _content_list.json). Modifies md_path in place.
    Returns (pages_found, pages_injected).
    """
    data = json.loads(content_list_path.read_text(encoding="utf-8"))

    best: dict[int, str] = {}
    for item in data:
        p = item.get("page_idx")
        if p is None:
            continue
        text = item.get("text", "").strip()
        if not text:
            continue
        if p not in best and len(text) >= _MIN_ANCHOR_LEN:
            best[p] = text

    page_texts = sorted(best.items())
    if not page_texts:
        return 0, 0

    md_text = md_path.read_text(encoding="utf-8")
    md_lines = md_text.split("\n")
    base_uri = f"zotero://open-pdf/library/items/{attachment_key}"

    insertions: list[tuple[int, str]] = []
    search_from = 0

    for page_idx, first_text in page_texts:
        line_idx = _find_line_index(md_lines, first_text, search_from)
        if line_idx is None:
            continue
        if insertions and (line_idx - insertions[-1][0]) > _MAX_LINE_JUMP:
            retry = _find_line_index(
                md_lines, first_text, search_from,
                max_line=search_from + _MAX_LINE_JUMP,
            )
            if retry is not None:
                line_idx = retry
            else:
                search_from = line_idx + 1
                continue

        pdf_page = page_idx + 1 + page_offset
        link = f"[p{pdf_page}]({base_uri}?page={pdf_page})"
        insertions.append((line_idx, link))
        search_from = line_idx + 1

    for line_idx, link in reversed(insertions):
        prefix = ""
        if line_idx > 0 and md_lines[line_idx - 1].strip() != "":
            prefix = "\n"
        md_lines.insert(line_idx, prefix + link + "\n")

    md_path.write_text("\n".join(md_lines), encoding="utf-8")
    return len(page_texts), len(insertions)


def _find_line_index(
    md_lines: list[str],
    anchor_text: str,
    start_from: int = 0,
    max_line: Optional[int] = None,
) -> Optional[int]:
    anchor = _NORM_WS.sub(" ", anchor_text).strip()[:50]
    if not anchor:
        return None
    end = max_line if max_line is not None else len(md_lines)
    for i in range(start_from, end):
        line_norm = _NORM_WS.sub(" ", md_lines[i]).strip()
        line_clean = re.sub(r"^#+\s*", "", line_norm)
        if line_clean.startswith(anchor) or line_norm.startswith(anchor):
            return i
    return None


# --------------------------------------------------------------------------- #
# Frontmatter
# --------------------------------------------------------------------------- #

def _yaml_str(s: str) -> str:
    """Quote a YAML scalar safely."""
    if s == "":
        return '""'
    if re.search(r'[:#\[\]{}&*!|>\'"%@`,\n]|^[\s-]|[\s]$', s):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


_FNAME_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_filename(title: str, fallback: str = "paper") -> str:
    """Sanitize a paper title into a Windows-safe file stem."""
    s = _FNAME_BAD.sub(" ", title or "")
    s = re.sub(r"\s+", " ", s).strip(" .")
    if len(s) > 150:
        s = s[:150].rstrip(" .")
    return s or fallback


def _fm_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return _yaml_str(str(v))


_FM_PLACEHOLDER = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")


def _fm_variables(meta: "PaperMeta") -> dict[str, str]:
    """附加字段值里可用的 {{ 变量 }}。"""
    return {
        "title": meta.title,
        "citekey": meta.citekey,
        "year": meta.year,
        "doi": meta.doi,
        "publication": meta.publication,
        "item_key": meta.item_key,
        "attachment_key": meta.attachment_key,
        "zotero_select": (
            f"zotero://select/library/items/{meta.item_key}" if meta.item_key else ""
        ),
        "zotero_pdf": (
            f"zotero://open-pdf/library/items/{meta.attachment_key}"
            if meta.attachment_key else ""
        ),
    }


def _fm_render(v, variables: dict[str, str]):
    if isinstance(v, str):
        return _FM_PLACEHOLDER.sub(
            lambda m: variables.get(m.group(1), m.group(0)), v,
        )
    return v


def build_frontmatter(meta: "PaperMeta", mineru_version: str = "",
                      pdf_path: Optional[Path] = None,
                      fm_cfg: Optional[dict] = None) -> str:
    """fm_cfg: {"tags": [...], "extra": {key: value}} — user-configurable parts."""
    fm_cfg = fm_cfg or {}
    lines = ["---"]
    lines.append(f"title: {_yaml_str(meta.title)}")
    if meta.citekey:
        # filename is the full title; the citekey alias keeps [[citekey]] links resolving
        lines.append("aliases:")
        lines.append(f"  - {_yaml_str(meta.citekey)}")
    if meta.authors:
        lines.append("authors:")
        for a in meta.authors:
            lines.append(f"  - {_yaml_str(a)}")
    if meta.year:
        lines.append(f"year: {meta.year}")
    if meta.citekey:
        lines.append(f"citekey: {_yaml_str(meta.citekey)}")
    if meta.doi:
        lines.append(f"doi: {_yaml_str(meta.doi)}")
    if meta.publication:
        lines.append(f"publication: {_yaml_str(meta.publication)}")
    if meta.item_key:
        lines.append(f"zotero: zotero://select/library/items/{meta.item_key}")
    if meta.attachment_key:
        lines.append(f"pdf: zotero://open-pdf/library/items/{meta.attachment_key}")
    if pdf_path is not None:
        # local path so an agent can Read specific PDF pages directly
        lines.append(f"pdf-path: {_yaml_str(str(pdf_path).replace(chr(92), '/'))}")
    if meta.s2_url:
        lines.append(f"semantic-scholar: {meta.s2_url}")
    if meta.s2_citations is not None:
        lines.append(f"citations: {meta.s2_citations}")
    variables = _fm_variables(meta)
    for k, v in (fm_cfg.get("extra") or {}).items():
        k = str(k).strip()
        if not k:
            continue
        if isinstance(v, list):
            lines.append(f"{k}:")
            for it in v:
                lines.append(f"  - {_fm_value(_fm_render(it, variables))}")
        else:
            lines.append(f"{k}: {_fm_value(_fm_render(v, variables))}")
    # tags 未配置时默认 paper；显式配置为空列表则不输出 tags 字段
    tags = fm_cfg.get("tags")
    if tags is None:
        tags = ["paper"]
    if tags:
        lines.append("tags:")
        for t in tags:
            lines.append(f"  - {_fm_value(t)}")
    lines.append(f"created: {date.today().isoformat()}")
    if mineru_version:
        lines.append(f"converter: mineru {mineru_version}")
    lines.append("---")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Conversion job
# --------------------------------------------------------------------------- #

@dataclass
class PaperMeta:
    title: str = ""
    authors: list[str] = field(default_factory=list)
    year: str = ""
    citekey: str = ""
    doi: str = ""
    publication: str = ""
    item_key: str = ""          # Zotero parent item key
    attachment_key: str = ""    # Zotero PDF attachment key
    s2_url: str = ""            # Semantic Scholar page
    s2_citations: Optional[int] = None


@dataclass
class ConvertOptions:
    backend: str = "pipeline"       # pipeline | vlm-transformers | ...
    ocr_mode: str = "auto"          # auto | ocr | txt
    language: str = "en"
    device: str = "auto"             # retained for config compatibility; MinerU 3.x auto-selects
    enable_formula: bool = True
    enable_table: bool = True
    split_threshold: int = 200      # auto-split PDFs longer than this
    chunk_size: int = 50
    # postprocess
    images_mode: str = "none"       # none: drop figure images, keep caption+link
    table_mode: str = "none"        # none: skip ALL tables (PDF pointer) | md | html
    strip_repeated_lines: bool = False
    strip_references: bool = True   # drop the References section, leave PDF pointer
    table_vlm: bool = False         # re-run complex-table pages through vlm-engine


@dataclass
class ConvertResult:
    md_path: Path
    images_dir: Optional[Path]
    pages_found: int = 0
    pages_injected: int = 0
    warnings: list[str] = field(default_factory=list)
    workflow: dict = field(default_factory=dict)
    tables_html_path: Optional[Path] = None
    references: list[dict] = field(default_factory=list)
    references_path: Optional[Path] = None


def _mineru_cmd(src: Path, out_dir: Path, opts: ConvertOptions) -> list[str]:
    cmd = [
        _mineru_executable(), "-p", str(src), "-o", str(out_dir),
        "-b", opts.backend,
    ]
    if opts.backend == "pipeline":
        cmd += [
            "-m", opts.ocr_mode,
            "-f", "true" if opts.enable_formula else "false",
            "-t", "true" if opts.enable_table else "false",
        ]
        # MinerU 3.x auto-selects CPU/MPS/CUDA and no longer accepts `-d`.
        # English is handled by the default OCR model; `-l en` is invalid.
        language = (opts.language or "").strip().lower()
        if language in _MINERU_OCR_LANGS:
            cmd += ["-l", language]
    return cmd


def _mineru_executable() -> str:
    """Prefer the MinerU installed beside the active virtualenv Python."""
    sibling = Path(sys.executable).with_name(
        "mineru.exe" if sys.platform == "win32" else "mineru"
    )
    if sibling.is_file():
        return str(sibling)
    return shutil.which("mineru") or "mineru"


def _run(cmd: list[str], log: LogFn) -> int:
    log("$ " + " ".join(cmd))
    creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        creationflags=creationflags,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        s = line.rstrip()
        # skip tqdm progress-bar spam (floods the job log ring buffer)
        if "%|" in s or not s.strip():
            continue
        log(s)
    return proc.wait()


@dataclass
class ConversionContext:
    """Mutable artifacts passed between the stages of one conversion run."""

    pdf_path: Path
    work_dir: Path
    papers_dir: Path
    output_root: Optional[Path]
    citekey: str
    meta: PaperMeta
    opts: ConvertOptions
    log: LogFn
    mineru_version: str = ""
    store_dir: Optional[Path] = None
    fm_cfg: Optional[dict] = None
    enrich: Optional[Callable[[PaperMeta, LogFn], None]] = None
    warnings: list[str] = field(default_factory=list)
    pages: int = 0
    out_md: Optional[Path] = None
    content_list_path: Optional[Path] = None
    content_list: list[dict] = field(default_factory=list)
    references: list[dict] = field(default_factory=list)
    references_path: Optional[Path] = None
    body: str = ""
    frontmatter: str = ""
    final_md: Optional[Path] = None
    final_images: Optional[Path] = None
    tables_html: Optional[Path] = None
    pages_found: int = 0
    pages_injected: int = 0


def _require_output(ctx: ConversionContext) -> Path:
    if ctx.out_md is None:
        raise RuntimeError("workflow has no extracted markdown artifact")
    return ctx.out_md


def _stage_enrich(ctx: ConversionContext, _settings: dict[str, Any]) -> None:
    if ctx.enrich is not None:
        ctx.enrich(ctx.meta, ctx.log)


def _stage_extract(ctx: ConversionContext, settings: dict[str, Any]) -> None:
    execution = str(settings.get("execution") or "local")
    if execution != "local":
        raise RuntimeError(
            f"MinerU execution mode '{execution}' is not available in this service version",
        )
    ctx.opts.backend = str(settings.get("backend") or ctx.opts.backend)
    ctx.opts.ocr_mode = str(settings.get("ocr_mode") or ctx.opts.ocr_mode)
    language = str(settings.get("language") or ctx.opts.language)
    ctx.opts.language = "ch" if language == "zh" else language
    ctx.opts.enable_formula = bool(settings.get("enable_formula", ctx.opts.enable_formula))
    ctx.opts.enable_table = bool(settings.get("enable_table", ctx.opts.enable_table))
    chunking = settings.get("chunking") or {}
    if bool(chunking.get("enabled", True)):
        ctx.opts.split_threshold = int(
            chunking.get("threshold_pages", ctx.opts.split_threshold),
        )
        ctx.opts.chunk_size = int(chunking.get("chunk_size", ctx.opts.chunk_size))
    else:
        ctx.opts.split_threshold = 2**31 - 1

    ctx.work_dir.mkdir(parents=True, exist_ok=True)
    ctx.pages = count_pdf_pages(ctx.pdf_path)
    ctx.log(f"[info] {ctx.pdf_path.name}: {ctx.pages} pages")

    if ctx.pages > ctx.opts.split_threshold:
        ctx.log(
            f"[split] {ctx.pages} pages > {ctx.opts.split_threshold}, "
            f"chunking by {ctx.opts.chunk_size}",
        )
        chunks_dir = ctx.work_dir / "_chunks"
        chunk_out_root = ctx.work_dir / "_chunk_outputs"
        chunk_size = max(MIN_CHUNK_SIZE, min(MAX_CHUNK_SIZE, ctx.opts.chunk_size))
        chunks_info = split_pdf_into_chunks(ctx.pdf_path, chunks_dir, chunk_size)
        for ci, (chunk_pdf, sp, ep) in enumerate(chunks_info, 1):
            ctx.log(f"[split] chunk {ci}/{len(chunks_info)}: pages {sp}-{ep}")
            rc = _run(_mineru_cmd(chunk_pdf, chunk_out_root, ctx.opts), ctx.log)
            if rc != 0:
                raise RuntimeError(f"mineru failed on chunk {ci} (exit {rc})")
        merged_dir = ctx.work_dir / "merged"
        ctx.out_md = merged_dir / f"{ctx.pdf_path.stem}.md"
        merged, merge_warnings = merge_chunk_outputs(
            chunks_info, chunk_out_root, ctx.out_md, merged_dir / "images",
        )
        ctx.warnings += merge_warnings
        if merged == 0:
            detail = "; ".join(merge_warnings[:3]) or "unknown"
            raise RuntimeError(f"no chunk produced markdown ({detail})")
        shutil.rmtree(chunks_dir, ignore_errors=True)
        shutil.rmtree(chunk_out_root, ignore_errors=True)
    else:
        rc = _run(_mineru_cmd(ctx.pdf_path, ctx.work_dir, ctx.opts), ctx.log)
        if rc != 0:
            raise RuntimeError(f"mineru exit code {rc}")
        md_candidates = list(ctx.work_dir.rglob("*.md"))
        if not md_candidates:
            raise RuntimeError("mineru produced no markdown")
        ctx.out_md = max(md_candidates, key=lambda p: p.stat().st_size)

    ctx.log(f"[info] markdown: {ctx.out_md}")


def _stage_page_links(ctx: ConversionContext, _settings: dict[str, Any]) -> None:
    out_md = _require_output(ctx)
    candidates = list(out_md.parent.glob("*_content_list.json"))
    ctx.content_list_path = candidates[0] if candidates else None
    if not ctx.meta.attachment_key:
        return
    if ctx.content_list_path is None:
        ctx.warnings.append("no _content_list.json — skipped page links")
        return
    try:
        ctx.pages_found, ctx.pages_injected = inject_zotero_page_links(
            out_md, ctx.content_list_path, ctx.meta.attachment_key,
        )
        ctx.log(f"[links] injected {ctx.pages_injected}/{ctx.pages_found} page links")
    except Exception as exc:
        ctx.warnings.append(f"page-link injection failed: {exc}")


def _stage_references(ctx: ConversionContext, settings: dict[str, Any]) -> None:
    """Extract the reference list from content_list into structured JSON.

    Runs before markdown-cleanup's strip_references so the section is still
    present. Reads the untouched content_list, so ordering relative to cleanup
    is not load-bearing, but placing it first keeps intent obvious.
    """
    if ctx.content_list_path is None:
        out_md = _require_output(ctx)
        candidates = list(out_md.parent.glob("*_content_list.json"))
        ctx.content_list_path = candidates[0] if candidates else None
    if ctx.content_list_path is None:
        ctx.warnings.append("no _content_list.json — skipped reference extraction")
        return
    if not ctx.content_list:
        try:
            ctx.content_list = json.loads(
                ctx.content_list_path.read_text(encoding="utf-8"),
            )
        except Exception as exc:
            ctx.warnings.append(f"content_list unreadable: {exc}")
            return

    ctx.references = extract_references(ctx.content_list, ctx.log)
    if not ctx.references and bool(settings.get("warn_if_empty", True)):
        ctx.warnings.append("reference extraction found 0 references")

    out_md = _require_output(ctx)
    sidecar = out_md.parent / f"{out_md.stem}.references.json"
    try:
        sidecar.write_text(
            json.dumps(ctx.references, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        ctx.references_path = sidecar
    except Exception as exc:
        ctx.warnings.append(f"failed to write references sidecar: {exc}")


def _stage_transform(ctx: ConversionContext, settings: dict[str, Any]) -> None:
    ctx.opts.images_mode = str(settings.get("images_mode") or ctx.opts.images_mode)
    ctx.opts.table_mode = str(settings.get("table_mode") or ctx.opts.table_mode)
    ctx.opts.strip_repeated_lines = bool(
        settings.get("strip_repeated_lines", ctx.opts.strip_repeated_lines),
    )
    ctx.opts.strip_references = bool(
        settings.get("strip_references", ctx.opts.strip_references),
    )
    ctx.opts.table_vlm = bool(settings.get("table_vlm", ctx.opts.table_vlm))
    out_md = _require_output(ctx)
    if ctx.content_list_path is not None:
        try:
            ctx.content_list = json.loads(
                ctx.content_list_path.read_text(encoding="utf-8"),
            )
        except Exception as exc:
            ctx.warnings.append(f"content_list unreadable: {exc}")

    body_text = out_md.read_text(encoding="utf-8")
    if ctx.opts.table_vlm and ctx.content_list:
        try:
            body_text, ctx.content_list, _ = refine_tables(
                ctx.pdf_path,
                ctx.content_list,
                body_text,
                ctx.work_dir / "_vlm",
                ctx.log,
                device=ctx.opts.device,
            )
        except Exception as exc:
            ctx.warnings.append(f"vlm table refinement failed: {exc}")

    post_ctx = PostCtx(
        content_list=ctx.content_list,
        toc=read_pdf_toc(ctx.pdf_path),
        zotero_pdf_uri=(
            f"zotero://open-pdf/library/items/{ctx.meta.attachment_key}"
            if ctx.meta.attachment_key else ""
        ),
        title=ctx.meta.title,
        images_mode=ctx.opts.images_mode,
        table_mode=ctx.opts.table_mode,
        strip_repeated_lines=ctx.opts.strip_repeated_lines,
        strip_references=ctx.opts.strip_references,
        log=ctx.log,
    )
    ctx.body = run_passes(body_text, post_ctx)


def _stage_tables_export(ctx: ConversionContext, settings: dict[str, Any]) -> None:
    out_md = _require_output(ctx)
    content_list = ctx.content_list
    if not content_list:
        cl_path = ctx.content_list_path
        if cl_path is None:
            candidates = list(out_md.parent.glob("*_content_list.json"))
            cl_path = candidates[0] if candidates else None
        if cl_path is not None:
            try:
                content_list = json.loads(cl_path.read_text(encoding="utf-8"))
            except Exception as exc:
                ctx.warnings.append(f"tables export: content_list unreadable: {exc}")
                return
    if not content_list:
        ctx.warnings.append("tables export: no content_list — skipped")
        return
    target_dir = ctx.store_dir if ctx.store_dir is not None else out_md.parent
    try:
        ctx.tables_html = export_tables_html(
            content_list,
            target_dir / f"{ctx.citekey}.tables.html",
            title=ctx.meta.title or ctx.citekey,
            citekey=ctx.citekey,
            zotero_pdf_uri=(
                f"zotero://open-pdf/library/items/{ctx.meta.attachment_key}"
                if ctx.meta.attachment_key else ""
            ),
            pdf_path=ctx.pdf_path,
            images_root=out_md.parent / "images",
            include_figures=bool(settings.get("include_figures", False)),
            log=ctx.log,
        )
    except Exception as exc:
        # 汇总是附属产物，失败不应中断整个转换
        ctx.warnings.append(f"tables export failed: {exc}")


def _stage_frontmatter(ctx: ConversionContext, settings: dict[str, Any]) -> None:
    config = dict(ctx.fm_cfg or {})
    config.update(settings)
    ctx.frontmatter = build_frontmatter(
        ctx.meta,
        ctx.mineru_version,
        pdf_path=ctx.pdf_path,
        fm_cfg=config,
    )


def _obsidian_registry_path() -> Optional[Path]:
    """本机 Obsidian 的库注册文件（记录每个库名对应的本地路径）。"""
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        return Path(appdata) / "obsidian" / "obsidian.json" if appdata else None
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "obsidian" / "obsidian.json"
    return Path.home() / ".config" / "obsidian" / "obsidian.json"


def resolve_obsidian_destination(destination: str) -> Path:
    """`obsidian://<库名>/<子目录>` → 本机该 Obsidian 库下的绝对路径。

    同名库在 Windows/macOS 上路径不同，用库名寻址可以让同一份模板跨系统通用。
    """
    spec = destination[len("obsidian://"):].replace("\\", "/").strip("/")
    vault_name, _, sub_path = spec.partition("/")
    if not vault_name:
        raise RuntimeError("obsidian:// 目标缺少库名，格式应为 obsidian://库名/子目录")
    registry = _obsidian_registry_path()
    if registry is None or not registry.is_file():
        raise RuntimeError(
            f"未找到本机 Obsidian 配置（{registry}）；"
            "请确认已安装并打开过 Obsidian，或改用绝对路径",
        )
    vaults = json.loads(registry.read_text(encoding="utf-8")).get("vaults") or {}
    paths = [Path(str(entry.get("path", ""))) for entry in vaults.values() if entry.get("path")]
    for vault_path in paths:
        if vault_path.name == vault_name:
            return vault_path / sub_path if sub_path else vault_path
    for vault_path in paths:
        if vault_path.name.lower() == vault_name.lower():
            return vault_path / sub_path if sub_path else vault_path
    known = "、".join(p.name for p in paths) or "（无）"
    raise RuntimeError(
        f"本机 Obsidian 中没有名为“{vault_name}”的库；已注册的库：{known}",
    )


def _stage_publish(ctx: ConversionContext, settings: dict[str, Any]) -> None:
    out_md = _require_output(ctx)
    if not ctx.body:
        # Process modules are optional: Extract + Publish must still produce a
        # useful document when every transform is disabled.
        ctx.body = out_md.read_text(encoding="utf-8")
    destination = str(settings.get("destination") or ctx.papers_dir.name).strip()
    destination_path = Path(destination)
    if destination.startswith("obsidian://"):
        ctx.papers_dir = resolve_obsidian_destination(destination)
    elif destination_path.is_absolute():
        ctx.papers_dir = destination_path
    elif ctx.output_root is not None:
        ctx.papers_dir = ctx.output_root / destination_path
    else:
        raise RuntimeError(
            "Publish 目标目录是相对路径，但未配置默认输出基目录；"
            "请设置基目录或改用绝对路径",
        )
    ctx.papers_dir.mkdir(parents=True, exist_ok=True)
    filename_template = str(settings.get("filename") or "{{ title }}.md")
    rendered_filename = (
        filename_template
        .replace("{{ title }}", ctx.meta.title or ctx.citekey)
        .replace("{{ citekey }}", ctx.citekey)
    )
    suffix = Path(rendered_filename).suffix or ".md"
    filename_stem = Path(rendered_filename).stem
    ctx.final_md = ctx.papers_dir / (
        safe_filename(filename_stem, ctx.citekey) + suffix
    )

    existing_file = str(settings.get("existing_file") or "overwrite")
    if ctx.final_md.exists() and existing_file == "skip":
        ctx.log(f"[publish] kept existing {ctx.final_md}")
        return
    if ctx.final_md.exists() and existing_file == "rename":
        stem = ctx.final_md.stem
        suffix = ctx.final_md.suffix
        counter = 2
        while ctx.final_md.exists():
            ctx.final_md = ctx.papers_dir / f"{stem} ({counter}){suffix}"
            counter += 1

    src_images = out_md.parent / "images"
    referenced = {
        Path(match.group("path").replace("\\", "/")).name
        for match in _IMG_REF_RE.finditer(ctx.body)
    }
    copy_referenced_only = bool(settings.get("copy_referenced_only", True))
    if src_images.is_dir() and (referenced or not copy_referenced_only):
        attachments_directory = str(
            settings.get("attachments_directory") or "attachments",
        )
        att_dir = ctx.papers_dir / attachments_directory / ctx.citekey
        if att_dir.exists():
            shutil.rmtree(att_dir)
        att_dir.mkdir(parents=True)
        copied = 0
        for image in src_images.rglob("*"):
            if image.is_file() and (
                not copy_referenced_only or image.name in referenced
            ):
                shutil.copy2(image, att_dir / image.name)
                copied += 1
        if copied:
            ctx.final_images = att_dir
            ctx.body = _IMG_REF_RE.sub(
                lambda match: (
                    match.group(1)
                    + f"{attachments_directory}/{ctx.citekey}/"
                    + Path(match.group("path").replace("\\", "/")).name
                    + match.group(3)
                ),
                ctx.body,
            )
            ctx.log(f"[vault] copied {copied} referenced image(s) -> {att_dir}")
        else:
            shutil.rmtree(att_dir)

    ctx.final_md.write_text(ctx.frontmatter + ctx.body, encoding="utf-8")

    if ctx.store_dir is not None and ctx.content_list:
        ctx.store_dir.mkdir(parents=True, exist_ok=True)
        (ctx.store_dir / f"{ctx.citekey}.content_list.json").write_text(
            json.dumps(ctx.content_list, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    ctx.log(f"[vault] wrote {ctx.final_md}")


def _object_schema(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }


MODULE_REGISTRY: ModuleRegistry[ConversionContext] = ModuleRegistry()
MODULE_REGISTRY.register(WorkflowModule(
    id="enrich.semantic-scholar",
    name="Semantic Scholar 元数据补全",
    role="prepare",
    handler=_stage_enrich,
    description="根据 DOI 或标题补全 S2 链接、引用数和缺失 DOI。",
    settings_schema=_object_schema({}),
))
MODULE_REGISTRY.register(WorkflowModule(
    id="extract.mineru",
    name="Extract · MinerU",
    role="extract",
    handler=_stage_extract,
    description="调用 MinerU 解析 PDF；Extract 是模板必选模块。",
    defaults={
        "execution": "local",
        "backend": "pipeline",
        "ocr_mode": "auto",
        "language": "auto",
        "enable_formula": True,
        "enable_table": True,
        "chunking": {"enabled": True, "threshold_pages": 200, "chunk_size": 50},
    },
    settings_schema=_object_schema({
        "execution": {
            "type": "string", "title": "执行位置", "enum": ["local"],
            "enumNames": ["本地"],
            "description": "API runner 将在后续版本接入。",
        },
        "backend": {
            "type": "string", "title": "解析后端",
            "enum": ["pipeline", "vlm-transformers"],
            "enumNames": ["Pipeline", "本地 VLM"],
        },
        "ocr_mode": {
            "type": "string", "title": "OCR 模式",
            "enum": ["auto", "ocr", "txt"],
        },
        "language": {
            "type": "string", "title": "语言",
            "enum": ["auto", "en", "zh"],
            "enumNames": ["自动", "English", "中文"],
        },
        "enable_formula": {"type": "boolean", "title": "识别公式"},
        "enable_table": {"type": "boolean", "title": "识别表格"},
        "chunking": _object_schema({
            "enabled": {"type": "boolean", "title": "启用长 PDF 切块"},
            "threshold_pages": {
                "type": "integer", "title": "切块阈值（页）", "minimum": 1,
            },
            "chunk_size": {
                "type": "integer", "title": "每块页数", "minimum": 5,
            },
        }),
    }),
))
MODULE_REGISTRY.register(WorkflowModule(
    id="transform.zotero-page-links",
    name="Zotero 页码链接",
    role="process",
    handler=_stage_page_links,
    description="把内容块连接到 zotero://open-pdf 的对应页码。",
    settings_schema=_object_schema({}),
))
MODULE_REGISTRY.register(WorkflowModule(
    id="transform.references",
    name="参考文献抽取",
    role="process",
    handler=_stage_references,
    description=(
        "从 content_list 抽取参考文献段，解析为结构化条目"
        "（raw 引文 / 页码 / DOI / arXiv），供引用侧栏解析入库。"
        "需在 markdown-cleanup 的 strip_references 之前运行。"
    ),
    defaults={"warn_if_empty": True},
    settings_schema=_object_schema({
        "warn_if_empty": {"type": "boolean", "title": "0 条参考文献时告警"},
    }),
))
MODULE_REGISTRY.register(WorkflowModule(
    id="transform.markdown-cleanup",
    name="Markdown 后处理",
    role="process",
    handler=_stage_transform,
    description="处理目录、标题、图片、表格、重复行和 References。",
    defaults={
        "images_mode": "none", "table_mode": "none",
        "strip_repeated_lines": False, "strip_references": True,
        "table_vlm": False,
    },
    settings_schema=_object_schema({
        "images_mode": {
            "type": "string", "title": "图片模式", "enum": ["none", "all"],
            "enumNames": ["仅保留 PDF 指针", "保存引用图片"],
        },
        "table_mode": {
            "type": "string", "title": "表格模式", "enum": ["none", "md", "html"],
            "enumNames": ["仅保留 PDF 指针", "Markdown", "HTML"],
        },
        "strip_repeated_lines": {"type": "boolean", "title": "清理重复行"},
        "strip_references": {"type": "boolean", "title": "清理 References"},
        "table_vlm": {"type": "boolean", "title": "VLM 精修复杂表格"},
    }),
))
MODULE_REGISTRY.register(WorkflowModule(
    id="export.zotero-tables",
    name="表格汇总（Zotero 附件）",
    role="process",
    handler=_stage_tables_export,
    description=(
        "把全部表格的裁剪图、表注和页码链接汇成一个自包含 HTML；"
        "插件会把它作为附件存入 Zotero 条目（重新转换时覆盖）。"
    ),
    defaults={"include_figures": False},
    settings_schema=_object_schema({
        "include_figures": {"type": "boolean", "title": "同时包含插图"},
    }),
))
MODULE_REGISTRY.register(WorkflowModule(
    id="transform.frontmatter",
    name="YAML Frontmatter",
    role="process",
    handler=_stage_frontmatter,
    description="生成 Markdown 顶部的 YAML 元数据。",
    defaults={"tags": ["paper"], "extra": {}},
    settings_schema=_object_schema({
        "tags": {"type": "array", "title": "Tags", "items": {"type": "string"}},
        "extra": {
            "type": "object", "title": "附加字段", "additionalProperties": True,
            "description": (
                "每行一个 key: value。值支持变量：{{ title }}、{{ citekey }}、"
                "{{ year }}、{{ doi }}、{{ zotero_select }}（Zotero 条目链接）、"
                "{{ zotero_pdf }}（PDF 链接）。例如 url: {{ zotero_select }}。"
            ),
        },
    }),
))
MODULE_REGISTRY.register(WorkflowModule(
    id="publish.markdown-directory",
    name="Publish · Markdown 目录",
    role="publish",
    handler=_stage_publish,
    description=(
        "将 Markdown 和引用图片保存到目标目录；支持绝对路径、"
        "基于默认输出基目录的相对路径，以及 obsidian://库名/子目录。"
        "Publish 是模板必选模块。"
    ),
    defaults={
        "destination": "20_Papers", "filename": "{{ title }}.md",
        "attachments_directory": "attachments", "copy_referenced_only": True,
        "existing_file": "overwrite",
    },
    settings_schema=_object_schema({
        "destination": {
            "type": "string",
            "title": "目标目录（绝对 / 相对 / Obsidian 库）",
            "description": (
                "绝对路径直接使用；相对路径基于“设置 → 服务目录”"
                "中的默认输出基目录；obsidian://库名/子目录 按本机 "
                "Obsidian 配置自动定位同名库，跨 Windows/macOS 通用。"
            ),
        },
        "filename": {
            "type": "string", "title": "文件名模板",
            "description": "支持 {{ title }} 和 {{ citekey }}。",
        },
        "attachments_directory": {"type": "string", "title": "附件子目录"},
        "copy_referenced_only": {"type": "boolean", "title": "只复制正文引用的图片"},
        "existing_file": {
            "type": "string", "title": "文件已存在",
            "enum": ["overwrite", "skip", "rename"],
            "enumNames": ["覆盖", "跳过", "自动重命名"],
        },
    }),
))


def convert_pdf(
    pdf_path: Path,
    work_dir: Path,
    papers_dir: Path,
    citekey: str,
    meta: PaperMeta,
    opts: ConvertOptions,
    log: LogFn,
    mineru_version: str = "",
    store_dir: Optional[Path] = None,
    fm_cfg: Optional[dict] = None,
    template: Optional[WorkflowTemplate] = None,
    output_root: Optional[Path] = None,
    enrich: Optional[Callable[[PaperMeta, LogFn], None]] = None,
) -> ConvertResult:
    """Run a validated YAML template and return its published artifacts."""
    if template is None:
        raise ValueError("a conversion template is required")

    context = ConversionContext(
        pdf_path=pdf_path,
        work_dir=work_dir,
        papers_dir=papers_dir,
        output_root=(
            output_root
            if output_root is not None
            else papers_dir.parent if papers_dir.is_absolute()
            else None
        ),
        citekey=citekey,
        meta=meta,
        opts=opts,
        log=log,
        mineru_version=mineru_version,
        store_dir=store_dir,
        fm_cfg=fm_cfg,
        enrich=enrich,
    )
    report = WorkflowRunner(template, MODULE_REGISTRY).run(context, log)
    if context.final_md is None:
        raise RuntimeError(f"template '{template.id}' produced no Markdown artifact")
    return ConvertResult(
        md_path=context.final_md,
        images_dir=context.final_images,
        tables_html_path=context.tables_html,
        pages_found=context.pages_found,
        pages_injected=context.pages_injected,
        warnings=context.warnings,
        workflow={
            "id": report.workflow_id,
            "version": report.workflow_version,
            "stages": [asdict(stage) for stage in report.stages],
        },
        references=context.references,
        references_path=context.references_path,
    )
