"""
annotate.py — inject Zotero annotations (highlights/underlines) into a vault MD.

Ported from C:\\Miner\\zotero_browser.py. The target MD is a *living* note the
user edits, so injection is additive and never regenerates the file:
  - matching is fuzzy: punctuation/whitespace-insensitive (OCR drift tolerant)
  - the matched passage is wrapped in ==...== and each paragraph gets one
    [📖](zotero://...) link back to the exact annotation in the PDF
  - an annotation comment becomes an Obsidian inline footnote ^[💬 ...]
  - dedup is by annotation key, persisted in store/<citekey>.annotations.json
    and additionally recovered from `annotation=KEY` links already in the MD
  - existing ==highlight== regions are respected; overlaps are skipped

The plugin extracts annotations via the Zotero API (in-process, no sqlite
locking) and POSTs them to /annotate; this module does the text surgery.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

_HL_PARA_BREAK = re.compile(r"\n\s*\n")
_HL_WS_CHARS = " \t\n\r　"
_HL_MD_MARKS = "#*_`>-"
_MD_LINK_URL_RE = re.compile(r"\]\(([^)]*)\)")    # URL inside ](...)
_EXISTING_HL_RE = re.compile(r"==(.+?)==", re.S)  # existing ==highlight== spans
_ANN_KEY_IN_MD = re.compile(r"annotation=([A-Z0-9]+)")


@dataclass
class Annotation:
    """One text annotation, as sent by the plugin (reading order = sort_index)."""
    key: str
    attachment_key: str
    text: str
    comment: str = ""
    page_label: str = ""
    sort_index: str = ""

    def link(self) -> str:
        return (
            f"zotero://open-pdf/library/items/{self.attachment_key}"
            f"?page={self.page_label}&annotation={self.key}"
        )


# --------------------------------------------------------------------------- #
# Fuzzy matching helpers
# --------------------------------------------------------------------------- #

def _hl_is_meaningful(ch: str) -> bool:
    """Keep only Han characters and alphanumerics — drop punct/space."""
    if ch.isalnum():
        return True
    cp = ord(ch)
    return (
        0x4E00 <= cp <= 0x9FFF
        or 0x3400 <= cp <= 0x4DBF
        or 0xF900 <= cp <= 0xFAFF
    )


def _hl_normalize(s: str) -> tuple[str, list[int]]:
    """Strip punctuation/whitespace; return (normalized, index map back to s)."""
    buf, idx = [], []
    for i, ch in enumerate(s):
        if _hl_is_meaningful(ch):
            buf.append(ch)
            idx.append(i)
    return "".join(buf), idx


def _hl_normalize_masked(s: str, mask_spans: list[tuple[int, int]]) -> tuple[str, list[int]]:
    """Like _hl_normalize but treats chars inside mask_spans as invisible."""
    masked = bytearray(len(s))
    for ms, me in mask_spans:
        for i in range(max(0, ms), min(len(s), me)):
            masked[i] = 1
    buf, idx = [], []
    for i, ch in enumerate(s):
        if masked[i]:
            continue
        if _hl_is_meaningful(ch):
            buf.append(ch)
            idx.append(i)
    return "".join(buf), idx


def _hl_extend_punct(book: str, start: int, end: int, hl_text: str) -> tuple[int, int]:
    """If the highlight starts/ends with punctuation, absorb matching punct from the book."""
    head: list[str] = []
    for c in hl_text:
        if _hl_is_meaningful(c) or c in _HL_WS_CHARS:
            break
        head.append(c)
    tail: list[str] = []
    for c in reversed(hl_text):
        if _hl_is_meaningful(c) or c in _HL_WS_CHARS:
            break
        tail.append(c)

    k = 0
    while k < len(tail) and end + k < len(book):
        bc = book[end + k]
        if bc in _HL_WS_CHARS or _hl_is_meaningful(bc) or bc in _HL_MD_MARKS:
            break
        k += 1
    end += k

    k = 0
    while k < len(head) and start - k - 1 >= 0:
        bc = book[start - k - 1]
        if bc in _HL_WS_CHARS or _hl_is_meaningful(bc) or bc in _HL_MD_MARKS:
            break
        k += 1
    start -= k
    return start, end


# --------------------------------------------------------------------------- #
# Output assembly
# --------------------------------------------------------------------------- #

def _fmt_comment(comment: str) -> str:
    c = " ".join(comment.split()).replace("]", "］")
    return f" ^[💬 {c}]"


def _inject_build_output(
    text: str, accepted: list[tuple[int, int, str, str]],
) -> str:
    """Wrap accepted (non-overlapping) spans with ==, add comment footnotes,
    and append one [📖] link per paragraph.

    accepted: list of (start, end, link, comment).
    """
    if not accepted:
        return text

    para_bounds: list[tuple[int, int]] = []
    pos = 0
    for chunk in re.split(r"(\n\s*\n)", text):
        end = pos + len(chunk)
        if chunk.strip():
            para_bounds.append((pos, end))
        pos = end

    def para_of(p: int) -> tuple[int, int]:
        for s, e in para_bounds:
            if s <= p < e:
                return (s, e)
        return (0, len(text))

    para_has_link = {
        (s, e): ("zotero://" in text[s:e]) for s, e in para_bounds
    }

    para_link: dict[tuple[int, int], str] = {}
    for s, e, link, _c in accepted:
        pb = para_of(max(s, e - 1))
        if para_has_link.get(pb):
            continue
        para_link.setdefault(pb, link)

    # (position, priority, text). Lower priority applied first under reverse
    # sort, so at equal positions the order is: ==  ^[💬]  [📖].
    inserts: list[tuple[int, int, str]] = []
    for s, e, _link, comment in accepted:
        if not text[s:e].strip():
            continue
        if _HL_PARA_BREAK.search(text[s:e]):
            continue  # cross-paragraph: skip == wrap, link still added
        inserts.append((s, 0, "=="))
        inserts.append((e, 0, "=="))
        if comment.strip():
            inserts.append((e, 1, _fmt_comment(comment)))
    for (ps, pe), link in para_link.items():
        actual_end = pe
        while actual_end > 0 and text[actual_end - 1] in _HL_WS_CHARS:
            actual_end -= 1
        inserts.append((actual_end, 2, f" [📖]({link})"))

    inserts.sort(key=lambda x: (x[0], x[1]), reverse=True)
    out = text
    for p, _prio, frag in inserts:
        out = out[:p] + frag + out[p:]
    return out


def inject_annotations(
    target_text: str,
    annotations: list[Annotation],
    already_injected_keys: set[str],
) -> tuple[str, list[Annotation], list[tuple[Annotation, str]]]:
    """Incrementally inject NEW annotations into a living MD.

    annotations must be in reading order (sort_index). Annotations whose key
    is in already_injected_keys are used only to keep the match cursor aligned.

    Returns (new_text, injected, skipped) where skipped is a list of
    (annotation, reason) for new annotations that couldn't be placed.
    """
    mask = [m.span(1) for m in _MD_LINK_URL_RE.finditer(target_text)]
    norm, idx = _hl_normalize_masked(target_text, mask)

    occupied: list[tuple[int, int]] = [
        (m.start(), m.end()) for m in _EXISTING_HL_RE.finditer(target_text)
    ]

    accepted: list[tuple[int, int, str, str]] = []
    injected: list[Annotation] = []
    skipped: list[tuple[Annotation, str]] = []
    cursor = 0

    for ann in annotations:
        ntext, _ = _hl_normalize(ann.text)
        is_new = ann.key not in already_injected_keys
        if not ntext:
            if is_new:
                skipped.append((ann, "empty after normalize"))
            continue
        npos = norm.find(ntext, cursor)
        if npos < 0:
            npos = norm.find(ntext)  # fall back to a global search
            if npos < 0:
                if is_new:
                    skipped.append((ann, "unmatched"))
                continue
        s = idx[npos]
        e = idx[npos + len(ntext) - 1] + 1
        cursor = npos + len(ntext)
        if not is_new:
            continue  # already injected — only used to advance the cursor
        s, e = _hl_extend_punct(target_text, s, e, ann.text)
        if any(s < oe and os_ < e for os_, oe in occupied):
            skipped.append((ann, "overlap with existing highlight"))
            continue
        accepted.append((s, e, ann.link(), ann.comment))
        injected.append(ann)
        occupied.append((s, e))

    out = _inject_build_output(target_text, accepted)
    return out, injected, skipped


# --------------------------------------------------------------------------- #
# Vault-level entry point
# --------------------------------------------------------------------------- #

_FM = re.compile(r"\A(---\n.*?\n---\n)", re.S)


def _fm_of(md: Path) -> str:
    try:
        head = md.read_text(encoding="utf-8", errors="replace")[:2000]
    except OSError:
        return ""
    m = _FM.match(head)
    return m.group(1) if m else ""


def find_md_by_citekey(papers_dir: Path, citekey: str) -> Optional[Path]:
    """Locate the paper MD whose frontmatter citekey matches (filename = title)."""
    needle = re.compile(rf"^citekey:\s*\"?{re.escape(citekey)}\"?\s*$", re.M)
    for md in papers_dir.glob("*.md"):
        if needle.search(_fm_of(md)):
            return md
    return None


def find_md_by_attachment(papers_dir: Path, attachment_key: str) -> Optional[Path]:
    """Locate the MD converted from this PDF attachment (frontmatter pdf: line)."""
    needle = re.compile(
        rf"^pdf:\s*zotero://open-pdf/library/items/{re.escape(attachment_key)}\s*$", re.M)
    for md in papers_dir.glob("*.md"):
        if needle.search(_fm_of(md)):
            return md
    return None


def citekey_of_md(md: Path) -> str:
    m = re.search(r"^citekey:\s*(.+)$", _fm_of(md), re.M)
    return m.group(1).strip().strip('"') if m else ""


def annotate_md(
    md_path: Path, annotations: list[Annotation], store_dir: Path, citekey: str,
) -> dict:
    """Inject into md_path; persist injected keys in the store. Returns a report."""
    text = md_path.read_text(encoding="utf-8")

    keys_path = store_dir / f"{citekey}.annotations.json"
    known: set[str] = set()
    if keys_path.exists():
        try:
            known = set(json.loads(keys_path.read_text(encoding="utf-8")))
        except Exception:
            pass
    known |= set(_ANN_KEY_IN_MD.findall(text))
    already = sum(1 for a in annotations if a.key in known)

    new_text, injected, skipped = inject_annotations(text, annotations, known)

    if injected:
        md_path.write_text(new_text, encoding="utf-8")
        known |= {a.key for a in injected}
        store_dir.mkdir(parents=True, exist_ok=True)
        keys_path.write_text(json.dumps(sorted(known)), encoding="utf-8")

    return {
        "md_path": str(md_path),
        "total": len(annotations),
        "injected": len(injected),
        "already": already,
        "skipped": [
            {"key": a.key, "page": a.page_label, "reason": r,
             "text": a.text[:60]}
            for a, r in skipped
        ],
    }
