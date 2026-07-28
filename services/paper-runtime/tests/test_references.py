"""Structured reference extraction from MinerU content lists."""

from __future__ import annotations

from unizero_runtime.providers.references import extract_references


def test_no_reference_heading_yields_nothing() -> None:
    content = [
        {"type": "text", "text": "Introduction", "text_level": 1, "page_idx": 0},
        {"type": "text", "text": "Some prose.", "page_idx": 0},
    ]
    assert extract_references(content) == []


def test_list_entries_preserve_identifiers_order_and_each_block_page() -> None:
    content = [
        {"type": "text", "text": "References", "text_level": 1, "page_idx": 8},
        {
            "type": "list",
            "sub_type": "ref_text",
            "list_items": [
                "Smith, J. (2020). A paper. doi:10.1000/abc123.",
                "Doe, A. (2021). Another paper. arXiv:2101.01234v2",
            ],
            "page_idx": 8,
        },
        {
            "type": "list",
            "sub_type": "ref_text",
            "list_items": ["Roe, R. (2022). A later paper."],
            "page_idx": 9,
        },
    ]

    references = extract_references(content)

    assert [reference["index"] for reference in references] == [1, 2, 3]
    assert [reference["page"] for reference in references] == [9, 9, 10]
    assert references[0]["identifiers"]["doi"] == "10.1000/abc123"
    assert references[1]["identifiers"]["arxiv"] == "2101.01234v2"


def test_numbered_text_continuations_keep_the_entry_start_page() -> None:
    content = [
        {"type": "text", "text": "References", "text_level": 1, "page_idx": 3},
        {"type": "text", "text": "[1] Smith, J. A paper.", "page_idx": 3},
        {"type": "text", "text": "Journal of Things 1, 2-3.", "page_idx": 4},
        {"type": "text", "text": "[2] Doe, A. Another paper. 2021.", "page_idx": 4},
    ]

    references = extract_references(content)

    assert len(references) == 2
    assert references[0]["page"] == 4
    assert "Journal of Things" in references[0]["raw"]
    assert references[1]["page"] == 5


def test_extraction_stops_at_the_next_same_level_heading() -> None:
    content = [
        {"type": "text", "text": "Bibliography", "text_level": 1, "page_idx": 5},
        {
            "type": "list",
            "sub_type": "ref_text",
            "list_items": ["Smith, J. A paper. 2020."],
            "page_idx": 5,
        },
        {"type": "text", "text": "Appendix", "text_level": 1, "page_idx": 6},
        {"type": "text", "text": "Not a reference at all.", "page_idx": 6},
    ]

    references = extract_references(content)

    assert len(references) == 1
    assert "Appendix" not in references[0]["raw"]


def test_repeated_lower_level_reference_heading_is_skipped() -> None:
    content = [
        {"type": "text", "text": "References", "text_level": 1, "page_idx": 5},
        {
            "type": "list",
            "sub_type": "ref_text",
            "list_items": ["Smith, J. A paper. 2020."],
            "page_idx": 5,
        },
        {"type": "text", "text": "References", "text_level": 2, "page_idx": 6},
        {
            "type": "list",
            "sub_type": "ref_text",
            "list_items": ["Doe, A. Another paper. 2021."],
            "page_idx": 6,
        },
    ]

    references = extract_references(content)

    assert len(references) == 2
    assert all(reference["raw"] != "References" for reference in references)
