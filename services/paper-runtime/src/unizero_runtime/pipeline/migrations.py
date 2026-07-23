"""Forward-migration of stored template documents.

`TemplateStore.reload()` validates every YAML it finds and raises on the first
unknown module or unsupported setting, so a template saved by an older version
would take the whole store down with it. Migrations run before validation and
translate those documents into the current shape.
"""

from __future__ import annotations

import copy
from typing import Any

from .steps import DEFAULT_FRONTMATTER_PROPERTIES

#: Modules that no longer exist. Instances are dropped rather than rejected.
#: enrich.semantic-scholar guessed a paper from the title and wrote the S2 link,
#: citation count, and a missing DOI into the Markdown only; the add-on's
#: Complete Metadata action now resolves the same facts against the Zotero item,
#: where they can be reviewed and reused.
REMOVED_MODULES = {"enrich.semantic-scholar"}

_FRONTMATTER_MODULE = "transform.frontmatter"


def _frontmatter_properties(settings: dict[str, Any]) -> list[dict[str, Any]]:
    """Legacy {"tags": [...], "extra": {...}} → the property mapping table.

    The old module emitted a fixed field list, so the migrated table is the
    current default with the user's tags substituted and their extra fields
    appended — the same document, expressed as rows the user can now edit.
    """
    properties = copy.deepcopy(DEFAULT_FRONTMATTER_PROPERTIES)
    tags = settings.get("tags")
    if isinstance(tags, list):
        properties = [item for item in properties if item["key"] != "tags"]
        if tags:
            properties.append({
                "key": "tags", "value": [str(tag) for tag in tags], "type": "list",
            })
    extra = settings.get("extra")
    if isinstance(extra, dict):
        for key, value in extra.items():
            key = str(key).strip()
            if not key:
                continue
            properties.append({
                "key": key,
                "value": value,
                "type": "list" if isinstance(value, list) else "text",
            })
    return properties


def migrate_template_dict(value: dict[str, Any]) -> dict[str, Any]:
    """Return `value` in the current template shape, leaving the input alone."""
    if not isinstance(value, dict):
        return value
    migrated = copy.deepcopy(value)
    modules = migrated.get("modules")
    if not isinstance(modules, list):
        return migrated

    kept: list[Any] = []
    for item in modules:
        if not isinstance(item, dict):
            kept.append(item)
            continue
        if str(item.get("module") or "").strip() in REMOVED_MODULES:
            continue
        settings = item.get("settings")
        if (
            str(item.get("module") or "").strip() == _FRONTMATTER_MODULE
            and isinstance(settings, dict)
            and "properties" not in settings
            and ("tags" in settings or "extra" in settings)
        ):
            item["settings"] = {"properties": _frontmatter_properties(settings)}
        kept.append(item)
    migrated["modules"] = kept
    return migrated
