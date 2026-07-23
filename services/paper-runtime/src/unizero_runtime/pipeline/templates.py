"""YAML-backed conversion template storage."""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Any

import yaml

from .migrations import migrate_template_dict
from .workflow import ModuleRegistry, WorkflowTemplate


_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")


class TemplateStore:
    """Load built-ins and user overrides, one YAML document per template."""

    def __init__(
        self,
        registry: ModuleRegistry,
        builtin_dir: Path,
        user_dir: Path,
    ) -> None:
        self.registry = registry
        self.builtin_dir = builtin_dir
        self.user_dir = user_dir
        self._lock = threading.RLock()
        self._templates: dict[str, WorkflowTemplate] = {}
        self.reload()

    @staticmethod
    def _read(path: Path) -> WorkflowTemplate:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"template YAML must contain an object: {path}")
        return WorkflowTemplate.from_dict(migrate_template_dict(value))

    def reload(self) -> None:
        with self._lock:
            loaded: dict[str, WorkflowTemplate] = {}
            builtin_ids: set[str] = set()
            for path in sorted(self.builtin_dir.glob("*.yaml")):
                template = self._read(path)
                self.registry.validate(template)
                template.builtin = True
                loaded[template.id] = template
                builtin_ids.add(template.id)
            if self.user_dir.exists():
                for path in sorted(self.user_dir.glob("*.yaml")):
                    template = self._read(path)
                    self.registry.validate(template)
                    template.builtin = template.id in builtin_ids
                    template.customized = template.id in builtin_ids
                    loaded[template.id] = template
            self._templates = loaded

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [template.describe() for template in self._templates.values()]

    def get(self, template_id: str) -> WorkflowTemplate | None:
        with self._lock:
            return self._templates.get(template_id)

    def document(self, template_id: str) -> dict[str, Any] | None:
        with self._lock:
            template = self._templates.get(template_id)
            if template is None:
                return None
            return {
                "template": template.to_dict(),
                "yaml": yaml.safe_dump(
                    template.to_dict(),
                    allow_unicode=True,
                    sort_keys=False,
                    width=100,
                ),
                "builtin": template.builtin,
                "customized": template.customized,
            }

    def save_dict(self, value: dict[str, Any]) -> dict[str, Any]:
        # A client may still be posting a document it loaded before an upgrade.
        template = WorkflowTemplate.from_dict(migrate_template_dict(value))
        if not _SAFE_ID.fullmatch(template.id):
            raise ValueError(
                "template id must use lowercase letters, numbers, '.', '_' or '-'",
            )
        self.registry.validate(template)
        self.user_dir.mkdir(parents=True, exist_ok=True)
        path = self.user_dir / f"{template.id}.yaml"
        path.write_text(
            yaml.safe_dump(
                template.to_dict(),
                allow_unicode=True,
                sort_keys=False,
                width=100,
            ),
            encoding="utf-8",
        )
        self.reload()
        document = self.document(template.id)
        assert document is not None
        return document

    def save_yaml(
        self,
        text: str,
        expected_id: str | None = None,
    ) -> dict[str, Any]:
        value = yaml.safe_load(text)
        if not isinstance(value, dict):
            raise ValueError("template YAML must contain an object")
        if expected_id is not None and str(value.get("id") or "") != expected_id:
            raise ValueError("path template id does not match YAML id")
        return self.save_dict(value)

    def reset(self, template_id: str) -> dict[str, Any] | None:
        if not _SAFE_ID.fullmatch(template_id):
            raise ValueError("invalid template id")
        path = self.user_dir / f"{template_id}.yaml"
        if path.exists():
            path.unlink()
        self.reload()
        return self.document(template_id)
