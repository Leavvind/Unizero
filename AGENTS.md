# AGENTS.md

Operational guidance for coding agents and contributors. It describes the repository as
it is; planned work lives in `docs/ROADMAP.md` and is not a work order.

UniZero connects **Zotero** (library, providers, cache, conversion) and **Obsidian**
(notes, links, exploration). Zotero is canonical for bibliographic identity; Obsidian is
the active front end.

## Components and focus

| Component | Status | Notes |
| --- | --- | --- |
| `apps/obsidian-plugin` | **Active** — default place for product work | Markdown UniZero links, Vault UIDs, `@` search, panes |
| `apps/zotero-addon` data plane + `src/server` bridge | Required backend | Providers, reference cache, relations, Paper catalog, conversion client |
| `apps/mcp-server` | Maintained | Agent tools over the same bridge; reads only files `GET /artifacts` names |
| `services/paper-runtime` | Optional | Python document-processing service |
| Unizero Home (per-paper References / Relation / Citations window) in `addon/chrome/content` | **Legacy** | Do not extend or redesign unless the task names Home |
| Item-pane literature UI | Background | Maintain when a task touches them |

Two unrelated boundaries, never merged:

- add-on ↔ runtime: localhost HTTP `/api/v1`, schema `packages/contracts/http/v1.schema.json`;
- add-on ↔ Obsidian plugin / MCP server: the bridge on Zotero's HTTP server, versioned by
  `BRIDGE_API_VERSION` in `apps/zotero-addon/src/server/bridgePayloads.ts`.

**What to read.** The component README, then the file the task names. For where code
belongs, `docs/PROJECT_STRUCTURE.md`; for ownership or process boundaries,
`docs/ARCHITECTURE.md`; for which docs are current state versus design notes,
`docs/README.md`. Open `docs/LEGACY_HOME.md` or `docs/UNICONNECTION.md` only for
those surfaces.

## Architecture rules

1. **Zotero is canonical.** Metadata and annotations originate in Zotero; caches,
   frontmatter, and generated files are derived state.
2. **The runtime is separate.** The add-on imports no Python details; the runtime never
   touches Zotero APIs.
3. **Cross-process data uses the `/api/v1` models.**
4. **UI is an adapter.** Views and dialogs delegate network work, cache policy, and
   Zotero mutations to application code or adapters.
5. **Feature, provider, and pipeline modules are different concepts** with separate
   registries and lifecycles.
6. **Artifact ownership is a tag.** A generated attachment is owned only when it carries
   `unizero:<kind>`; display titles are not identity.
7. **Library scope is part of identity.** Cache, artifact, and runtime keys include
   `libraryID`; never fall back to the user library.
8. **Lifecycle is symmetric.** Every menu, pane, listener, observer, style, and window
   hook has a matching cleanup.
9. **Derived state is rebuildable.** The relation index is recomputed from the reference
   cache, never written back to item shards, and carries no Zotero display fields.
10. **Dialogs talk through their window API bridge** (`window.arguments[0]`); they never
    import bundle modules.
11. **The bridge is mostly read-only and never fetches unbidden.** GET endpoints do not
    mutate Zotero or the Paper catalog. The only POSTs act on a paper's own Raw and
    Canvas attachments (see [Bridge contract](docs/ARCHITECTURE.md#bridge-contract));
    none erases anything or writes into an existing file. Relations answer from cache
    (`loaded: false` on a miss); only explicit `fetch=1` reaches providers. Rendering a
    note never causes network work or conversion.
12. **A citekey is an alias, not an identity.** Persist `libraryID` + `itemKey`; report
    citekey ambiguity, never resolve it silently.

`src/modules` holds large working code paths: do not reorganize it wholesale; extract a
seam only when the task benefits from it.

## Zotero constraints

The add-on runs in Zotero's privileged Firefox environment, not Node.

- No Node built-ins (`fs`, `path`, `zlib`, `events`, `timers`, …).
- Prefer public Zotero APIs; route new Zotero mutations through `src/zotero`.
- Treat every main window independently on load and unload.

`addon/chrome/content/panel.js` and `literature-explorer.js` are outside the bundle and
type checker, so changes there need extra review.

## Contract changes (HTTP v1)

Update together: `packages/contracts/http/v1.schema.json`,
`apps/zotero-addon/src/runtime-client/contracts.ts`,
`services/paper-runtime/src/unizero_runtime/contracts.py`, and the shared examples when
a payload shape changes; then verify both components. No generated bindings without a
reproducible generator. A new add-on must fail clearly against an incompatible runtime.

## Stable state

Do not casually rename the add-on ID, preference keys, feature IDs, artifact tags,
contract fields, template IDs, or release filenames. Compatibility readers for older
user state are listed in `docs/LEGACY_SUPPORT.md`; remove one only when its retirement
condition holds, in a separate change.

**Versions.** One repository version, in `apps/zotero-addon/package.json`; a `v*` tag
releases the add-on and the plugin together. Never edit it by hand — run
`npm run release -- patch|minor|major` in `apps/zotero-addon`. Check `git tag` before
stating the current version.

## Verification

No root command; verify only the components you changed. In `apps/zotero-addon`,
`apps/obsidian-plugin`, and `apps/mcp-server`: `npm run check` and `npm test`. Add
`npm run build` only when you change dependencies, build scripts, the manifest, or files
under `addon/`; its type check repeats `check`, and the release workflow builds
everything. In `services/paper-runtime`: `.venv/Scripts/python.exe -m pytest` (tests
must use the isolated home from `tests/conftest.py`, never the real runtime home).

Tests cover only host-free logic. These always need a manual check — say so when you
cannot run it; do not record it as an open item:

| Component | Manual check required for |
| --- | --- |
| zotero-addon | Lifecycle, menus, preferences, providers, any privileged Zotero API or UI change |
| obsidian-plugin | Rendering, suggester, panes, bridge calls — in a real vault against a running Zotero |
| mcp-server | Calls against a real library |
| paper-runtime | End-to-end conversion (MinerU + a real PDF) |

A change to the digest HTML in the runtime's `providers/tables.py` needs
`apps/mcp-server/tests/fixtures/tables-digest.html` regenerated.

Documentation-only changes: check that the paths, links, and headings you added or
changed resolve.

## Change discipline

- Preserve existing user changes; ignore unrelated dirty files; no destructive Git.
- Keep generated files and runtime state out of the repository.
- Code, contracts, and current-state docs are in English; design notes may use the
  requester's language (`docs/README.md` records which). One language per document.
- When planned work lands, remove it from `docs/ROADMAP.md` and fix any current-state
  document it invalidates.
