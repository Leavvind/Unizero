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
