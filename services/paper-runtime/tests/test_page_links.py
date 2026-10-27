"""Page-link injection against content lists shaped like MinerU's output."""

import json
import re

from unizero_runtime.pipeline.steps import inject_zotero_page_links

URI = "zotero://open-pdf/library/items/ABC"


def _inject(tmp_path, markdown: str, content: list[dict]) -> tuple[tuple[int, int], dict[int, int]]:
    md = tmp_path / "paper.md"
    md.write_text(markdown, encoding="utf-8")
    cl = tmp_path / "paper_content_list.json"
    cl.write_text(json.dumps(content), encoding="utf-8")
    result = inject_zotero_page_links(md, cl, URI)
    lines = md.read_text(encoding="utf-8").split("\n")
    pages = {
        int(m.group(1)): index
        for index, line in enumerate(lines)
        if (m := re.match(r"^\[p(\d+)\]\(zotero://", line))
    }
    return result, pages


def _paragraph(page: int) -> str:
    return f"Body paragraph that opens page {page} of the paper."


def test_running_headers_do_not_anchor_pages(tmp_path):
    # MinerU's VLM backends put each page's running header first in the content
    # list but leave it out of the Markdown.
    content, body = [], ["# Title", ""]
    for page in range(5):
        content.append({"type": "header", "text": "Author: Running Title Journal 2022", "page_idx": page})
        content.append({"type": "page_number", "text": f"{page + 100}", "page_idx": page})
        content.append({"type": "text", "text": _paragraph(page + 1), "page_idx": page})
        body += [_paragraph(page + 1), ""]
    result, pages = _inject(tmp_path, "\n".join(body), content)
    assert result == (5, 5)
    assert sorted(pages) == [1, 2, 3, 4, 5]
    assert list(pages.values()) == sorted(pages.values())


def test_page_falls_back_to_a_later_block(tmp_path):
    content = [
        {"type": "text", "text": _paragraph(1), "page_idx": 0},
        {"type": "text", "text": "Garbled OCR line nowhere in the Markdown", "page_idx": 1},
        {"type": "text", "text": _paragraph(2), "page_idx": 1},
    ]
    result, pages = _inject(tmp_path, f"{_paragraph(1)}\n\n{_paragraph(2)}\n", content)
    assert result == (2, 2)
    assert set(pages) == {1, 2}


def test_rejected_far_match_does_not_skip_later_pages(tmp_path):
    # Page 2's only anchor recurs near the end of the document (in a note far
    # past any plausible page length); pages 3 and 4 must still be linked.
    filler = ["filler"] * 700
    body = [_paragraph(1), *filler[:5], _paragraph(3), *filler[:5], _paragraph(4),
            *filler, "Repeated phrase that page two starts with.", ""]
    content = [
        {"type": "text", "text": _paragraph(1), "page_idx": 0},
        {"type": "text", "text": "Repeated phrase that page two starts with.", "page_idx": 1},
        {"type": "text", "text": _paragraph(3), "page_idx": 2},
        {"type": "text", "text": _paragraph(4), "page_idx": 3},
    ]
    result, pages = _inject(tmp_path, "\n".join(body), content)
    assert result == (4, 3)
    assert set(pages) == {1, 3, 4}


def test_first_page_far_match_does_not_skip_later_pages(tmp_path):
    # Page 1's only anchor is missing from the top of the Markdown but recurs
    # far down; matching it there would leave every later page out of reach.
    filler = ["filler"] * 700
    body = [_paragraph(2), *filler[:5], _paragraph(3), *filler,
            "Repeated phrase that page one starts with.", ""]
    content = [
        {"type": "text", "text": "Repeated phrase that page one starts with.", "page_idx": 0},
        {"type": "text", "text": _paragraph(2), "page_idx": 1},
        {"type": "text", "text": _paragraph(3), "page_idx": 2},
    ]
    result, pages = _inject(tmp_path, "\n".join(body), content)
    assert result == (3, 2)
    assert set(pages) == {2, 3}


def test_window_grows_with_skipped_pages(tmp_path):
    # Page 2 cannot be found, so page 3 may lie up to two pages' worth of
    # lines past page 1.
    body = [_paragraph(1), *(["filler"] * 450), _paragraph(3), ""]
    content = [
        {"type": "text", "text": _paragraph(1), "page_idx": 0},
        {"type": "text", "text": "Absent anchor text for page two", "page_idx": 1},
        {"type": "text", "text": _paragraph(3), "page_idx": 2},
    ]
    result, pages = _inject(tmp_path, "\n".join(body), content)
    assert result == (3, 2)
    assert set(pages) == {1, 3}


def test_window_past_end_of_file_does_not_raise(tmp_path):
    content = [
        {"type": "text", "text": _paragraph(1), "page_idx": 0},
        {"type": "text", "text": "Absent anchor text for page two", "page_idx": 1},
    ]
    result, pages = _inject(tmp_path, f"{_paragraph(1)}\n", content)
    assert result == (2, 1)
    assert set(pages) == {1}


def test_content_list_without_types_still_anchors(tmp_path):
    content = [{"text": _paragraph(1), "page_idx": 0}]
    result, pages = _inject(tmp_path, f"{_paragraph(1)}\n", content)
    assert result == (1, 1)
    assert set(pages) == {1}
