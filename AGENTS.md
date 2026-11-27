# AGENTS.md

Operational guidance for coding agents and contributors. It describes the repository as
it is; planned work lives in `docs/ROADMAP.md` and is not a work order.

UniZero connects **Zotero** (canonical bibliographic store, providers, cache, conversion)
and **Obsidian** (active note-taking front end).

## Components and focus

| Component | Status | Notes |
| --- | --- | --- |
| `apps/obsidian-plugin` | **Active** — default place for product work | Markdown UniZero links, Vault UIDs, `@` search, panes |
| `apps/zotero-addon` data plane + `src/server` bridge | Required backend | Providers, reference cache, relations, conversion client |
| `apps/mcp-server` | Maintained | Agent tools over the bridge; reads only files `GET /artifacts` names |
| `services/paper-runtime` | Optional | Local Python PDF/EPUB conversion and annotation service |
| `packages/links` | Required | Link grammar, Markdown/Canvas scanning, evidence units, link roles — shared by the plugin and add-on |
| Uniconnection (`src/ui/unizeroHome.ts`, `src/zotero/paperLinkSources.ts`) | Maintained | Paper relations from Raw / Canvas links, per-paper page, provider Bibliography |

Two unrelated localhost boundaries — never merge them:

- add-on ↔ Obsidian / MCP server: bridge `/unizero/v1/*` on Zotero's HTTP server
  (`BRIDGE_API_VERSION` in `apps/zotero-addon/src/server/bridgePayloads.ts`);
- add-on ↔ runtime: `/api/v1` (`packages/contracts/http/v1.schema.json`).

**What to read.** Start with the files the task names; read `docs/PROJECT_STRUCTURE.md`
when locating where code belongs. Read the component `README.md` when changing
user-visible behavior, setup, or release steps; `docs/ARCHITECTURE.md` for ownership or
process boundaries; `docs/README.md` for the document map. Open
`docs/UNIZERO_LINKS_DESIGN.md` or `docs/UNICONNECTION.md` when touching those surfaces.

## Architecture rules

1. **Zotero is canonical.** Bibliographic metadata and PDF annotations originate in
   Zotero; caches, frontmatter, and generated files are derived state.
2. **Durable identity, never aliases or paths.** Zotero targets persist `libraryID` +
   `itemKey` (citekeys are aliases; report ambiguity, never resolve it silently). Vault
   targets persist logical `vaultID` + `UID` (file paths are derived mappings).
3. **Library scope is part of identity.** Cache, artifact, and runtime keys include
   `libraryID`; never fall back to the user library.
4. **Artifact ownership is a tag.** Generated Zotero attachments are owned only when they
   carry `unizero:<kind>`; display titles and storage paths are not identity.
