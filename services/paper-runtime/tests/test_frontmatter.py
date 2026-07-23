"""Frontmatter projection.

Frontmatter is where Zotero metadata crosses into the user's Markdown vault, so its
escaping has to survive real bibliographic data: colons in titles, quotes, and CJK.
A malformed block silently breaks the vault's own indexing, not the conversion.
"""

from __future__ import annotations

import yaml

from unizero_runtime.pipeline.steps import PaperMeta, build_frontmatter


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


def test_configured_tags_and_extras_are_projected() -> None:
    document = _parsed(
        PaperMeta(title="A Paper"),
        fm_cfg={"tags": ["paper", "unread"], "extra": {"status": "todo"}},
    )
    assert "paper" in document["tags"]
    assert document["status"] == "todo"


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
