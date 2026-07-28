"""Template validation.

Templates are user-editable YAML executed by the runtime, so validation is the boundary
that keeps a typo in the panel's editor from failing halfway through a conversion --
after MinerU has already spent minutes on the PDF.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from unizero_runtime import paths
from unizero_runtime.pipeline.steps import MODULE_REGISTRY
from unizero_runtime.pipeline.templates import TemplateStore
from unizero_runtime.pipeline.workflow import WorkflowTemplate


def _store(home: Path) -> TemplateStore:
    return TemplateStore(
        MODULE_REGISTRY,
        paths.builtin_templates_dir(),
        paths.user_templates_dir(home),
    )


def test_builtin_templates_are_valid(isolated_home: Path) -> None:
    store = _store(isolated_home)
    listed = store.list()
    assert listed, "no built-in templates were loaded"
    assert any(item["id"] == "paper-to-markdown" for item in listed)
    assert all(item["builtin"] for item in listed)


def test_every_builtin_module_id_is_registered(isolated_home: Path) -> None:
    known = {module["id"] for module in MODULE_REGISTRY.describe()}
    store = _store(isolated_home)
    for template in store.list():
        for item in template["modules"]:
            assert item["module"] in known, (
                f"template {template['id']} references unknown module {item['module']}"
            )


def test_default_conversion_template_publishes_the_note_uid(
    isolated_home: Path,
) -> None:
    store = _store(isolated_home)
    template = store.get("paper-to-markdown")
    assert template is not None
    frontmatter = next(
        item for item in template.modules
        if item.module == "transform.frontmatter"
    )
    rows = {item["key"]: item for item in frontmatter.settings["properties"]}
    assert rows["uid"] == {
        "key": "uid",
        "value": "{{ uid }}",
        "type": "text",
    }


def test_unknown_module_is_rejected(isolated_home: Path) -> None:
    template = WorkflowTemplate.from_dict({
        "id": "broken",
        "name": "broken",
        "modules": [{"module": "does.not.exist"}],
    })
    with pytest.raises(Exception):
        MODULE_REGISTRY.validate(template)


def test_user_template_overrides_builtin_and_is_marked(isolated_home: Path) -> None:
    builtin = yaml.safe_load(
        (paths.builtin_templates_dir() / "paper-to-markdown.yaml").read_text(
            encoding="utf-8",
        ),
    )
    builtin["name"] = "my override"
    (paths.user_templates_dir(isolated_home) / "paper-to-markdown.yaml").write_text(
        yaml.safe_dump(builtin, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    store = _store(isolated_home)
    entry = next(item for item in store.list() if item["id"] == "paper-to-markdown")
    assert entry["name"] == "my override"
    # Still flagged as builtin so the panel can offer "reset to default".
    assert entry["builtin"] is True
    assert entry["customized"] is True


def test_reset_restores_the_builtin(isolated_home: Path) -> None:
    user_path = paths.user_templates_dir(isolated_home) / "paper-to-markdown.yaml"
    builtin_text = (
        paths.builtin_templates_dir() / "paper-to-markdown.yaml"
    ).read_text(encoding="utf-8")
    document = yaml.safe_load(builtin_text)
    document["name"] = "temporary"
    user_path.write_text(
        yaml.safe_dump(document, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    store = _store(isolated_home)
    store.reset("paper-to-markdown")

    assert not user_path.exists()
    entry = next(item for item in store.list() if item["id"] == "paper-to-markdown")
    assert entry["customized"] is False


@pytest.mark.parametrize("template_id", ["../escape", "UPPER", "x", "with space", ""])
def test_unsafe_template_ids_are_refused(isolated_home: Path, template_id: str) -> None:
    """Template ids become filenames, so path traversal here writes outside the home."""
    store = _store(isolated_home)
    with pytest.raises(ValueError):
        store.save_dict({"id": template_id, "name": "x", "modules": []})


# --------------------------------------------------------------------------- #
# Migration of templates saved by an earlier version
# --------------------------------------------------------------------------- #

def _legacy_template() -> dict:
    """A template as it was written before enrich.semantic-scholar and
    transform.references were removed, and before frontmatter became a property
    mapping table."""
    return {
        "schema_version": 1,
        "id": "paper-to-markdown",
        "name": "legacy",
        "version": 1,
        "modules": [
            {"id": "enrich", "module": "enrich.semantic-scholar", "enabled": True,
             "settings": {}},
            {"id": "references", "module": "transform.references", "enabled": True,
             "settings": {"warn_if_empty": True}},
            {"id": "extract", "module": "extract.mineru", "enabled": True,
             "settings": {}},
            {"id": "frontmatter", "module": "transform.frontmatter", "enabled": True,
             "settings": {"tags": ["paper", "unread"], "extra": {"url": "{{ zotero_select }}"}}},
            {"id": "publish", "module": "publish.markdown-directory", "enabled": True,
             "settings": {"destination": "20_Papers"}},
        ],
    }


def _write_user_template(home: Path, document: dict) -> None:
    (paths.user_templates_dir(home) / f"{document['id']}.yaml").write_text(
        yaml.safe_dump(document, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def test_a_template_holding_a_removed_module_still_loads(isolated_home: Path) -> None:
    # Validation raises on the first unknown module, which would otherwise take
    # every other template down with it.
    _write_user_template(isolated_home, _legacy_template())
    store = _store(isolated_home)

    entry = next(item for item in store.list() if item["id"] == "paper-to-markdown")
    modules = [item["module"] for item in entry["modules"]]
    assert "enrich.semantic-scholar" not in modules
    assert "transform.references" not in modules
    assert "extract.mineru" in modules


def test_legacy_frontmatter_settings_become_a_property_table(isolated_home: Path) -> None:
    _write_user_template(isolated_home, _legacy_template())
    store = _store(isolated_home)

    entry = next(item for item in store.list() if item["id"] == "paper-to-markdown")
    settings = next(
        item["settings"] for item in entry["modules"]
        if item["module"] == "transform.frontmatter"
    )
    assert "tags" not in settings and "extra" not in settings
    rows = {item["key"]: item for item in settings["properties"]}
    assert rows["tags"]["value"] == ["paper", "unread"]
    assert rows["url"]["value"] == "{{ zotero_select }}"
    assert rows["uid"]["value"] == "{{ uid }}"
    # the mapped Zotero fields survive the migration unchanged
    assert rows["title"]["value"] == "{{ title }}"


def test_version_one_property_table_gains_uid_once(isolated_home: Path) -> None:
    document = yaml.safe_load(
        (paths.builtin_templates_dir() / "paper-to-markdown.yaml").read_text(
            encoding="utf-8",
        ),
    )
    document["version"] = 1
    frontmatter = next(
        item for item in document["modules"]
        if item["module"] == "transform.frontmatter"
    )
    frontmatter["settings"]["properties"] = [
        row for row in frontmatter["settings"]["properties"]
        if row["key"] != "uid"
    ]
    _write_user_template(isolated_home, document)

    store = _store(isolated_home)
    template = store.get("paper-to-markdown")
    assert template is not None
    loaded_frontmatter = next(
        item for item in template.modules
        if item.module == "transform.frontmatter"
    )
    keys = [row["key"] for row in loaded_frontmatter.settings["properties"]]
    assert template.version == 2
    assert keys.count("uid") == 1
    assert keys.index("uid") == keys.index("citekey") + 1


def test_version_two_template_may_deliberately_omit_uid(isolated_home: Path) -> None:
    document = yaml.safe_load(
        (paths.builtin_templates_dir() / "paper-to-markdown.yaml").read_text(
            encoding="utf-8",
        ),
    )
    frontmatter = next(
        item for item in document["modules"]
        if item["module"] == "transform.frontmatter"
    )
    frontmatter["settings"]["properties"] = [
        row for row in frontmatter["settings"]["properties"]
        if row["key"] != "uid"
    ]
    _write_user_template(isolated_home, document)

    store = _store(isolated_home)
    template = store.get("paper-to-markdown")
    assert template is not None
    loaded_frontmatter = next(
        item for item in template.modules
        if item.module == "transform.frontmatter"
    )
    assert all(
        row["key"] != "uid"
        for row in loaded_frontmatter.settings["properties"]
    )


def test_a_legacy_document_posted_by_an_old_client_is_migrated(isolated_home: Path) -> None:
    store = _store(isolated_home)
    document = store.save_dict(_legacy_template())
    modules = [item["module"] for item in document["template"]["modules"]]
    assert "enrich.semantic-scholar" not in modules
    assert "transform.references" not in modules
