"""
postprocess.py — cleanup passes applied to MinerU markdown before it enters the vault.

Each pass is a pure function (md_text, ctx) -> md_text, run in order by
`run_passes()`. Passes must NOT touch existing [pN](zotero://...) link lines.

Context (`PostCtx`) carries the content_list, PDF outline (TOC), zotero base
URI and config, so passes can anchor decisions on MinerU's layout metadata
instead of guessing from text alone.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable, Optional

LogFn = Callable[[str], None]


@dataclass
class PostCtx:
    content_list: list[dict] = field(default_factory=list)
    toc: list[tuple[int, str, int]] = field(default_factory=list)  # (level, title, page)
    zotero_pdf_uri: str = ""          # zotero://open-pdf/library/items/KEY
    title: str = ""                   # article title (from Zotero metadata)
    images_mode: str = "none"         # none | all
    table_mode: str = "md"            # md | html
    strip_repeated_lines: bool = False
    strip_references: bool = True     # drop the References section body
    log: LogFn = lambda s: None


# =========================================================================== #
# Helpers
# =========================================================================== #

_ZLINK_LINE = re.compile(r"^\[p\d+\]\(zotero://")
_NORM = re.compile(r"[^0-9a-zA-Z一-鿿]+")


def _norm(s: str) -> str:
    """Normalize for fuzzy title matching: keep alnum + CJK, lowercase."""
    return _NORM.sub("", s).lower()


def _page_link(ctx: PostCtx, page_idx: Optional[int]) -> str:
    """content_list page_idx (0-based) -> [pN](zotero://...) or ''."""
    if page_idx is None or not ctx.zotero_pdf_uri:
        return ""
    p = page_idx + 1
    return f"[p{p}]({ctx.zotero_pdf_uri}?page={p})"


# =========================================================================== #
# Pass 0 — trim preamble: drop everything before the Abstract
# =========================================================================== #
# Replaces MinerU's rendition of the title block (title, author lines, OCR'd
# affiliations, translated abstracts, etc.) with a clean `# {title}` heading
# from Zotero metadata. Conservative: does nothing if no Abstract marker is
# found in the first part of the document.

# "A B S T R A C T" (Elsevier letter-spaced) matches too
_ABSTRACT_HEADING = re.compile(
    r"^#{1,6}\s*\**\s*(a\s*b\s*s\s*t\s*r\s*a\s*c\s*t|摘\s*要)\b[\s:.]*\**\s*$", re.I)
_ABSTRACT_INLINE = re.compile(r"^\**\s*(abstract|摘\s*要)\b[\s:.—-]*", re.I)


def pass_trim_preamble(md: str, ctx: PostCtx) -> str:
    lines = md.split("\n")
    limit = min(len(lines), 200)   # abstract must appear early
    idx = None
    inline = False
    for i in range(limit):
        s = lines[i].strip()
        if _ABSTRACT_HEADING.match(s):
            idx = i
            break
        # plain-paragraph abstract: "Abstract This paper ..." / "ABSTRACT:"
        if not s.startswith(("#", "|", "!", "[", ">")) and _ABSTRACT_INLINE.match(s) \
                and len(s) > 40:
            idx = i
            inline = True
            break
        if s.lower() in ("abstract", "abstract:", "摘要"):
            idx = i
            break

    jel = False
    if idx is None:
        # fallback for finance papers without an "Abstract" marker: the
        # abstract paragraph typically ends with a JEL classification
        for i in range(limit):
            s = lines[i].strip()
            if len(s) > 200 and re.search(r"\(JEL\s+[A-Z]\d", s):
                idx, jel = i, True
                break
    if idx is None:
        return md

    head: list[str] = []
    if ctx.title:
        head.append("# " + ctx.title)
        head.append("")
    if ctx.zotero_pdf_uri:
        head.append(f"[p1]({ctx.zotero_pdf_uri}?page=1)")
        head.append("")

    if jel:
        body = ["## Abstract", "", lines[idx]] + lines[idx + 1:]
    elif inline:
        body = ["## Abstract", "", _ABSTRACT_INLINE.sub("", lines[idx], count=1)]
        body += lines[idx + 1:]
    else:
        body = ["## Abstract"] + lines[idx + 1:]

    ctx.log(f"[preamble] dropped {idx} line(s) before Abstract")
    return "\n".join(head + body)


# =========================================================================== #
# Pass 1 — heading levels from the PDF outline (TOC)
# =========================================================================== #

def pass_heading_levels(md: str, ctx: PostCtx) -> str:
    """
    Rewrite '#' levels using the PDF bookmark outline when available;
    fall back to section-numbering heuristics (1. / 2.1 / 2.1.3).
    H1 is reserved for the paper title (first heading).
    """
    lines = md.split("\n")
    heading_ix = [i for i, l in enumerate(lines) if re.match(r"^#{1,6}\s", l)]
    if not heading_ix:
        return md

    changed = 0
    if ctx.toc:
        # min outline level -> H2 (title stays H1)
        min_lvl = min(l for l, _, _ in ctx.toc)
        toc_map = {}
        for lvl, title, _page in ctx.toc:
            key = _norm(title)
            if len(key) >= 4:
                toc_map.setdefault(key, lvl - min_lvl + 2)
        for i in heading_ix:
            text = re.sub(r"^#{1,6}\s+", "", lines[i]).strip()
            key = _norm(text)
            new_lvl = toc_map.get(key)
            if new_lvl is None:
                # startswith match for headings with trailing junk
                for k, v in toc_map.items():
                    if key.startswith(k) or k.startswith(key):
                        new_lvl = v
                        break
            if new_lvl is not None:
                new_lvl = min(new_lvl, 6)
                lines[i] = "#" * new_lvl + " " + text
                changed += 1
        if changed:
            ctx.log(f"[headings] set {changed} level(s) from PDF outline")
            return "\n".join(lines)

    # Fallback: numbering heuristic — only if enough numbered headings
    num_re = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+\S")
    numbered: dict[int, int] = {}   # line index -> level
    for i in heading_ix:
        text = re.sub(r"^#{1,6}\s+", "", lines[i]).strip()
        m = num_re.match(text)
        if m:
            numbered[i] = min(m.group(1).count(".") + 2, 6)  # "1" -> H2, "1.2" -> H3
    if len(numbered) >= 3:
        top_level = re.compile(
            r"^(references|bibliography|appendix|acknowledg|conclusion)", re.I)
        cur = 1  # level of the enclosing numbered section
        for i in heading_ix:
            text = re.sub(r"^#{1,6}\s+", "", lines[i]).strip()
            if i in numbered:
                cur = numbered[i]
                lines[i] = "#" * cur + " " + text
            elif i == heading_ix[0]:
                lines[i] = "# " + text          # paper title stays H1
            elif top_level.match(text):
                lines[i] = "## " + text
                cur = 2
            else:
                # unnumbered heading inside a numbered section -> one deeper
                lines[i] = "#" * min(cur + 1, 6) + " " + text
        ctx.log(f"[headings] normalized {len(heading_ix)} heading(s) "
                f"({len(numbered)} numbered)")
        return "\n".join(lines)

    return md


# =========================================================================== #
# Pass 2 — heading noise (escaped footnote stars, broken <sub>/<sup> runs)
# =========================================================================== #

def pass_clean_headings(md: str, ctx: PostCtx) -> str:
    lines = md.split("\n")
    n = 0
    for i, line in enumerate(lines):
        if not re.match(r"^#{1,6}\s", line):
            continue
        orig = line
        # strip inline sub/sup fragments (OCR-mangled accents): <sub>RESUM</sub> <sub>E</sub>
        line = re.sub(r"</?su[bp]>", "", line)
        # trailing escaped footnote markers: "Title\*" / "Title \*\*"
        line = re.sub(r"(?:\s*\\\*)+\s*$", "", line)
        # collapse whitespace
        line = re.sub(r"\s{2,}", " ", line).rstrip()
        if line != orig:
            lines[i] = line
            n += 1
    if n:
        ctx.log(f"[headings] cleaned noise in {n} heading(s)")
    return "\n".join(lines)


# =========================================================================== #
# Pass 3 — broken hyphenation ("beha- vior" -> "behavior")
# =========================================================================== #

_HYPH = re.compile(r"([a-z]{2,})- ([a-z]{2,})")


def pass_hyphenation(md: str, ctx: PostCtx) -> str:
    out = []
    n = 0
    for line in md.split("\n"):
        if _ZLINK_LINE.match(line) or line.lstrip().startswith(("#", "|", "!", "<")):
            out.append(line)
            continue
        new, k = _HYPH.subn(r"\1\2", line)
        n += k
        out.append(new)
    if n:
        ctx.log(f"[hyphen] joined {n} broken word(s)")
    return "\n".join(out)


# =========================================================================== #
# Pass 3b — OCR ligature loss ("dificulty" -> "difficulty")
# =========================================================================== #
# PDF text extraction often drops one letter from ff/fi/ffi ligatures.
# Conservative fixed list — every pattern is a real observed breakage that is
# not itself an English word.

_LIGATURE_FIXES = [
    (re.compile(r"\bdiferen"), "differen"),      # diferent/diference
    (re.compile(r"\bdificult"), "difficult"),
    (re.compile(r"\beficien"), "efficien"),
    (re.compile(r"\bcoeficien"), "coefficien"),
    (re.compile(r"\bsuficien"), "sufficien"),
    (re.compile(r"\befect"), "effect"),
    (re.compile(r"\boficial"), "official"),
    (re.compile(r"signiican"), "significan"),
    (re.compile(r"speciic"), "specific"),
    (re.compile(r"identiic"), "identific"),
    (re.compile(r"classiic"), "classific"),
]


def pass_ligatures(md: str, ctx: PostCtx) -> str:
    n = 0
    for pat, rep in _LIGATURE_FIXES:
        md, k = pat.subn(rep, md)
        n += k
    if n:
        ctx.log(f"[ligature] repaired {n} broken ligature(s)")
    return md


# =========================================================================== #
# Pass 4 — tables: HTML -> MD pipe table + zotero page link
# =========================================================================== #

class _TableParser(HTMLParser):
    """Parse a simple <table> into rows; detect row/colspan (=> complex)."""

    def __init__(self):
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: Optional[list[str]] = None
        self._cell: Optional[list[str]] = None
        self.complex = False

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []
            for k, v in attrs:
                if k in ("rowspan", "colspan") and v not in (None, "1"):
                    self.complex = True

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _html_table_to_md(html: str) -> Optional[str]:
    p = _TableParser()
    try:
        p.feed(html)
    except Exception:
        return None
    if p.complex or not p.rows:
        return None
    # drop leading all-empty rows (MinerU often emits a blank header row)
    while p.rows and not any(c.strip() for c in p.rows[0]):
        p.rows.pop(0)
    if not p.rows:
        return None
    width = max(len(r) for r in p.rows)
    if width < 2:
        return None
    out = []
    for ri, row in enumerate(p.rows):
        cells = [c.replace("|", "\\|") for c in row] + [""] * (width - len(row))
        out.append("| " + " | ".join(cells) + " |")
        if ri == 0:
            out.append("|" + "|".join([" --- "] * width) + "|")
    return "\n".join(out)


_TABLE_BLOCK = re.compile(r"<table\b.*?</table>", re.S | re.I)
# MinerU sometimes wraps tables:  <html><body><table>...</table></body></html>
_TABLE_WRAP = re.compile(r"<html><body>\s*(<table\b.*?</table>)\s*</body></html>", re.S | re.I)


_TBL_OMIT = "> [!warning] Table omitted (unreliable auto-conversion) — see PDF"
_PLINK_RE = re.compile(r"\[p(\d+)\]\((zotero://[^)]+)\)")

# Literal emitted by earlier versions, which annotated in Chinese. Kept verbatim
# so previously generated Markdown is still recognised; never emitted any more.
_LEGACY_TBL_NOTE = "> [!warning] 复杂表格，建议对照原文"

# legacy annotation (warning note kept above a garbled HTML table) -> omit now
_OLD_NOTE_TBL = re.compile(
    re.escape(_LEGACY_TBL_NOTE) + r"(?P<rest>[^\n]*)\n+<table\b.*?</table>",
    re.S | re.I)


def _omit_line(page: Optional[int], link: str = "") -> str:
    if page is not None:
        return f"{_TBL_OMIT} p{page}" + (f" ⇱ {link}" if link else "")
    return _TBL_OMIT


def _tbl_skip_line(page: Optional[int], link: str = "") -> str:
    """table_mode=none: every table is skipped by design (not a failure)."""
    if page is not None:
        return f"📊 Table skipped — see PDF p{page}" + (f" ⇱ {link}" if link else "")
    return "📊 Table skipped — see PDF"


def pass_tables(md: str, ctx: PostCtx) -> str:
    """
    Convert simple HTML tables to MD pipe tables; keep VLM-refined complex
    tables as HTML; DROP unrefined complex tables entirely, leaving a
    page pointer so readers (human via zotero link, agent via frontmatter
    pdf-path + page number) go to the PDF instead of garbled HTML.
    Idempotent: tables already carrying a ⇱ link below are left untouched.
    """
    md = _TABLE_WRAP.sub(r"\1", md)

    # migrate legacy warning-annotated tables to the omit policy
    def _migrate(m: re.Match) -> str:
        lm = _PLINK_RE.search(m.group("rest"))
        page = int(lm.group(1)) if lm else None
        link = lm.group(0) if lm else ""
        if ctx.table_mode == "none":
            return _tbl_skip_line(page, link)
        return _omit_line(page, link)
    md, n_migrated = _OLD_NOTE_TBL.subn(_migrate, md)
    if n_migrated:
        ctx.log(f"[tables] migrated {n_migrated} legacy warning table(s) to omit")

    matches = list(_TABLE_BLOCK.finditer(md))
    if not matches:
        return md

    table_entries = [e for e in ctx.content_list if e.get("type") == "table"]
    stats = {"md": 0, "omitted": 0, "vlm": 0, "skipped": 0}
    out: list[str] = []
    last = 0

    for i, m in enumerate(matches):
        entry = table_entries[i] if i < len(table_entries) else {}
        page_idx = entry.get("page_idx")
        vlm_refined = bool(entry.get("vlm_refined"))
        link = _page_link(ctx, page_idx)

        # table_mode=none: every table becomes a PDF pointer, including
        # previously kept ones (their trailing ⇱ line is swallowed below)
        if ctx.table_mode == "none":
            page = (page_idx + 1) if page_idx is not None else None
            end = m.end()
            trail = re.match(r"\s*\n⇱[^\n]*", md[end:end + 160])
            if trail:
                tm = _PLINK_RE.search(trail.group(0))
                if tm:  # the old ⇱ link carries the reliable page number
                    page, link = int(tm.group(1)), tm.group(0)
                end += trail.end()
            stats["omitted"] += 1
            out.append(md[last:m.start()])
            out.append(_tbl_skip_line(page, link))
            last = end
            continue

        # already annotated in a previous run? (⇱ link on the next line)
        following = md[m.end():m.end() + 120]
        next_lines = [l for l in following.split("\n") if l.strip()][:1]
        if any(l.startswith("⇱") for l in next_lines):
            stats["skipped"] += 1
            continue

        replacement = None
        if ctx.table_mode == "md":
            as_md = _html_table_to_md(m.group(0))
            if as_md is not None:
                stats["md"] += 1
                replacement = as_md + ("\n\n⇱ " + link if link else "")
        if replacement is None:
            if vlm_refined:
                # VLM-checked table: trusted, keep HTML + page link below
                stats["vlm"] += 1
                replacement = m.group(0) + ("\n\n⇱ " + link if link else "")
            else:
                # unrefined complex table: garbled HTML helps neither human
                # nor agent — drop it, point to the PDF page instead
                stats["omitted"] += 1
                page = (page_idx + 1) if page_idx is not None else None
                replacement = _omit_line(page, link)

        out.append(md[last:m.start()])
        out.append(replacement)
        last = m.end()

    out.append(md[last:])
    if any(stats.values()):
        ctx.log(f"[tables] {stats['md']} -> markdown, {stats['vlm']} vlm-refined, "
                f"{stats['omitted']} omitted, {stats['skipped']} already annotated "
                f"(of {len(matches)})")
    return "".join(out)


# =========================================================================== #
# Pass 5 — figures: drop images (images_mode=none), keep caption + page link
# =========================================================================== #

_IMG_LINE = re.compile(r"^\s*!\[[^\]]*\]\((?P<path>[^)]+)\)\s*$")


def pass_figures(md: str, ctx: PostCtx) -> str:
    if ctx.images_mode == "all":
        return md

    # map image basename -> (caption, page_idx) from content_list
    img_info: dict[str, tuple[str, Optional[int]]] = {}
    for e in ctx.content_list:
        if e.get("type") != "image":
            continue
        p = e.get("img_path") or ""
        cap = " ".join(e.get("image_caption") or []).strip()
        img_info[Path(p).name] = (cap, e.get("page_idx"))

    # table crops: basename -> (caption, page_idx, has_html_body)
    table_info: dict[str, tuple[str, Optional[int], bool]] = {}
    for e in ctx.content_list:
        if e.get("type") != "table":
            continue
        p = e.get("img_path") or ""
        cap = " ".join(e.get("table_caption") or []).strip()
        has_html = bool((e.get("table_body") or "").strip())
        table_info[Path(p).name] = (cap, e.get("page_idx"), has_html)

    out = []
    dropped = 0
    for line in md.split("\n"):
        m = _IMG_LINE.match(line)
        if not m:
            out.append(line)
            continue
        name = Path(m.group("path").replace("\\", "/")).name
        if name in table_info:
            cap, page_idx, has_html = table_info[name]
            if not has_html:
                # table exists only as an image (no parsed HTML in the MD):
                # keep caption + PDF pointer, same policy as skipped tables
                page = (page_idx + 1) if page_idx is not None else None
                pieces = [s for s in (f"*{cap}*" if cap else "",
                                      _tbl_skip_line(page, _page_link(ctx, page_idx))) if s]
                out.append("\n".join(pieces))
            # else: the HTML block is in the MD and pass_tables handled it —
            # the crop image is redundant, drop it silently
            dropped += 1
            continue
        cap, page_idx = img_info.get(name, ("", None))
        link = _page_link(ctx, page_idx)
        pieces = [s for s in (f"*{cap}*" if cap else "", f"🖼 {link}" if link else "") if s]
        if pieces:
            out.append(" ".join(pieces))
        dropped += 1
    if dropped:
        ctx.log(f"[figures] dropped {dropped} image(s), kept captions/links")
    return "\n".join(out)


# =========================================================================== #
# Pass 6 (default OFF) — strip repeated header/footer lines
# =========================================================================== #

def pass_repeated_lines(md: str, ctx: PostCtx) -> str:
    if not ctx.strip_repeated_lines:
        return md
    lines = md.split("\n")
    freq: dict[str, int] = {}
    for l in lines:
        s = l.strip()
        if 8 <= len(s) <= 60 and not s.startswith(("#", "|", "!", "[", ">")):
            freq[s] = freq.get(s, 0) + 1
    kill = {s for s, c in freq.items() if c >= 5}
    if not kill:
        return md
    out = [l for l in lines if l.strip() not in kill]
    ctx.log(f"[repeat] removed {len(lines) - len(out)} repeated line(s) "
            f"({len(kill)} distinct)")
    return "\n".join(out)


# =========================================================================== #
# Pass 7 — references: drop the References section, leave a PDF pointer
# =========================================================================== #
# Reference lists are 10-20% of a paper's tokens and near-useless for reading
# (human or agent). Citation-graph work uses the service-side content_list /
# Semantic Scholar instead. Idempotent: once removed, no heading matches.

_REFS_HEADING = re.compile(
    r"^(#{1,6})\s*\**\s*(?:[0-9]+[.\s]+)?"
    r"(references?|bibliography|literature\s+cited|参考文献)\s*\**\s*$", re.I)
_ZPAGE_LINE = re.compile(r"^\[p(\d+)\]\(zotero://[^)]+\)\s*$")


def pass_references(md: str, ctx: PostCtx) -> str:
    if not ctx.strip_references:
        return md
    lines = md.split("\n")
    start = level = None
    for i, l in enumerate(lines):
        m = _REFS_HEADING.match(l.strip())
        if m:
            start, level = i, len(m.group(1))
            break
    if start is None:
        return md

    end = len(lines)
    for j in range(start + 1, len(lines)):
        hm = re.match(r"^(#{1,6})\s", lines[j])
        if hm and len(hm.group(1)) <= level:
            end = j
            break

    page = None
    for j in range(start, end):
        zm = _ZPAGE_LINE.match(lines[j].strip())
        if zm:
            page = int(zm.group(1))
            break
    if page is None:
        # fallback: locate the heading in content_list layout metadata
        for e in ctx.content_list:
            if e.get("text_level") and _REFS_HEADING.match("# " + (e.get("text") or "").strip()):
                if e.get("page_idx") is not None:
                    page = e["page_idx"] + 1
                break

    stub = "> References omitted"
    if page is not None and ctx.zotero_pdf_uri:
        stub += f" — see PDF p{page} ⇱ [p{page}]({ctx.zotero_pdf_uri}?page={page})"
    elif page is not None:
        stub += f" — see PDF p{page}"

    ctx.log(f"[references] removed {end - start} line(s)"
            + (f" (starts p{page})" if page else ""))
    return "\n".join(lines[:start] + [stub, ""] + lines[end:])


# =========================================================================== #
# Runner
# =========================================================================== #

PASSES = [
    pass_trim_preamble,
    pass_clean_headings,
    pass_heading_levels,
    pass_references,
    pass_hyphenation,
    pass_ligatures,
    pass_tables,
    pass_figures,
    pass_repeated_lines,
]


def run_passes(md: str, ctx: PostCtx) -> str:
    for fn in PASSES:
        try:
            md = fn(md, ctx)
        except Exception as exc:
            ctx.log(f"[postprocess] {fn.__name__} failed: {exc} — skipped")
    return md


def read_pdf_toc(pdf_path: Path) -> list[tuple[int, str, int]]:
    """PDF outline as (level, title, page_1based). Empty list if none."""
    try:
        import pymupdf
        doc = pymupdf.open(str(pdf_path))
        try:
            return [(l, t, p) for l, t, p in doc.get_toc(simple=True)]
        finally:
            doc.close()
    except Exception:
        return []
