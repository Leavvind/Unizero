"""Reference extraction from MinerU's content_list.

This runs before the reference section is stripped from the Markdown, and its output is
what the add-on's relations feature reads back. Both MinerU emission shapes are covered
because they come from different document classes, not different MinerU versions:
born-digital papers usually yield `list` blocks, scanned ones yield line-by-line `text`.
"""

from __future__ import annotations

from unizero_runtime.providers.references import extract_references


def test_no_reference_heading_yields_nothing() -> None:
    content = [
        {"type": "text", "text": "Introduction", "text_level": 1, "page_idx": 0},
        {"type": "text", "text": "Some prose.", "page_idx": 0},
    ]
    assert extract_references(content) == []


def test_list_block_entries_are_one_reference_each() -> None:
    content = [
        {"type": "text", "text": "References", "text_level": 1, "page_idx": 8},
        {
            "type": "list",
            "sub_type": "ref_text",
            "list_items": [
                "Smith, J. (2020). A paper. Journal of Things. doi:10.1000/abc123",
                "Doe, A. (2021). Another paper. arXiv:2101.01234",
            ],
            "page_idx": 8,
        },
    ]
    references = extract_references(content)

    assert len(references) == 2
    assert references[0]["identifiers"]["doi"] == "10.1000/abc123"
    assert references[1]["identifiers"]["arxiv"] == "2101.01234"
    # Page is reported 1-based: it is shown to humans, not used as an array index.
    assert references[0]["page"] == 9


def test_numbered_text_lines_are_split_on_the_dominant_marker() -> None:
    content = [
        {"type": "text", "text": "References", "text_level": 1, "page_idx": 3},
        {"type": "text", "text": "[1] Smith, J. A paper. 2020.", "page_idx": 3},
        {"type": "text", "text": "[2] Doe, A. Another paper. 2021.", "page_idx": 3},
        {"type": "text", "text": "[3] Roe, R. A third paper. 2022.", "page_idx": 3},
    ]
    references = extract_references(content)

    assert [item["index"] for item in references] == [1, 2, 3]
    assert "Smith" in references[0]["raw"]


def test_extraction_stops_at_the_next_same_level_heading() -> None:
    content = [
        {"type": "text", "text": "References", "text_level": 1, "page_idx": 5},
        {"type": "list", "sub_type": "ref_text",
         "list_items": ["Smith, J. A paper. 2020."], "page_idx": 5},
        {"type": "text", "text": "Appendix", "text_level": 1, "page_idx": 6},
        {"type": "text", "text": "Not a reference at all.", "page_idx": 6},
    ]
    references = extract_references(content)

    assert len(references) == 1
    assert "Appendix" not in references[0]["raw"]
    assert "Not a reference" not in references[0]["raw"]


def test_headings_inside_the_section_are_skipped() -> None:
    # Running headers repeated on each page of the bibliography must not become entries.
    content = [
        {"type": "text", "text": "References", "text_level": 1, "page_idx": 5},
        {"type": "list", "sub_type": "ref_text",
         "list_items": ["Smith, J. A paper. 2020."], "page_idx": 5},
        {"type": "text", "text": "References", "text_level": 2, "page_idx": 6},
        {"type": "list", "sub_type": "ref_text",
         "list_items": ["Doe, A. Another paper. 2021."], "page_idx": 6},
    ]
    references = extract_references(content)

    assert len(references) == 2
    assert all(item["raw"] != "References" for item in references)
