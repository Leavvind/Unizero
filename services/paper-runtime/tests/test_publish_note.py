"""The Zotero-note Publish module and templates with several Publish modules."""

from __future__ import annotations

from pathlib import Path

import pytest

from unizero_runtime.pipeline.steps import (
    MODULE_REGISTRY,
    ConversionContext,
    ConvertOptions,
    PaperMeta,
    _stage_publish_note,
)
from unizero_runtime.pipeline.workflow import WorkflowTemplate


def _template(*modules: tuple[str, str, bool]) -> WorkflowTemplate:
    return WorkflowTemplate.from_dict({
        "id": "t",
        "name": "t",
        "modules": [
            {"id": f"m{index}", "module": module, "enabled": enabled}
            for index, (module, _role, enabled) in enumerate(modules)
        ],
    })


EXTRACT = ("extract.mineru", "extract", True)
VAULT = ("publish.markdown-directory", "publish", True)
NOTE = ("publish.zotero-note", "publish", True)
CLEANUP = ("transform.markdown-cleanup", "process", True)


def _context(tmp_path: Path, store: Path | None) -> ConversionContext:
    raw = tmp_path / "out.md"
    raw.write_text("# Raw title\n\nbody\n", encoding="utf-8")
    return ConversionContext(
        pdf_path=tmp_path / "p.pdf",
        work_dir=tmp_path,
        papers_dir=tmp_path,
        output_root=None,
        citekey="key",
        artifact_key="key",
        meta=PaperMeta(title="T"),
        opts=ConvertOptions(),
        log=lambda _line: None,
        store_dir=store,
        out_md=raw,
        frontmatter="---\nuid: x\n---\n",
    )


def test_builtin_note_template_is_note_only(isolated_home: Path) -> None:
    from unizero_runtime import paths
    from unizero_runtime.pipeline.templates import TemplateStore

    store = TemplateStore(
        MODULE_REGISTRY,
        paths.builtin_templates_dir(),
        paths.user_templates_dir(isolated_home),
    )
    template = store.get("paper-to-better-notes")
    assert template is not None
    enabled = {item.module for item in template.modules if item.enabled}
    assert "publish.zotero-note" in enabled
    assert "publish.markdown-directory" not in enabled
    assert "transform.frontmatter" not in enabled


def test_a_template_may_publish_to_the_vault_and_a_note() -> None:
    MODULE_REGISTRY.validate(_template(EXTRACT, CLEANUP, VAULT, NOTE))


def test_a_note_alone_is_a_complete_publish() -> None:
    MODULE_REGISTRY.validate(_template(EXTRACT, CLEANUP, NOTE))


def test_a_template_without_any_publish_is_rejected() -> None:
    with pytest.raises(ValueError, match="at least one Publish"):
        MODULE_REGISTRY.validate(_template(EXTRACT, CLEANUP))


def test_a_process_module_after_a_publish_is_rejected() -> None:
    with pytest.raises(ValueError, match="final enabled modules"):
        MODULE_REGISTRY.validate(_template(EXTRACT, NOTE, CLEANUP))


def test_note_stage_leaves_the_body_without_frontmatter(tmp_path: Path) -> None:
    store = tmp_path / "store"
    context = _context(tmp_path, store)
    context.body = "# Body\n\ntext\n"

    _stage_publish_note(context, {"existing_note": "replace"})

    assert context.note_md == store / "key.note.md"
    assert context.note_md.read_text(encoding="utf-8") == "# Body\n\ntext\n"
    assert context.note_existing == "replace"


def test_note_stage_falls_back_to_the_extracted_markdown(tmp_path: Path) -> None:
    # Process modules are optional: Extract + Publish must still work.
    context = _context(tmp_path, tmp_path / "store")

    _stage_publish_note(context, {})

    assert context.note_md.read_text(encoding="utf-8").startswith("# Raw title")
    assert context.note_existing == "skip"


def test_note_stage_needs_a_store_directory(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="store directory"):
        _stage_publish_note(_context(tmp_path, None), {})
