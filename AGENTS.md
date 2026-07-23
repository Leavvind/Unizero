# AGENTS.md

Operational guidance for coding agents and contributors.

This file describes the current repository. Planned work belongs in `docs/ROADMAP.md`;
do not implement a roadmap idea merely because it appears in documentation.

## Start here

UniZero has two executable components:

- `apps/zotero-addon`: the Zotero 8 add-on;
- `services/paper-runtime`: the optional Python service used for document processing.

Their only integration boundary is the versioned localhost HTTP API. The canonical v1
schema is `packages/contracts/http/v1.schema.json`.

For an unfamiliar task, read only the relevant component README and the path map in
`docs/PROJECT_STRUCTURE.md`. Use `docs/ARCHITECTURE.md` when the change affects ownership
or dependency direction.

## Architecture rules

1. **Zotero is canonical.** Bibliographic metadata and annotations originate from
   Zotero. Caches, frontmatter, and generated files are derived state.
2. **The runtime is separate.** The add-on must not import Python implementation details,
   and the runtime must not access Zotero APIs.
3. **The contract is explicit.** All cross-process data uses `/api/v1` request and
   response models.
4. **UI is an adapter.** Views and dialogs delegate network work, cache policy, and
   Zotero mutations to application code or adapters.
5. **Feature, provider, and pipeline modules are different concepts.** Do not combine
   their registries or lifecycle rules.
6. **Artifact ownership is explicit.** A generated Zotero attachment is owned only when
   it carries the appropriate `unizero:<kind>` tag. Display titles are not identity.
7. **Library scope is part of identity.** Cache, artifact, and runtime keys include
   `libraryID`; group-library support must not fall back to the user library.
8. **Lifecycle is symmetric.** Every registered menu, pane, listener, observer, style,
   and window hook has a matching cleanup path.

The process boundary is recorded in
`docs/decisions/0001-addon-and-runtime-boundary.md`.

## Code ownership

| Path | Responsibility |
| --- | --- |
| `apps/zotero-addon/src/core` | Feature registration and lifecycle dispatch |
| `apps/zotero-addon/src/features` | User commands and feature orchestration |
| `apps/zotero-addon/src/runtime-client` | HTTP contract client, settings, and process launch |
| `apps/zotero-addon/src/zotero` | Zotero item, attachment, annotation, and identity adapters |
| `apps/zotero-addon/src/ui` | Menus, panel bridge, progress, and service notices |
| `apps/zotero-addon/src/modules` | Established relations, metadata, cache, and item-pane code |
| `services/paper-runtime/src/unizero_runtime/api` | FastAPI transport |
| `services/paper-runtime/src/unizero_runtime/application` | Jobs, configuration, and use cases |
| `services/paper-runtime/src/unizero_runtime/pipeline` | Workflow templates and document steps |
| `services/paper-runtime/src/unizero_runtime/providers` | PDF, reference, table, and remote providers |
| `packages/contracts` | Language-neutral boundary schemas and synthetic examples |

`src/modules` contains large, working code paths. Do not reorganize it wholesale. When a
task touches one of those paths, extract a coherent responsibility only if the change
benefits from the new seam.

## Zotero constraints

The add-on runs in Zotero's privileged Firefox environment, not Node or a normal web
page.

- Do not use Node built-ins such as `fs`, `path`, `zlib`, `events`, or `timers`.
- Prefer current public Zotero APIs and avoid adding private-API dependencies.
- Route Zotero mutations through `src/zotero` for new code.
- Treat every main window independently during load and unload.
- Any UI, lifecycle, preference, or Zotero API change needs a manual Zotero check.

`addon/chrome/content/panel.js` runs outside the TypeScript bundle and type checker.
Changes there require extra review and manual testing.

## Contract changes

For an HTTP v1 change:

1. update `packages/contracts/http/v1.schema.json`;
2. update `apps/zotero-addon/src/runtime-client/contracts.ts`;
3. update `services/paper-runtime/src/unizero_runtime/contracts.py`;
4. update shared examples when the payload shape changes;
5. run both component verification commands.

Do not add generated bindings without a reproducible generator. A new add-on must fail
clearly when the runtime version or required capabilities are incompatible.

## Stable state

Do not casually rename the add-on ID, preference keys, feature IDs, artifact tags,
contract fields, template IDs, or release filenames. Some small readers intentionally
support older user state; they are listed in `docs/LEGACY_SUPPORT.md`. Remove one only
when its retirement condition is established, and keep that removal separate from
unrelated work.

## Verification

There is no root build or test command.

From `apps/zotero-addon`:

```text
npm run check
npm run build
```

`npm run check` includes TypeScript and shared-contract drift checks. The add-on has no
host-independent UI test suite.

From `services/paper-runtime`:

```text
.venv/Scripts/python.exe -m pytest
```

Runtime tests must use the isolated home supplied by `tests/conftest.py`; never point
tests at the developer's real runtime home. End-to-end conversion requires MinerU and a
real PDF and is a manual check.

For documentation-only changes:

- verify every referenced repository path exists;
- validate relative Markdown links and headings;
- confirm no generated or machine-local files were added.

If a required manual check cannot be run, state that explicitly.

## Change discipline

- Preserve existing user changes and ignore unrelated dirty files.
- Avoid destructive Git commands.
- Keep generated files and runtime state out of the repository.
- Write repository documentation, public contracts, and new public API names in English.
- Update `docs/ROADMAP.md` when planned work lands or an open verification item closes.
