# AGENTS.md

Operational guidance for coding agents and contributors.

This file describes the current repository. Planned work belongs in `docs/ROADMAP.md`;
do not implement a roadmap idea merely because it appears in documentation.

## Start here

UniZero has three executable components:

- `apps/zotero-addon`: the Zotero add-on;
- `services/paper-runtime`: the optional Python service used for document processing;
- `apps/obsidian-plugin`: the optional Obsidian plugin that renders `@libraryID/itemKey`.

The add-on and the runtime integrate through the versioned localhost HTTP API; the
canonical v1 schema is `packages/contracts/http/v1.schema.json`. The add-on and the
Obsidian plugin integrate through a separate, read-only bridge on Zotero's own HTTP
server, versioned by `BRIDGE_API_VERSION` in
`apps/zotero-addon/src/server/bridgePayloads.ts`. The two boundaries are unrelated and
must not be merged.

For an unfamiliar task, read only the relevant component README and the path map in
`docs/PROJECT_STRUCTURE.md`. Use `docs/ARCHITECTURE.md` when the change affects ownership
or dependency direction. `docs/README.md` says which documents describe current behaviour
and which are design notes; do not treat a design note as a work order.

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
9. **Derived state is rebuildable and never authoritative.** The relation index and graph
   topology are recomputed from the reference cache; they are not written back to item
   shards, and topology carries no Zotero display fields.
10. **Dialog content talks through its window API bridge.** Privileged XHTML dialogs get a
    plain object on `window.arguments[0]`; they never import bundle modules.
11. **The Obsidian bridge is read-only and never fetches unbidden.** No endpoint under
    `src/server` mutates Zotero or the Paper catalog, and relations answer from cache;
    a miss is reported as `loaded: false` so the caller can prompt. Only an explicit
    `fetch=1` may reach the providers. Rendering a note must never cause network work.
12. **A citekey is an alias, not an identity.** Persisted state uses `libraryID` plus
    `itemKey`; a citekey is derived from mutable metadata and can collide. Ambiguity is
    reported, never resolved silently.

The process boundary is described in `docs/ARCHITECTURE.md`.

## Code ownership

| Path | Responsibility |
| --- | --- |
| `apps/zotero-addon/src/core` | Feature registration and lifecycle dispatch |
| `apps/zotero-addon/src/features` | User commands and feature orchestration |
| `apps/zotero-addon/src/runtime-client` | HTTP contract client, settings, and process launch |
| `apps/zotero-addon/src/zotero` | Zotero item, attachment, annotation, and identity adapters |
| `apps/zotero-addon/src/ui` | Menus, panel bridge, progress, and service notices |
| `apps/zotero-addon/src/modules` | Established relations, metadata, cache, and item-pane code |
| `apps/zotero-addon/src/server` | Read-only localhost bridge and citekey resolution |
| `apps/obsidian-plugin/src` | Obsidian rendering, suggester, detail pane, and bridge client |
| `apps/zotero-addon/addon/chrome/content` | Untyped privileged dialogs: panel, Unizero Home, graph renderer |
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

`addon/chrome/content/panel.js`, `literature-explorer.js`, and `literature-graph.js` run
outside the TypeScript bundle and type checker. Changes there require extra review and
manual testing. Two of their constraints are load-bearing:

- Callbacks handed to `force-graph` run synchronously inside an animation loop with no
  error handling, so one unguarded throw freezes the canvas permanently. Keep every
  callback inside `guard()`, and keep swallowed failures visible.
- Persisted graph layout coordinates are valid only at the scale of the forces that
  produced them. Force settings the user chose are covered by the signature stored with
  the layout; changes made in code are not, so bump `GRAPH_LAYOUT_VERSION` in
  `src/modules/views.ts` whenever a code change alters what a coordinate means.
- Graph display and force values belong to `literature-graph.js`, which defines their
  defaults, bounds, and sanitisation. Do not duplicate those numbers in the bridge, in
  `views.ts`, or in the settings file format.

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
npm test
npm run build
```

`npm run check` includes TypeScript and shared-contract drift checks. `npm test` runs
Vitest over the parts that are deliberately free of Zotero: the derived relation index,
the graph builders, Project and Paper persistence, the sync engine and WebDAV backend,
and the Home dialog loaded under `happy-dom`. Lifecycle, menus, providers, and every
privileged Zotero API remain untested and need a manual Zotero check.

From `apps/obsidian-plugin`:

```text
npm run check
npm test
npm run build
```

`npm test` covers the citation syntax, the only part free of Obsidian. Rendering, the
suggester, the detail pane, and every bridge call need a manual check in a real vault
against a running Zotero.

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
- Write public contracts, code identifiers, and current-state documentation in English.
  Design and handoff notes may be written in the requester's language; `docs/README.md`
  records which is which. Never mix languages inside one document.
- Update `docs/ROADMAP.md` when planned work lands or an open verification item closes,
  and fix any current-state document the same change invalidates.
