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

#: Modules replaced by another. publish.zotero-note turned the Markdown into a
#: Zotero note; publish.zotero-markdown stores it as a Markdown attachment that
#: is edited in Obsidian, and never overwrites the edited copy, so the note's
#: "existing note" setting has no counterpart and is dropped.
REPLACED_MODULES = {"publish.zotero-note": "publish.zotero-markdown"}

#: Modules folded into transform.content, together with the Extract module's
#: formula and table switches. Those switches dropped blocks before anything else
#: saw them, so turning tables off also emptied the table digest.
_CONTENT_MODULE = "transform.content"
_REFERENCES_MODULE = "transform.references"
_CLEANUP_MODULE = "transform.markdown-cleanup"
_DIGEST_MODULE = "export.zotero-tables"
_FOLDED_INTO_CONTENT = (_REFERENCES_MODULE, _CLEANUP_MODULE, _DIGEST_MODULE)
_FIGURE_MODES = {"none": "pointer", "all": "save"}
_TABLE_MODES = {"none": "pointer", "md": "markdown", "html": "html"}

_FRONTMATTER_MODULE = "transform.frontmatter"
_PAPER_TO_MARKDOWN = "paper-to-markdown"
_UID_TEMPLATE_VERSION = 2
_REFERENCES_TEMPLATE_VERSION = 3


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


def _module_id(item: Any) -> str:
    return str(item.get("module") or "").strip() if isinstance(item, dict) else ""


def _fold_content_modules(modules: list[Any]) -> list[Any]:
    """References, Markdown post-processing, and Table digest → one Content module.

    The merged instance takes the place of the first folded module. A module that
    was absent or disabled keeps its effect: no References extraction, no digest,
    and, without post-processing, a Markdown that keeps figures, tables, and the
    References section.
    """
    extract = next(
        (item for item in modules if _module_id(item) == "extract.mineru"), None,
    )
    extract_settings = (
        extract.get("settings") if isinstance(extract, dict) else None
    )
    formulas_kept = tables_kept = True
    if isinstance(extract_settings, dict):
        formulas_kept = bool(extract_settings.pop("enable_formula", True))
        tables_kept = bool(extract_settings.pop("enable_table", True))

    folded = {
        module: next((item for item in modules if _module_id(item) == module), None)
        for module in _FOLDED_INTO_CONTENT
    }
    if not any(folded.values()):
        return modules

    def enabled(module: str) -> bool:
        item = folded[module]
        return isinstance(item, dict) and bool(item.get("enabled", True))

    def settings(module: str) -> dict[str, Any]:
        item = folded[module]
        value = item.get("settings") if isinstance(item, dict) else None
        return value if isinstance(value, dict) else {}

    cleanup = settings(_CLEANUP_MODULE)
    if enabled(_CLEANUP_MODULE):
        figures = _FIGURE_MODES.get(str(cleanup.get("images_mode") or "none"), "pointer")
        table_mode = _TABLE_MODES.get(str(cleanup.get("table_mode") or "none"), "pointer")
        remove_references = bool(cleanup.get("strip_references", True))
        repeated = bool(cleanup.get("strip_repeated_lines", False))
    else:
        figures, table_mode, remove_references, repeated = "save", "html", False, False
    content_settings = {
        "formulas": "keep" if formulas_kept else "remove",
        "figures": figures,
        "tables": {
            "markdown": table_mode if tables_kept else "pointer",
            "refine_complex": bool(cleanup.get("table_vlm", False)),
            "digest": enabled(_DIGEST_MODULE) and tables_kept,
            "digest_figures": bool(settings(_DIGEST_MODULE).get("include_figures", False)),
        },
        "references": {
            "extract": enabled(_REFERENCES_MODULE),
            "remove_from_body": remove_references,
        },
        "remove_repeated_lines": repeated,
    }

    position = min(
        index for index, item in enumerate(modules)
        if _module_id(item) in _FOLDED_INTO_CONTENT
    )
    kept = [
        item for index, item in enumerate(modules)
        if index < position or _module_id(item) not in _FOLDED_INTO_CONTENT
    ]
    used_ids = {str(item.get("id") or "").strip() for item in kept if isinstance(item, dict)}
    kept.insert(position, {
        "id": "content" if "content" not in used_ids else "content-module",
        "module": _CONTENT_MODULE,
        "enabled": any(enabled(module) for module in _FOLDED_INTO_CONTENT),
        "settings": content_settings,
    })
    return kept