5. **The bridge is mostly read-only and never acts unbidden.** GET endpoints never mutate
   Zotero; POSTs act only on a paper's own conversion or Raw/Canvas attachments without
   erasing files ([Bridge contract](docs/ARCHITECTURE.md#bridge-contract)). Rendering,
   indexing, or opening panes never triggers provider traffic, runtime startup, or
   conversion unless explicitly requested (e.g. `fetch=1`).
6. **The runtime is separate and talks only through `/api/v1`.** The add-on imports no
   Python details; the runtime never touches Zotero APIs; Obsidian and MCP never call
   `/api/v1`.
7. **UI is an adapter and lifecycle is symmetric.** Views and dialogs delegate network
   work, scanning, cache policy, and host mutations to application code or adapters.
   Every menu, pane, command, listener, observer, style, wrapper, and window hook has a
   matching cleanup, and async scans guard against stale generations or post-unload writes.
8. **Derived indexes are rebuildable.** Neither Zotero's memory-only relation index
   (recomputed from reference cache shards + `unizero:excerpts` notes, with no Zotero
   display fields) nor Obsidian's document-link index writes back to shards, notes, or
   the Paper catalog.

## Obsidian constraints

- **Never write frontmatter unbidden.** Assign or write `uid` frontmatter only on
  explicit user actions (setting a UID, linking to a UID-less note, Unlinked mentions
  `Link`) — never during rendering, indexing, or opening panes. Duplicate UIDs must halt
  navigation and list candidates rather than picking one.
- **Discover Zotero files only through the bridge.** Use `/artifacts`, `/link-sources`,
  and `/link-target`; never walk Zotero `storage` directories or infer Raw/Canvas identity
  from titles or filenames in the plugin.
- **Strict attachment resolution, graceful anchor fallback.** An explicit missing
  `attachment` fails (404) without falling back to another file. Missing or ambiguous
  heading/block anchors still open the resolved file with a notice and never rewrite
  links automatically.
- **Guard Obsidian editor internals.** Live-preview `unizero://` click interception
  (`onEditorClick`) and chained destination autocomplete rely on Obsidian 1.15 internals
  (`docs/UNIZERO_LINKS_DESIGN.md`); recheck both when changing editor hooks or upgrading
  Obsidian types.

## Zotero constraints

The add-on runs in Zotero's privileged Firefox environment, not Node.

- No Node built-ins (`fs`, `path`, `zlib`, `events`, `timers`, …).
- Prefer public Zotero APIs; route Zotero mutations through `src/zotero/`.
- Feature, provider, and pipeline modules have separate registries and lifecycles; treat
  every main window independently on load and unload.
- `addon/chrome/content/` (`panel.js`, XHTML shells) sits outside the bundle, type
  checker, and tests: never import bundle modules there (wire windows via
  `window.arguments[0]`, `preferences` via `src/modules/prefs.ts`), and review changes
  extra carefully.
- `src/modules/` holds large working code paths: do not reorganize it wholesale; extract
  a seam only when the task benefits from it.

## Contracts

- **Bridge (`/unizero/v1/*`, `apps/zotero-addon/src/server/bridgePayloads.ts`).**
  Announce compatible new endpoints, parameters, or fields via `GET /ping` `capabilities`
  while keeping `BRIDGE_API_VERSION` unchanged; bump `BRIDGE_API_VERSION` only when an
  existing field or behavior changes incompatibly. Update `apps/obsidian-plugin` and
  `apps/mcp-server` bridge clients and tests alongside payload changes.
- **Runtime HTTP v1 (`/api/v1`).** Update together:
  `packages/contracts/http/v1.schema.json`,
  `apps/zotero-addon/src/runtime-client/contracts.ts`,
  `services/paper-runtime/src/unizero_runtime/contracts.py`, and the shared examples in
  `packages/contracts/examples/`; then verify both components. No generated bindings
  without a reproducible generator. A new add-on must fail clearly against an
  incompatible runtime.

## Stable state

Do not casually rename the add-on ID, preference keys, feature IDs, artifact tags,
contract fields, template IDs, or release filenames. Compatibility readers are listed in
`docs/LEGACY_SUPPORT.md`; remove one only when its retirement condition holds, in a
separate change.

**Versions.** `apps/zotero-addon/package.json` and `apps/obsidian-plugin/package.json`
share the release version and ship together from one `v*` tag (`mcp-server` and
`paper-runtime` carry independent package metadata). Never edit release versions by
hand — run `npm run release -- patch|minor|major` in `apps/zotero-addon`, which updates
and stages both. Check `git tag` before stating the current released version.

## Verification

No root command; verify only the components you changed.

- `apps/obsidian-plugin`, `apps/zotero-addon`, `apps/mcp-server`, `packages/links`:
  `npm run check && npm test`. A change to `packages/links` also verifies both apps that
  link it (`apps/obsidian-plugin`, `apps/zotero-addon`); run `npm ci` there first on a
  fresh checkout, since npm links it without installing its dependencies.
  Add `npm run build` only when changing dependencies, build scripts, manifests, or files
  under `addon/`.
- `services/paper-runtime`: `uv run --no-sync pytest` (tests must use the isolated home
  from `tests/conftest.py`, never the real runtime home).

Tests cover only host-free logic. Always say in your reply when a required manual check
could not be run; do not add routine manual checks to `docs/ROADMAP.md` (unrun host
features and unverified host fixes for links live in `docs/UNIZERO_LINKS_DESIGN.md`):

| Component | Manual check required for |
| --- | --- |
| obsidian-plugin | Rendering, suggester, panes, bridge calls — in a real vault against a running Zotero |
| zotero-addon | Lifecycle, menus, preferences, providers, any privileged Zotero API or UI change |
| mcp-server | Calls against a real library |
| paper-runtime | End-to-end conversion (MinerU + a real PDF) |

A change to the digest HTML in `services/paper-runtime/src/unizero_runtime/providers/tables.py`
needs `apps/mcp-server/tests/fixtures/tables-digest.html` regenerated. Documentation
changes: verify that added or changed paths, links, and headings resolve.

## Change discipline

- Preserve existing user changes; ignore unrelated dirty files; no destructive Git.
- Keep generated files and runtime state out of the repository.
- Code, contracts, and current-state docs are in English; design notes may use the
  requester's language (`docs/README.md` records which). One language per document.
- When planned work lands, remove it from `docs/ROADMAP.md` and fix any current-state
  document it invalidates.
