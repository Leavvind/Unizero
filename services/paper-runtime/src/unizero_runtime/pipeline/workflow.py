"""Declarative, module-based workflow primitives for ZoMiner templates."""

from __future__ import annotations

import copy
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Generic, TypeVar


ContextT = TypeVar("ContextT")
ModuleHandler = Callable[[ContextT, dict[str, Any]], None]


@dataclass(frozen=True)
class WorkflowModule(Generic[ContextT]):
    """A reusable capability exposed to templates and the GUI editor."""

    id: str
    name: str
    role: str
    handler: ModuleHandler[ContextT]
    description: str = ""
    settings_schema: dict[str, Any] = field(default_factory=dict)
    defaults: dict[str, Any] = field(default_factory=dict)

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "description": self.description,
            "settings_schema": copy.deepcopy(self.settings_schema),
            "defaults": copy.deepcopy(self.defaults),
        }


@dataclass
class TemplateModule:
    """One configured module instance in a template."""

    id: str
    module: str
    enabled: bool = True
    settings: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "TemplateModule":
        return cls(
            id=str(value.get("id") or "").strip(),
            module=str(value.get("module") or "").strip(),
            enabled=bool(value.get("enabled", True)),
            settings=copy.deepcopy(value.get("settings") or {}),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "module": self.module,
            "enabled": self.enabled,
            "settings": copy.deepcopy(self.settings),
        }


@dataclass
class WorkflowTemplate:
    """A complete conversion template represented by one YAML document."""

    schema_version: int
    id: str
    name: str
    version: int
    modules: list[TemplateModule]
    description: str = ""
    builtin: bool = False
    customized: bool = False

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "WorkflowTemplate":
        return cls(
            schema_version=int(value.get("schema_version", 1)),
            id=str(value.get("id") or "").strip(),
            name=str(value.get("name") or value.get("id") or "").strip(),
            version=int(value.get("version", 1)),
            description=str(value.get("description") or "").strip(),
            modules=[
                TemplateModule.from_dict(item)
                for item in value.get("modules", [])
                if isinstance(item, dict)
            ],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "modules": [module.to_dict() for module in self.modules],
        }

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "builtin": self.builtin,
            "customized": self.customized,
            # `stages` remains for clients of the former workflow endpoint.
            "stages": [item.id for item in self.modules if item.enabled],
            "modules": [item.to_dict() for item in self.modules],
        }


def _merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


