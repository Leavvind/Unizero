"""Library-qualified runtime artifacts must not overwrite another Zotero source."""

from __future__ import annotations

from pathlib import Path

from unizero_runtime.pipeline.steps import (
    ConversionContext,
    ConvertOptions,
    PaperMeta,
    _stage_publish,
)


def test_group_artifact_renames_on_foreign_identity_collision(
    tmp_path: Path,
) -> None:
    papers = tmp_path / "papers"
    papers.mkdir()
    existing = papers / "Same Title.md"
    existing.write_text(
        """---
title: Same Title
unizero-attachment: "1:OTHERPDF"
---
existing body
""",
        encoding="utf-8",
    )

    extracted = tmp_path / "extracted.md"
    extracted.write_text("new body", encoding="utf-8")
    store = tmp_path / "store"
    messages: list[str] = []
    meta = PaperMeta(
        title="Same Title",
        citekey="same2026",
        item_key="ITEM0001",
        attachment_key="ATTACH01",
        library_id=42,
        library_scope="groups/123456",
    )
    context = ConversionContext(
        pdf_path=tmp_path / "paper.pdf",
        work_dir=tmp_path / "work",
        papers_dir=papers,
        output_root=tmp_path,
        citekey="same2026",
        artifact_key="same2026--l42-ATTACH01",
        meta=meta,
        opts=ConvertOptions(),
        log=messages.append,
        store_dir=store,
    )
    context.out_md = extracted
    context.body = "new body"
    context.frontmatter = (
        '---\ntitle: "Same Title"\n'
        'unizero-attachment: "42:ATTACH01"\n---\n'
    )
    context.content_list = [{"page_idx": 0, "text": "Synthetic"}]

    _stage_publish(context, {
        "destination": str(papers),
        "filename": "{{ title }}.md",
        "existing_file": "overwrite",
    })

    assert existing.read_text(encoding="utf-8").endswith("existing body\n")
    assert context.final_md is not None
    assert context.final_md.name == "Same Title — l42-ATTACH01.md"
    assert context.final_md.is_file()
    assert (store / "same2026--l42-ATTACH01.content_list.json").is_file()
