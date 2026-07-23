"""Extract the reference list from a MinerU content_list.

The heavy lifting (columns, hyphenation, running-header removal) is already done
by MinerU: the reference section is a run of clean text blocks. This module only
has to (1) locate that section in the structured content_list and (2) split it
into individual reference strings — the raw material a citation UI resolves
against Crossref / OpenAlex / LLM downstream.

Design note: this deliberately stops at *clean raw strings* plus any trivially
embedded DOI/arXiv id. Author/title/year resolution belongs to the consumer
(the zotero-reference plugin), not to the conversion pipeline.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

# Matches a "References" / "Bibliography" / "参考文献" heading, with optional
# leading section number and markdown bold stars. Mirrors postprocess._REFS_HEADING
# but works on a bare heading string (content_list text, no leading '#').
_REFS_HEADING = re.compile(
    r"^\**\s*(?:[0-9]+[.\s]+)?"
    r"(references?|bibliography|literature\s+cited|works\s+cited|参考文献)"
    r"\s*\**\s*$",
    re.I,
)

# A line that begins a new reference entry:
#   [1] / [12]      bracketed number
#   1. / 12)        numbered
#   (1)             parenthesised number
#   Bordalo, P.     author surname, capitalised, followed by comma/initial
_MARKER_NUMBERED = re.compile(r"^\s*[\[(]?\d{1,4}[\]).]\s+\S")
_MARKER_AUTHOR = re.compile(r"^\s*[A-ZÀ-ɏ][\w'\-À-ɏ]+,\s")

_DOI = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
_ARXIV = re.compile(r"arXiv[:\s]\s*(\d{4}\.\d{4,5})", re.I)
_TRAILING_DOI_JUNK = re.compile(r"[.,;)\]]+$")


def _is_heading(entry: dict[str, Any]) -> bool:
    return bool(entry.get("text_level"))


def _text_of(entry: dict[str, Any]) -> str:
    return (entry.get("text") or "").strip()


def _find_refs_section(
    content_list: list[dict[str, Any]],
) -> Optional[tuple[int, int, int]]:
    """Return (start_idx, end_idx, page) of the reference section, or None.

    start_idx is the heading entry; the body runs (start_idx, end_idx). end_idx
    is the next heading of the same or higher level (or len(content_list)).
    """
    start = level = None
    for i, entry in enumerate(content_list):
        if _is_heading(entry) and _REFS_HEADING.match(_text_of(entry)):
            start, level = i, int(entry.get("text_level") or 1)
            break
    if start is None:
        return None

    end = len(content_list)
    for j in range(start + 1, len(content_list)):
        entry = content_list[j]
        if _is_heading(entry) and int(entry.get("text_level") or 99) <= level:
            end = j
            break

    page = content_list[start].get("page_idx")
    page = (page + 1) if isinstance(page, int) else 0
    return start, end, page


def _dominant_marker(lines: list[str]) -> Optional[re.Pattern[str]]:
    """Pick the marker pattern that starts the most lines (numbered wins ties)."""
    numbered = sum(1 for l in lines if _MARKER_NUMBERED.match(l))
    author = sum(1 for l in lines if _MARKER_AUTHOR.match(l))
    if numbered == 0 and author == 0:
        return None
    return _MARKER_NUMBERED if numbered >= author else _MARKER_AUTHOR


def _split_entries(lines: list[str], marker: re.Pattern[str]) -> list[str]:
    """Group physical lines into references: a marker line starts a new entry,
    non-marker lines are continuations of the previous entry."""
    entries: list[str] = []
    for line in lines:
        if marker.match(line) or not entries:
            entries.append(line)
        else:
            entries[-1] = entries[-1].rstrip() + " " + line.strip()
    return entries


def _clean(raw: str) -> str:
    raw = re.sub(r"^\s*[\[(]?\d{1,4}[\]).]\s*", "", raw)  # strip leading marker
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw


def _identifiers(raw: str) -> dict[str, str]:
    ids: dict[str, str] = {}
    m = _ARXIV.search(raw)
    if m:
        ids["arxiv"] = m.group(1)
    m = _DOI.search(raw.replace(" ", ""))
    if m and "arxiv" not in ids:
        ids["doi"] = _TRAILING_DOI_JUNK.sub("", m.group(0))
    return ids


def extract_references(
    content_list: list[dict[str, Any]],
    log: LogFn = lambda _m: None,
) -> list[dict[str, Any]]:
    """content_list -> [{index, raw, page, identifiers}] (empty if none found)."""
    section = _find_refs_section(content_list)
    if section is None:
        log("[references] no reference heading found in content_list")
        return []
    start, end, page = section

    # MinerU usually emits references as `list` blocks (sub_type "ref_text"),
    # where each `list_items` entry is already one complete reference. Older or
    # scanned papers may instead put them in `text` blocks, one physical line at
    # a time, needing marker-based splitting. Interspersed running headers /
    # footers / page numbers are other block types and are skipped either way.
    list_entries: list[str] = []
    text_lines: list[str] = []
    for entry in content_list[start + 1:end]:
        if _is_heading(entry):
            continue
        etype = entry.get("type")
        if etype == "list":
            for item in entry.get("list_items") or []:
                item = re.sub(r"\s+", " ", str(item)).strip()
                if item:
                    list_entries.append(item)
        elif etype == "text":
            for line in _text_of(entry).split("\n"):
                line = line.strip()
                if line:
                    text_lines.append(line)

    if list_entries:
        # Structured list items are authoritative; each is one reference.
        raw_entries = list_entries
    elif text_lines:
        marker = _dominant_marker(text_lines)
        raw_entries = _split_entries(text_lines, marker) if marker else text_lines
    else:
        log("[references] reference section had no list/text content")
        return []

    refs: list[dict[str, Any]] = []
    for raw in raw_entries:
        cleaned = _clean(raw)
        if len(cleaned) < 8:  # drop stray fragments
            continue
        refs.append({
            "index": len(refs) + 1,
            "raw": cleaned,
            "page": page,
            "identifiers": _identifiers(raw),
        })
    log(f"[references] extracted {len(refs)} reference(s) (starts p{page})")
    return refs