class ModuleRegistry(Generic[ContextT]):
    """Registry, setting resolver, and structural template validator."""

    def __init__(self) -> None:
        self._modules: dict[str, WorkflowModule[ContextT]] = {}

    def register(self, module: WorkflowModule[ContextT]) -> None:
        if module.id in self._modules:
            raise ValueError(f"module '{module.id}' is already registered")
        self._modules[module.id] = module

    def get(self, module_id: str) -> WorkflowModule[ContextT] | None:
        return self._modules.get(module_id)

    def describe(self) -> list[dict[str, Any]]:
        return [module.describe() for module in self._modules.values()]

    def settings_for(self, item: TemplateModule) -> dict[str, Any]:
        module = self.get(item.module)
        if module is None:
            raise ValueError(f"unknown module '{item.module}'")
        return _merge(module.defaults, item.settings)

    @staticmethod
    def _validate_settings(
        value: Any,
        schema: dict[str, Any],
        path: str,
        errors: list[str],
    ) -> None:
        expected = schema.get("type")
        valid_type = {
            "object": isinstance(value, dict),
            "array": isinstance(value, list),
            "string": isinstance(value, str),
            "boolean": isinstance(value, bool),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        }.get(expected, True)
        if not valid_type:
            errors.append(f"{path} must be {expected}")
            return
        if "enum" in schema and value not in schema["enum"]:
            errors.append(f"{path} must be one of {schema['enum']}")
        if expected in ("integer", "number") and "minimum" in schema:
            if value < schema["minimum"]:
                errors.append(f"{path} must be >= {schema['minimum']}")
        if expected == "object":
            properties = schema.get("properties") or {}
            for key, child in value.items():
                child_schema = properties.get(key)
                if child_schema is not None:
                    ModuleRegistry._validate_settings(
                        child, child_schema, f"{path}.{key}", errors,
                    )
                elif schema.get("additionalProperties") is False:
                    errors.append(f"{path}.{key} is not a supported setting")
        if expected == "array" and isinstance(schema.get("items"), dict):
            for index, child in enumerate(value):
                ModuleRegistry._validate_settings(
                    child, schema["items"], f"{path}[{index}]", errors,
                )

    def validate(self, template: WorkflowTemplate) -> None:
        errors: list[str] = []
        if template.schema_version != 1:
            errors.append(f"unsupported schema_version {template.schema_version}")
        if not template.id:
            errors.append("template id is required")
        if not template.name:
            errors.append("template name is required")
        if not template.modules:
            errors.append("template must contain modules")

        seen: set[str] = set()
        roles: list[str] = []
        for item in template.modules:
            if not item.id:
                errors.append("every module instance needs an id")
            elif item.id in seen:
                errors.append(f"duplicate module instance id '{item.id}'")
            seen.add(item.id)
            definition = self.get(item.module)
            if definition is None:
                errors.append(f"unknown module '{item.module}'")
                continue
            if not isinstance(item.settings, dict):
                errors.append(f"settings for '{item.id}' must be an object")
            else:
                self._validate_settings(
                    self.settings_for(item),
                    definition.settings_schema,
                    f"modules.{item.id}.settings",
                    errors,
                )
            if item.enabled:
                roles.append(definition.role)

        if roles.count("extract") != 1:
            errors.append("template must enable exactly one Extract module")
        if roles.count("publish") != 1:
            errors.append("template must enable exactly one Publish module")
        if "extract" in roles and "publish" in roles:
            extract_index = roles.index("extract")
            publish_index = roles.index("publish")
            if extract_index > publish_index:
                errors.append("Extract must run before Publish")
            if any(role == "prepare" for role in roles[extract_index + 1:]):
                errors.append("Prepare modules must run before Extract")
            if any(role == "process" for role in roles[:extract_index]):
                errors.append("Process modules must run after Extract")
            if publish_index != len(roles) - 1:
                errors.append("Publish must be the final enabled module")
        if errors:
            raise ValueError("; ".join(errors))


@dataclass
class StageReport:
    name: str
    module: str
    status: str
    elapsed_ms: int
    error: str = ""


@dataclass
class WorkflowReport:
    workflow_id: str
    workflow_version: str
    stages: list[StageReport] = field(default_factory=list)


class WorkflowRunner(Generic[ContextT]):
    """Execute enabled template modules with consistent diagnostics."""

    def __init__(
        self,
        template: WorkflowTemplate,
        registry: ModuleRegistry[ContextT],
    ) -> None:
        registry.validate(template)
        self.template = template
        self.registry = registry

    def run(self, context: ContextT, log: Callable[[str], None]) -> WorkflowReport:
        report = WorkflowReport(self.template.id, str(self.template.version))
        log(f"[template] {self.template.id}@{self.template.version}")
        for item in self.template.modules:
            if not item.enabled:
                continue
            module = self.registry.get(item.module)
            if module is None:  # validated above; keeps type checkers honest.
                raise RuntimeError(f"unknown module '{item.module}'")
            settings = self.registry.settings_for(item)
            started = time.perf_counter()
            log(f"[module:{item.id}] {item.module} started")
            try:
                module.handler(context, settings)
            except Exception as exc:
                elapsed = int((time.perf_counter() - started) * 1000)
                report.stages.append(
                    StageReport(item.id, item.module, "failed", elapsed, str(exc)),
                )
                log(f"[module:{item.id}] failed after {elapsed}ms: {exc}")
                raise
            elapsed = int((time.perf_counter() - started) * 1000)
            report.stages.append(StageReport(item.id, item.module, "done", elapsed))
            log(f"[module:{item.id}] done in {elapsed}ms")
        return report
