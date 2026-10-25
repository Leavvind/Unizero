# UniZero Zotero Add-on

The Zotero application component: **library backend** for UniZero. It owns Zotero
lifecycle, preferences, scholarly-provider access, item and attachment mutations, the
derived relation index, the bridge used by the Obsidian plugin and the MCP server, and
the client for the local paper runtime. It also still ships the legacy Unizero Home UI.

## Capabilities

**Bridge (Obsidian, MCP server)**

- Localhost endpoints on Zotero’s HTTP server (`src/server/`).
- GET: libraries, collections, paper resolve, a paper's PDFs and generated attachments
  with their paths, relations from cache, citekey lookup, and the conversion templates
  of an already-running runtime.
- POST actions on a paper's own Raw and Canvas: convert, create an empty Canvas
  attachment (`unizero:canvas`), move Raw or Canvas to the trash, restore Raw from
  Raw Backup. Nothing is erased.
- Endpoints and rules: [Bridge contract](../../docs/ARCHITECTURE.md#bridge-contract).

**Literature data**

- Metadata candidate lookup and identifier updates.
- Compact References and Citations item-pane previews; per-paper Markdown-conversion and
  cache status with quick actions and relation drill-down.
- A Relation view per paper: which library papers cite it, and which share the most of its
  references — both derived locally with no extra network access.
- Filtering discovered works by library status, influence, year, publication type, and
  order, plus importing missing papers into the current library.
- A stable Paper catalog giving every loaded References/Citations result a Paper ID;
  retention, observations, and merges are described in
  [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#paper-catalog).
- A force-directed Graph tab per paper (item-pane / explorer detail), with adjustable
  display and force settings.

**Conversion, annotations, and reader**

- PDF conversion commands and generated-artifact registration, including a versioned
  structured References JSON attachment produced from the PDF bibliography. A
  **Default template** preference (`conversion.defaultTemplate`, shipped as Journal
  Papers) is used whenever a conversion names none.
- Raw: the converted Markdown stored under the item as two imported attachments,
  written by the runtime's `publish.zotero-markdown` module. **Raw**
  (`unizero:raw`) is the working copy, opened from Zotero with the system's Markdown
  application (Obsidian, when it is the default) and edited there; it is created
  once and never overwritten — delete it to get a fresh one on the next conversion.
  **Raw Backup** (`unizero:raw-backup`) is replaced by every conversion. Images the
  Markdown links to sit beside each file under `attachments/`. A paper with
  supplements gets one pair per PDF.
- Reader highlight shortcuts, meant for mouse buttons or gestures: `Cmd+Option+B` / `R`
  / `P` (`Ctrl+Alt` on Windows) turn the selected PDF, EPUB or snapshot text into a
  blue / red / purple highlight annotation. Hidden preference `…editShortcuts` turns
  them off.
- Annotation export and Markdown injection.
- Runtime lifecycle, jobs, service notices, and templates.

Document conversion and annotation injection require `services/paper-runtime`. Everything
else runs without it.

### Legacy: Unizero Home

Still reachable from Tools, the item-list toolbar, or the Collection context menu. Each
Collection (or library root) gets one Project and default Board. The three-pane Project
View (collection list, Board, detail tabs), Text Nodes, manual edges, and Board relation
hints remain for existing users. Maintenance traps and document shapes:
[LEGACY_HOME.md](../../docs/LEGACY_HOME.md).

## Source map

| Path | Responsibility |
| --- | --- |
| `src/core/` | Static feature registry and lifecycle dispatch |
| `src/features/` | Conversion and annotation command orchestration |
| `src/modules/` | Item pane, metadata, relations, providers, cache, preferences |
| `src/modules/uniConnection.ts` | Derived reverse-reference index, coupling, graph topology |
| `src/modules/uniConnectionSync.ts` | Notifier-driven index maintenance and reference backfill |
| `src/server/` | Bridge endpoints (Obsidian, MCP server) and citekey resolution |
| `src/projects/` | Versioned Project/Board/Paper shapes and local Project repository |
| `src/runtime-client/` | HTTP contracts, client, launch resolution, process state |
| `src/zotero/` | Zotero adapters, library scope, artifact identity, reader shortcuts |
| `src/ui/` | Menus, progress, service notices, panel and Home bridges |
| `addon/` | Manifest, locales, preferences, icons, dialog markup and scripts |
| `tests/` | Vitest: Projects, derived index, graph builders, Home dialog |

New Zotero mutations belong in `src/zotero`; new command orchestration belongs in
`src/features`. Do not rewrite `src/modules` as a single refactor. Extract a focused
responsibility when a feature change needs it.

## Dialog content

`addon/chrome/content/` holds plain JavaScript dialogs outside the TypeScript bundle: the
template editor, the legacy Home Board, and the per-paper graph renderer. Their file map
is in [PROJECT_STRUCTURE.md](../../docs/PROJECT_STRUCTURE.md#dialog-content-add-on) and
their load-bearing constraints are in [AGENTS.md](../../AGENTS.md#zotero-constraints).

## Stored state

| State | Location |
| --- | --- |
| Per-item provider caches | `<Zotero data dir>/unizero/cache/` shard tree |
| Project and Board documents | `<Zotero data dir>/unizero/projects/` typed object tree |
| Paper catalog and citation observations | `<Zotero data dir>/unizero/literature/` |
| Graph layout coordinates | `<Zotero data dir>/unizero/graph/<libraryID>.json` |
| Graph display and force settings | `<Zotero data dir>/unizero/graph/settings.json` |
| Zotero item ↔ Obsidian URL bindings | `<Zotero data dir>/unizero/markdown-links/<libraryID>.json` |
| Extracted PDF bibliography | Owned `ZoMiner References` JSON attachment (`unizero:references`) |
| Preferences | Zotero preference branch, defaults in `addon/prefs.js` |

The derived relation index is memory-only and rebuilt on demand. Completed empty Citations
lookups are a 24-hour negative cache only when at least one provider answered normally.

## Runtime connection

The add-on uses `/api/v1` on `127.0.0.1`. Launch resolution (`src/runtime-client/launch.ts`)
checks, in order: configured server script → configured Python → `PATH` interpreter that
imports `unizero_runtime` → `unizero-runtime` console command.

The runtime’s lifetime follows Zotero’s (delayed start on main-window load; stop on quit),
governed by automatic start/stop preferences. Failures surface in the panel’s Jobs list.

## Build

```bash
npm ci
npm run check
npm test
npm run build
```

`npm run check` runs TypeScript and HTTP-contract drift checks. `npm test` runs Vitest.
`npm run build` writes `build/unizero.xpi`.

## Release

Releases are published by `.github/workflows/release-zotero-addon.yml`. A pushed `v*` tag
must match `package.json`. From a clean `main` branch:

```bash
npm run release -- patch
```

Use `minor` or `major` when appropriate. Do not create a release tag manually unless
`update.json` has already been regenerated for that version.

The tag also releases the Obsidian plugin. Its version is never chosen separately:
the release copies this package's version into the plugin's `manifest.json`,
`package.json`, and `package-lock.json` (`scripts/sync-obsidian-version.mjs`), and the
plugin's tests fail when they differ.

## Run in Zotero

Copy `scripts/zotero-cmd-default.json` to the gitignored `scripts/zotero-cmd.json`, then
configure a Zotero executable and development profile.

```bash
npm run start-watch
```

For a packaged build, install `build/unizero.xpi` from Zotero’s add-on manager.

Type checking does not verify Zotero APIs, window lifecycle, XUL, or the external dialogs.
Changes in those areas require a manual Zotero check.