def migrate_template_dict(value: dict[str, Any]) -> dict[str, Any]:
    """Return `value` in the current template shape, leaving the input alone."""
    if not isinstance(value, dict):
        return value
    migrated = copy.deepcopy(value)
    modules = migrated.get("modules")
    if not isinstance(modules, list):
        return migrated
    add_uid = (
        str(migrated.get("id") or "").strip() == _PAPER_TO_MARKDOWN
        and int(migrated.get("version", 1)) < _UID_TEMPLATE_VERSION
    )
    upgrade_references = (
        str(migrated.get("id") or "").strip() == _PAPER_TO_MARKDOWN
        and int(migrated.get("version", 1)) < _REFERENCES_TEMPLATE_VERSION
        and not any(_module_id(item) == _CONTENT_MODULE for item in modules)
    )
    kept: list[Any] = []
    for item in modules:
        if not isinstance(item, dict):
            kept.append(item)
            continue
        if str(item.get("module") or "").strip() in REMOVED_MODULES:
            continue
        replacement = REPLACED_MODULES.get(str(item.get("module") or "").strip())
        if replacement:
            item["module"] = replacement
            item["settings"] = {}
        settings = item.get("settings")
        if (
            str(item.get("module") or "").strip() == _FRONTMATTER_MODULE
            and isinstance(settings, dict)
            and "properties" not in settings
            and ("tags" in settings or "extra" in settings)
        ):
            item["settings"] = {"properties": _frontmatter_properties(settings)}
            settings = item["settings"]
        if (
            add_uid
            and str(item.get("module") or "").strip() == _FRONTMATTER_MODULE
            and isinstance(settings, dict)
            and isinstance(settings.get("properties"), list)
            and not any(
                isinstance(row, dict) and str(row.get("key") or "").strip() == "uid"
                for row in settings["properties"]
            )
        ):
            uid = {"key": "uid", "value": "{{ uid }}", "type": "text"}
            properties = settings["properties"]
            citekey_index = next(
                (
                    index for index, row in enumerate(properties)
                    if isinstance(row, dict)
                    and str(row.get("key") or "").strip() == "citekey"
                ),
                len(properties) - 1,
            )
            properties.insert(citekey_index + 1, uid)
        kept.append(item)
    if upgrade_references:
        # transform.references used to exist before extraction in some stored
        # templates. Preserve its settings, but move one canonical instance after
        # MinerU/page-link processing so it can read content_list. Dropping duplicate
        # legacy instances also prevents the same bibliography being parsed twice.
        existing_references = [
            item
            for item in kept
            if isinstance(item, dict)
            and str(item.get("module") or "").strip() == "transform.references"
        ]
        kept = [
            item
            for item in kept
            if not (
                isinstance(item, dict)
                and str(item.get("module") or "").strip()
                == "transform.references"
            )
        ]
        used_ids = {
            str(item.get("id") or "").strip()
            for item in kept
            if isinstance(item, dict)
        }
        instance_id = (
            "references"
            if "references" not in used_ids
            else "reference-extraction"
        )
        reference_module = (
            existing_references[0]
            if existing_references
            else {
                "id": instance_id,
                "module": "transform.references",
                "enabled": True,
                "settings": {"warn_if_empty": True},
            }
        )
        insert_after = next(
            (
                index for index, item in reversed(list(enumerate(kept)))
                if isinstance(item, dict)
                and str(item.get("module") or "").strip()
                in {"extract.mineru", "transform.zotero-page-links"}
            ),
            -1,
        )
        kept.insert(insert_after + 1, reference_module)
    migrated["modules"] = _fold_content_modules(kept)
    if add_uid or upgrade_references:
        migrated["version"] = max(
            int(migrated.get("version", 1)),
            _UID_TEMPLATE_VERSION if add_uid else 1,
            _REFERENCES_TEMPLATE_VERSION if upgrade_references else 1,
        )
    return migrated
