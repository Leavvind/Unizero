"""
s2.py — Semantic Scholar lookup for frontmatter enrichment.

Best-effort, no API key (public rate limits). Lookup order:
DOI (exact) -> title search (top hit, verified by normalized-title match).
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from typing import Optional

_API = "https://api.semanticscholar.org/graph/v1/paper"
_FIELDS = "paperId,title,externalIds,citationCount,year,url"
_NORM = re.compile(r"[^0-9a-z]+")


def _norm(s: str) -> str:
    return _NORM.sub("", (s or "").lower())


def _get(url: str, timeout: float = 8.0, retries: int = 2) -> Optional[dict]:
    import time
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "academic-vault/0.1"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:   # rate-limited: back off
                time.sleep(3 * (attempt + 1))
                continue
            return None
        except Exception:
            return None
    return None


def s2_lookup(doi: str = "", title: str = "") -> Optional[dict]:
    """
    Returns {"s2_id", "s2_url", "citations", "doi"?} or None.
    """
    paper = None
    if doi:
        paper = _get(f"{_API}/DOI:{urllib.parse.quote(doi)}?fields={_FIELDS}")
    if paper is None and title:
        q = urllib.parse.quote(title)
        data = _get(f"{_API}/search?query={q}&fields={_FIELDS}&limit=3")
        for cand in (data or {}).get("data", []):
            if _norm(cand.get("title")) == _norm(title):
                paper = cand
                break
        else:
            # accept close prefix match (subtitle differences)
            cands = (data or {}).get("data", [])
            if cands and (_norm(cands[0].get("title")).startswith(_norm(title)[:40])
                          or _norm(title).startswith(_norm(cands[0].get("title"))[:40])):
                paper = cands[0]

    if not paper or not paper.get("paperId"):
        return None

    out = {
        "s2_id": paper["paperId"],
        "s2_url": paper.get("url") or f"https://www.semanticscholar.org/paper/{paper['paperId']}",
        "citations": paper.get("citationCount"),
    }
    ext = paper.get("externalIds") or {}
    if ext.get("DOI"):
        out["doi"] = ext["DOI"]
    return out
