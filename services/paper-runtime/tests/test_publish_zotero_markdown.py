"""The Zotero Markdown Publish module and templates with several Publish modules."""

from __future__ import annotations

from pathlib import Path

import pytest

from unizero_runtime.pipeline.migrations import migrate_template_dict
from unizero_runtime.pipeline.steps import (
    MODULE_REGISTRY,
    ConversionContext,
    ConvertOptions,
    PaperMeta,
    _stage_publish_zotero_markdown,
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
ZOTERO = ("publish.zotero-markdown", "publish", True)
CLEANUP = ("transform.content", "process", True)
FRONTMATTER = ("transform.frontmatter", "process", True)


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


def test_builtin_zotero_template_publishes_to_zotero_only(isolated_home: Path) -> None:
    from unizero_runtime import paths
    from unizero_runtime.pipeline.templates import TemplateStore

    store = TemplateStore(
        MODULE_REGISTRY,
        paths.builtin_templates_dir(),
        paths.user_templates_dir(isolated_home),
    )
    assert store.get("paper-to-better-notes") is None
    template = store.get("paper-to-zotero-markdown")
    assert template is not None
    enabled = {item.module for item in template.modules if item.enabled}
    assert "publish.zotero-markdown" in enabled
    assert "transform.frontmatter" in enabled
    assert "publish.markdown-directory" not in {
        item.module for item in template.modules
    }


def test_frontmatter_applies_to_either_markdown_output() -> None:
    vault_off = _template(
        EXTRACT, FRONTMATTER, ("publish.markdown-directory", "publish", False), ZOTERO,
    )
    only_zotero = _template(EXTRACT, FRONTMATTER, ZOTERO)
    only_vault = _template(EXTRACT, FRONTMATTER, VAULT)

    assert MODULE_REGISTRY.inactive_reason(only_zotero, only_zotero.modules[1]) == ""
    assert MODULE_REGISTRY.inactive_reason(only_vault, only_vault.modules[1]) == ""
    assert MODULE_REGISTRY.inactive_reason(vault_off, vault_off.modules[1]) == ""


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
        ("a.zotero", "publish", ()),
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
                {"id": "z", "module": "a.zotero"},
            ],
        })
        WorkflowRunner(template, registry).run(object(), lambda _line: None)
        return list(ran)

    assert run(True) == ["a.extract", "a.feeder", "a.vault", "a.zotero"]
    assert run(False) == ["a.extract", "a.zotero"]


def test_a_template_may_publish_to_the_vault_and_zotero() -> None:
    MODULE_REGISTRY.validate(_template(EXTRACT, CLEANUP, VAULT, ZOTERO))


def test_a_zotero_attachment_alone_is_a_complete_publish() -> None:
    MODULE_REGISTRY.validate(_template(EXTRACT, CLEANUP, ZOTERO))


def test_a_template_without_any_publish_is_rejected() -> None:
    with pytest.raises(ValueError, match="at least one Publish"):
        MODULE_REGISTRY.validate(_template(EXTRACT, CLEANUP))


def test_a_process_module_after_a_publish_is_rejected() -> None:
    with pytest.raises(ValueError, match="final enabled modules"):
        MODULE_REGISTRY.validate(_template(EXTRACT, ZOTERO, CLEANUP))


def test_zotero_stage_writes_a_bundle_with_frontmatter(tmp_path: Path) -> None:
    store = tmp_path / "store"
    context = _context(tmp_path, store)
    context.body = "# Body\n\ntext\n"

    _stage_publish_zotero_markdown(context, {"filename": "{{ title }}.md"})

    assert context.zotero_md == store / "key.zotero" / "T.md"
    assert context.zotero_md.read_text(encoding="utf-8") == (
        "---\nuid: x\n---\n# Body\n\ntext\n"
    )
    assert context.zotero_md_images is None


def test_zotero_stage_falls_back_to_the_extracted_markdown(tmp_path: Path) -> None:
    # Process modules are optional: Extract + Publish must still work.
    context = _context(tmp_path, tmp_path / "store")

    _stage_publish_zotero_markdown(context, {})

    assert context.zotero_md is not None
    assert "# Raw title" in context.zotero_md.read_text(encoding="utf-8")


def test_zotero_stage_copies_referenced_images_beside_the_document(
    tmp_path: Path,
) -> None:
    images = tmp_path / "images"
    images.mkdir()
    (images / "fig1.jpg").write_bytes(b"1")
    (images / "unused.jpg").write_bytes(b"2")
    store = tmp_path / "store"
    context = _context(tmp_path, store)
    # As left by a vault output that ran first.
    context.body = "![Figure 1](attachments/key/fig1.jpg)\n"
    context.frontmatter = ""

    _stage_publish_zotero_markdown(context, {})

    bundle = store / "key.zotero"
    assert context.zotero_md_images == bundle / "attachments"
    assert sorted(path.name for path in context.zotero_md_images.iterdir()) == [
        "fig1.jpg",
    ]
    assert context.zotero_md.read_text(encoding="utf-8") == (
        "![Figure 1](attachments/fig1.jpg)\n"
    )
    # The shared body is the vault output's; this stage does not change it.
    assert context.body == "![Figure 1](attachments/key/fig1.jpg)\n"


def test_zotero_stage_replaces_a_stale_bundle(tmp_path: Path) -> None:
    store = tmp_path / "store"
    stale = store / "key.zotero"
    stale.mkdir(parents=True)
    (stale / "Old title.md").write_text("old", encoding="utf-8")

    context = _context(tmp_path, store)
    _stage_publish_zotero_markdown(context, {})

    assert sorted(path.name for path in stale.iterdir()) == ["T.md"]


def test_zotero_stage_needs_a_store_directory(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="store directory"):
        _stage_publish_zotero_markdown(_context(tmp_path, None), {})


def test_a_stored_note_template_migrates_to_the_zotero_attachment() -> None:
    migrated = migrate_template_dict({
        "schema_version": 1,
        "id": "paper-to-better-notes",
        "name": "Generate Raw note",
        "modules": [
            {"id": "extract", "module": "extract.mineru", "settings": {}},
            {
                "id": "publish-note",
                "module": "publish.zotero-note",
                "settings": {"existing_note": "replace"},
            },
        ],
    })

    publish = migrated["modules"][1]
    assert publish == {
        "id": "publish-note",
        "module": "publish.zotero-markdown",
        "settings": {},
    }
    MODULE_REGISTRY.validate(WorkflowTemplate.from_dict(migrated))
