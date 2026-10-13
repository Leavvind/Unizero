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
    # The list holds only what runs; the vault output and Frontmatter are added by
    # the user when wanted.
    modules = {item.module for item in template.modules}
    assert "publish.markdown-directory" not in modules
    assert "transform.frontmatter" not in modules
    assert all(item.enabled for item in template.modules)


def test_frontmatter_applies_once_the_vault_output_is_enabled() -> None:
    frontmatter = ("transform.frontmatter", "process", True)
    without_vault = _template(EXTRACT, frontmatter, NOTE)
    with_vault = _template(EXTRACT, frontmatter, NOTE, VAULT)
    disabled_vault = _template(
        EXTRACT, frontmatter, NOTE, ("publish.markdown-directory", "publish", False),
    )

    assert "Markdown directory" in MODULE_REGISTRY.inactive_reason(
        without_vault, without_vault.modules[1],
    )
    assert MODULE_REGISTRY.inactive_reason(with_vault, with_vault.modules[1]) == ""
    assert MODULE_REGISTRY.inactive_reason(
        disabled_vault, disabled_vault.modules[1],
    )


def test_the_runner_skips_a_module_whose_output_is_off() -> None:
    from unizero_runtime.pipeline.workflow import (
        ModuleRegistry,
        WorkflowModule,
        WorkflowRunner,
    )

    ran: list[str] = []
    registry: ModuleRegistry = ModuleRegistry()
    for module_id, role, requires in (
        ("a.extract", "extract", ()),
        ("a.feeder", "process", ("a.vault",)),
        ("a.vault", "publish", ()),
        ("a.note", "publish", ()),
    ):
        registry.register(WorkflowModule(
            id=module_id,
            name=module_id,
            role=role,
            handler=lambda _ctx, _settings, name=module_id: ran.append(name),
            requires_any=requires,
        ))

    def run(vault_enabled: bool) -> list[str]:
        ran.clear()
        template = WorkflowTemplate.from_dict({
            "id": "t",
            "name": "t",
            "modules": [
                {"id": "x", "module": "a.extract"},
                {"id": "f", "module": "a.feeder"},
                {"id": "v", "module": "a.vault", "enabled": vault_enabled},
                {"id": "n", "module": "a.note"},
            ],
        })
        WorkflowRunner(template, registry).run(object(), lambda _line: None)
        return list(ran)

    assert run(True) == ["a.extract", "a.feeder", "a.vault", "a.note"]
    assert run(False) == ["a.extract", "a.note"]


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
