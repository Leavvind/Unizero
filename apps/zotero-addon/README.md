# UniZero Zotero Add-on

The Zotero application component: **library backend** for UniZero. It owns Zotero
lifecycle, preferences, scholarly-provider access, item and attachment mutations, the
derived relation index, the mostly-read-only bridge used by the Obsidian plugin, and the
client for the local paper runtime.

Product framing: Zotero holds the library; Obsidian is the active note front end. See the
repository [README](../../README.md) and [AGENTS.md](../../AGENTS.md).

**Unizero Home (Project View / Board) is legacy on this branch.** The UI still ships and
tests may still load it, but it is not the product focus — do not extend it unless a task
says so. Prefer Obsidian-side work and the data/bridge surfaces below.

## Capabilities

**Bridge (Obsidian)**

- Mostly read-only localhost endpoints on Zotero’s HTTP server (`src/server/`).
- GET: libraries, collections, paper resolve, relations from cache, citekey lookup.
- Sole action: `POST /convert` — same conversion job as the Zotero item menu.
- No unbidden provider fetches: a cache miss returns `loaded: false` unless
  `fetch=1` is explicit. See [ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

**Literature data**

- Metadata candidate lookup and identifier updates.
- Compact References and Citations item-pane previews; per-paper Markdown-conversion and
  cache status with quick actions and relation drill-down.
- A Relation view per paper: which library papers cite it, and which share the most of its
  references — both derived locally with no extra network access.
- Filtering discovered works by library status, influence, year, publication type, and
  order, plus importing missing papers into the current library.
- A stable Paper catalog. Every loaded References/Citations candidate gets a Paper ID at
  `cache` retention, which pinning and Zotero binding promote to `pinned` or `zotero`.
  Observations use one directed citation model. Only a successful terminal provider
  snapshot replaces stale observations and collects orphaned cache-only Papers; incomplete
  pages and provider failures preserve prior evidence. Explicit identity merges leave
  redirects for old Paper IDs.
- A force-directed Graph tab per paper (item-pane / explorer detail), with adjustable
  display and force settings. The full-library Collection graph was removed.

**Conversion, annotations, and sync**

- PDF conversion commands and generated-artifact registration, including a versioned
  structured References JSON attachment produced from the PDF bibliography.
- Annotation export and Markdown injection.
- Runtime lifecycle, jobs, service notices, and templates.
- Manual and scheduled WebDAV sync for Project, Board, node, edge, and tombstone
  documents. Application passwords live in Zotero’s Login Manager under an add-on-specific
  realm and never reach preferences or sync packs. Automatic sync is opt-in and runs no
  more often than every 30 minutes.

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
| `src/server/` | Bridge endpoints (GET + convert) and citekey resolution |
| `src/projects/` | Versioned Project/Board/Paper shapes and local Project repository |
| `src/runtime-client/` | HTTP contracts, client, launch resolution, process state |
| `src/zotero/` | Zotero adapters, library scope, artifact identity |
| `src/ui/` | Menus, progress, service notices, panel and Home bridges |
| `addon/` | Manifest, locales, preferences, icons, dialog markup and scripts |
| `tests/` | Vitest: Projects, derived index, graph builders, Home dialog |

New Zotero mutations belong in `src/zotero`; new command orchestration belongs in
`src/features`. Do not rewrite `src/modules` as a single refactor. Extract a focused
responsibility when a feature change needs it.

## Dialog content

`addon/chrome/content/panel.js`, `literature-explorer.js`, and `literature-graph.js` are
plain JavaScript outside the TypeScript bundle. They implement the template editor, the
legacy Home Board, and the per-paper force-graph renderer. Vitest covers host-independent
dialog behaviour under `happy-dom`; Zotero APIs and the real canvas need a manual check.

They reach the add-on only through `window.arguments[0].api`. Graph constraints:

- force-graph callbacks run in an unhandled animation loop — wrap every callback in
  `guard()`;
- layout coordinates are valid only at the force scale that produced them — bump
  `GRAPH_LAYOUT_VERSION` in `src/modules/views.ts` when code changes coordinate meaning.

Detail: [UNICONNECTION.md](../../docs/UNICONNECTION.md).

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

## Run in Zotero

Copy `scripts/zotero-cmd-default.json` to the gitignored `scripts/zotero-cmd.json`, then
configure a Zotero executable and development profile.

```bash
npm run start-watch
```

For a packaged build, install `build/unizero.xpi` from Zotero’s add-on manager.

Type checking does not verify Zotero APIs, window lifecycle, XUL, or the external dialogs.
Changes in those areas require a manual Zotero check.

## Related documentation

- [Documentation map](../../docs/README.md)
- [Repository architecture](../../docs/ARCHITECTURE.md)
- [Project structure](../../docs/PROJECT_STRUCTURE.md)
- [Legacy Home maintenance](../../docs/LEGACY_HOME.md)
- [Derived relation index and graph](../../docs/UNICONNECTION.md)
- [Legacy data support](../../docs/LEGACY_SUPPORT.md)
