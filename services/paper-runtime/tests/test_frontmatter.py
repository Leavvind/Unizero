"""Frontmatter projection.

Frontmatter is where Zotero metadata crosses into the user's Markdown vault, so its
escaping has to survive real bibliographic data: colons in titles, quotes, and CJK.
A malformed block silently breaks the vault's own indexing, not the conversion.

The property mapping table is the user-facing half: every field is a row the user
can rename, retype, reorder, or delete, so the tests cover the projection rules
rather than one fixed field list.
"""

from __future__ import annotations

import yaml

from unizero_runtime.pipeline.steps import (
    DEFAULT_FRONTMATTER_PROPERTIES,
    PaperMeta,
    build_frontmatter,
)


def _parsed(meta: PaperMeta, **kwargs) -> dict:
    text = build_frontmatter(meta, **kwargs)
    assert text.startswith("---\n")
    body = text.split("---", 2)[1]
    return yaml.safe_load(body)


def test_minimal_metadata_produces_parseable_yaml() -> None:
    document = _parsed(PaperMeta(title="A Simple Paper"))
    assert document["title"] == "A Simple Paper"


def test_title_with_a_colon_stays_valid_yaml() -> None:
    # The single most common way naive frontmatter generation breaks.
    document = _parsed(PaperMeta(title="Attention: All You Need"))
    assert document["title"] == "Attention: All You Need"


def test_cjk_and_quotes_round_trip() -> None:
    document = _parsed(PaperMeta(
        title='关于"注意力"机制的研究',
        authors=["张三", "O'Brien, Patrick"],
    ))
    assert document["title"] == '关于"注意力"机制的研究'
    assert "张三" in document["authors"]


def test_citekey_becomes_an_alias() -> None:
    # The file is named after the title, so [[citekey]] links only resolve via an alias.
    document = _parsed(PaperMeta(title="A Paper", citekey="smith2020"))
    assert document["aliases"] == ["smith2020"]


def test_default_tag_is_applied() -> None:
    document = _parsed(PaperMeta(title="A Paper"))
    assert document["tags"] == ["paper"]


def test_absent_fields_are_omitted_rather_than_emitted_empty() -> None:
    document = _parsed(PaperMeta(title="A Paper"))
    # An empty `doi:` key is worse than no key: it looks like a recorded absence.
    assert "doi" not in document
    assert "authors" not in document


def test_group_library_identity_and_links_are_projected() -> None:
    document = _parsed(PaperMeta(
        title="A Group Paper",
        item_key="ITEM0001",
        attachment_key="ATTACH01",
        library_id=42,
        library_scope="groups/123456",
    ))

    assert document["unizero-item"] == "42:ITEM0001"
    assert document["unizero-attachment"] == "42:ATTACH01"
    assert document["zotero"] == "zotero://select/groups/123456/items/ITEM0001"
    assert document["pdf"] == "zotero://open-pdf/groups/123456/items/ATTACH01"


def test_semantic_scholar_fields_come_from_the_item_not_a_lookup() -> None:
    document = _parsed(PaperMeta(
        title="A Paper",
        s2_url="https://www.semanticscholar.org/paper/abc123",
        s2_citations=1408,
    ))
    assert document["semantic-scholar"] == "https://www.semanticscholar.org/paper/abc123"
    assert document["citations"] == 1408


# --------------------------------------------------------------------------- #
# The property mapping table
# --------------------------------------------------------------------------- #

def test_a_property_can_be_renamed_without_changing_its_source() -> None:
    # An Obsidian vault whose convention is `author:` must not be forced to
    # rename every existing note.
    document = _parsed(
        PaperMeta(title="A Paper", authors=["Ada Lovelace"]),
        properties=[{"key": "author", "value": "{{ authors }}", "type": "list"}],
    )
    assert document == {"author": ["Ada Lovelace"]}


def test_a_sole_placeholder_keeps_the_variable_shape() -> None:
    document = _parsed(
        PaperMeta(title="A Paper", authors=["Ada Lovelace", "Grace Hopper"]),
        properties=[{"key": "authors", "value": "{{ authors }}", "type": "list"}],
    )
    assert document["authors"] == ["Ada Lovelace", "Grace Hopper"]


def test_mixed_text_interpolates_every_placeholder() -> None:
    document = _parsed(
        PaperMeta(title="A Paper", year="2020", publication="NeurIPS"),
        properties=[{"key": "source", "value": "{{ year }} · {{ publication }}"}],
    )
    assert document["source"] == "2020 · NeurIPS"


def test_a_literal_value_needs_no_placeholder() -> None:
    document = _parsed(
        PaperMeta(title="A Paper"),
        properties=[
            {"key": "status", "value": "unread"},
            {"key": "tags", "value": ["paper", "to-read"], "type": "list"},
            {"key": "starred", "value": "false", "type": "checkbox"},
        ],
    )
    assert document["status"] == "unread"
    assert document["tags"] == ["paper", "to-read"]
    assert document["starred"] is False


def test_number_type_emits_an_unquoted_scalar() -> None:
    document = _parsed(
        PaperMeta(title="A Paper", year="2020"),
        properties=[{"key": "year", "value": "{{ year }}", "type": "number"}],
    )
    assert document["year"] == 2020


def test_omit_if_empty_can_be_turned_off_to_record_an_absence() -> None:
    document = _parsed(
        PaperMeta(title="A Paper"),
        properties=[{"key": "doi", "value": "{{ doi }}", "omit_if_empty": False}],
    )
    assert document["doi"] == ""


def test_a_repeated_key_is_written_once() -> None:
    # YAML parsers silently keep only one of a duplicated key; deciding here
    # keeps the file and the mapping table agreeing on which one.
    document = _parsed(
        PaperMeta(title="A Paper"),
        properties=[
            {"key": "status", "value": "first"},
            {"key": "status", "value": "second"},
        ],
    )
    assert document["status"] == "first"


def test_an_unknown_placeholder_is_left_alone_rather_than_blanked() -> None:
    document = _parsed(
        PaperMeta(title="A Paper"),
        properties=[{"key": "note", "value": "{{ nonexistent }}"}],
    )
    assert document["note"] == "{{ nonexistent }}"


def test_an_empty_table_produces_no_frontmatter_block_at_all() -> None:
    assert build_frontmatter(PaperMeta(title="A Paper"), properties=[]) == ""


def test_the_default_table_covers_every_documented_variable() -> None:
    keys = {item["key"] for item in DEFAULT_FRONTMATTER_PROPERTIES}
    assert "unizero-attachment" in keys  # Publish's overwrite-ownership marker
    assert len(keys) == len(DEFAULT_FRONTMATTER_PROPERTIES)
