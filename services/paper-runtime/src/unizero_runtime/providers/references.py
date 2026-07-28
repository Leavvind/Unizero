"""Extract structured reference entries from MinerU's content list.

This provider is deliberately local and deterministic. It identifies the
bibliography section, preserves reference order and source page, and records only
identifiers printed in the PDF. Bibliographic matching and citation-count
enrichment belong to the Zotero add-on's scholarly-provider layer.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Optional


LogFn = Callable[[str], None]
ReferenceLine = tuple[str, Optional[int]]

_REFS_HEADING = re.compile(
    r"^\**\s*(?:[0-9]+[.\s]+)?"
    r"(references?|bibliography|literature\s+cited|works\s+cited|参考文献)"
    r"\s*\**\s*$",
    re.I,
)
_MARKER_NUMBERED = re.compile(r"^\s*[\[(]?\d{1,4}[\]).]\s+\S")
_MARKER_AUTHOR = re.compile(r"^\s*[A-ZÀ-ɏ][\w'\-À-ɏ]+,\s")
_DOI = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
_ARXIV = re.compile(
    r"arXiv[:\s]\s*((?:\d{4}\.\d{4,5}|[a-z\-]+/\d{7})(?:v\d+)?)",
    re.I,
)
_TRAILING_DOI_JUNK = re.compile(r"[.,;)\]]+$")


def _is_heading(entry: dict[str, Any]) -> bool:
    return bool(entry.get("text_level"))


def _text_of(entry: dict[str, Any]) -> str:
    return str(entry.get("text") or "").strip()


def _page_of(entry: dict[str, Any]) -> Optional[int]:
    page = entry.get("page_idx")
    return page + 1 if isinstance(page, int) and page >= 0 else None


def _find_refs_section(
    content_list: list[dict[str, Any]],
) -> Optional[tuple[int, int]]:
    """Return the half-open reference-section bounds, including its heading."""
    start = level = None
    for index, entry in enumerate(content_list):
        if _is_heading(entry) and _REFS_HEADING.match(_text_of(entry)):
            start = index
            level = int(entry.get("text_level") or 1)
            break
    if start is None or level is None:
        return None

    end = len(content_list)
    for index in range(start + 1, len(content_list)):
        entry = content_list[index]
        if _is_heading(entry) and int(entry.get("text_level") or 99) <= level:
            end = index
            break
    return start, end


def _dominant_marker(lines: list[ReferenceLine]) -> Optional[re.Pattern[str]]:
    numbered = sum(1 for text, _page in lines if _MARKER_NUMBERED.match(text))
    author = sum(1 for text, _page in lines if _MARKER_AUTHOR.match(text))
    if numbered == 0 and author == 0:
        return None
    return _MARKER_NUMBERED if numbered >= author else _MARKER_AUTHOR


def _split_entries(
    lines: list[ReferenceLine],
    marker: re.Pattern[str],
) -> list[ReferenceLine]:
    """Join continuation lines while retaining the first line's PDF page."""
    entries: list[ReferenceLine] = []
    for text, page in lines:
        if marker.match(text) or not entries:
            entries.append((text, page))
            continue
        previous, first_page = entries[-1]
        entries[-1] = (previous.rstrip() + " " + text.strip(), first_page)
    return entries


def _clean(raw: str) -> str:
    raw = re.sub(r"^\s*[\[(]?\d{1,4}[\]).]\s*", "", raw)
    return re.sub(r"\s+", " ", raw).strip()


def _identifiers(raw: str) -> dict[str, str]:
    identifiers: dict[str, str] = {}
    arxiv = _ARXIV.search(raw)
    if arxiv:
        identifiers["arxiv"] = arxiv.group(1)
    doi = _DOI.search(raw.replace(" ", ""))
    if doi:
        identifiers["doi"] = _TRAILING_DOI_JUNK.sub("", doi.group(0))
    return identifiers


def extract_references(
    content_list: list[dict[str, Any]],
    log: LogFn = lambda _message: None,
) -> list[dict[str, Any]]:
    """Return ordered ``index/raw/page/identifiers`` reference records."""
    section = _find_refs_section(content_list)
    if section is None:
        log("[references] no reference heading found in content_list")
        return []
    start, end = section

    list_entries: list[ReferenceLine] = []
    text_lines: list[ReferenceLine] = []
    for entry in content_list[start + 1:end]:
        if _is_heading(entry):
            continue
        page = _page_of(entry)
        if entry.get("type") == "list":
            for item in entry.get("list_items") or []:
                text = re.sub(r"\s+", " ", str(item)).strip()
                if text:
                    list_entries.append((text, page))
        elif entry.get("type") == "text":
            for line in _text_of(entry).splitlines():
                text = line.strip()
                if text:
                    text_lines.append((text, page))

    if list_entries:
        raw_entries = list_entries
    elif text_lines:
        marker = _dominant_marker(text_lines)
        raw_entries = _split_entries(text_lines, marker) if marker else text_lines
    else:
        log("[references] reference section had no list/text content")
        return []

    references: list[dict[str, Any]] = []
    for raw, page in raw_entries:
        cleaned = _clean(raw)
        if len(cleaned) < 8:
            continue
        reference: dict[str, Any] = {
            "index": len(references) + 1,
            "raw": cleaned,
            "identifiers": _identifiers(raw),
        }
        if page is not None:
            reference["page"] = page
        references.append(reference)

    first_page = references[0].get("page") if references else None
    page_note = f" (starts p{first_page})" if first_page is not None else ""
    log(f"[references] extracted {len(references)} reference(s){page_note}")
    return references
