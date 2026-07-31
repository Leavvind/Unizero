# UniZero Zotero Add-on

The Zotero 8 application component. It owns Zotero lifecycle, UI, preferences,
scholarly-provider access, item and attachment mutations, the derived relation index, and
the client for the local paper runtime.

## Capabilities

**Unizero Home** opens from Tools, the item-list toolbar, or the Collection context menu;
the item context menu opens the selected paper straight into its own tab. Each Zotero
Collection — or a library root — gets one stable Project and default Board, keyed by
portable Zotero scope and Collection key.

- A three-pane Project View: collapsible Collection paper list, pannable and zoomable
  Board, and collapsible References/Relation/Citations Detail View.
- Board cards. Library papers drag on more than once as independent instances, with
  persisted position, size, and deletion tombstones. References and Citations rows drag on
  directly; an out-of-library result becomes a durable pinned Paper without creating a
  Zotero item.
- Board connections. Four directional drag handles create persisted manual edges, drawn as
  independently selectable curves. Hovering an identifiable card highlights every related
  instance with derived, non-persisted relation hints.
- Text Nodes: ordered, stable-ID content blocks. Collection papers embed as PaperBlocks
  without creating another Zotero item, and a library-backed block can be copied back out
  as a standalone card.
- Papers open as tabs beside a pinned Project tab, so several can be read at once and
  returning to one costs no provider call. Transient Collection previews also reuse
  completed snapshots by library, item, and relation kind, so A → B → A does not rebuild A.

**Literature data**

- Metadata candidate lookup and identifier updates.
- Compact References and Citations item-pane previews; per-paper Markdown-conversion and
  cache status with quick actions and relation drill-down.
- A Relation view per paper: which library papers cite it, and which share the most of its
  references — both derived locally with no extra network access.
- Filtering discovered works by library status, influence, year, publication type, and
  order, plus importing missing papers into the current library.
- A stable Paper catalog. Every loaded References/Citations candidate gets a Paper ID at
  `cache` retention, which Board pinning and Zotero binding promote to `pinned` or
  `zotero`. Observations use one directed citation model. Only a successful terminal
  provider snapshot replaces stale observations and collects orphaned cache-only Papers;
  incomplete pages and provider failures preserve prior evidence. Explicit identity merges
  leave redirects for old Paper IDs.
- A force-directed Graph tab per paper, centred on it, with adjustable display and force
  settings and a per-node menu for PDF, Markdown, and relation actions. The full-library
  Collection graph and the management table it toggled with are retired surfaces — still
  in the source for regression checks, but no longer shown.

**Conversion, annotations, and sync**

- PDF conversion commands and generated-artifact registration, including a versioned
  structured References JSON attachment produced from the PDF bibliography.
- Annotation export and Markdown injection.
- Runtime lifecycle, jobs, service notices, and templates.
- Manual and scheduled WebDAV sync for Project, Board, node, edge, and tombstone
  documents. Jianguoyun's URL is prefilled; its third-party application password lives in
  Zotero's Login Manager under an add-on-specific realm and never reaches preferences or
  sync packs. Automatic sync is opt-in, runs no more often than every 30 minutes, and can
  report errors only, every result, or nothing. A large first sync spans several runs and
  continues promptly between them.

Document conversion and annotation injection require `services/paper-runtime`. Everything
else runs without it.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/core/` | Static feature registry and lifecycle dispatch |
| `src/features/` | Conversion and annotation command orchestration |
| `src/modules/` | Item pane, metadata, relations, providers, cache, preferences |
| `src/modules/uniConnection.ts` | Derived reverse-reference index, coupling, graph topology |
| `src/modules/uniConnectionSync.ts` | Notifier-driven index maintenance and reference backfill |
| `src/projects/` | Versioned Project/Board/Paper shapes and local Project repository |
| `src/runtime-client/` | HTTP contracts, client, launch resolution, process state |
| `src/zotero/` | Zotero adapters, library scope, artifact identity |
| `src/ui/` | Menus, progress, service notices, panel and Unizero Home bridges |
| `addon/` | Manifest, locales, preferences, icons, dialog markup and scripts |
| `tests/` | Vitest suites for Projects, the derived index, graph builders, renderer facade, and Home dialog |

New Zotero mutations belong in `src/zotero`; new command orchestration belongs in
`src/features`. Do not rewrite `src/modules` as a single refactor. Extract a focused
responsibility when a feature change needs it.

## Dialog content

`addon/chrome/content/panel.js`, `literature-explorer.js`, and `literature-graph.js` are
plain JavaScript outside the TypeScript bundle: not compiled and not type checked. They
implement the runtime-backed template editor, the Home Board and relation browser, and the
shelved force-directed graph renderer/detail graph. Vitest loads the real Home XHTML and
plain scripts in `happy-dom`, with bridge and renderer mocks, to cover request ownership,
tab restoration, filtering, and renderer lifecycle. Zotero APIs, privileged-window
lifecycle, and the real canvas still require a manual Zotero check.

They reach the add-on only through the plain-object API passed as
`window.arguments[0].api`, built in `src/ui/literatureExplorer.ts` and `src/ui/panel.ts`.
New data for a dialog is added to that bridge and to its `views.ts` producer.

`vendor/force-graph.min.js` is a vendored MIT build with its license alongside it. Dialog
content must stay self-contained: no CDN, no external fetch.

Two graph constraints are easy to break and expensive to diagnose:

- force-graph invokes callbacks synchronously inside an animation loop that has no error
  handling, so one unguarded throw freezes the canvas for good. Keep every callback inside
  `guard()`.
- layout coordinates are only valid at the scale of the forces that produced them. The
  user's own force settings are covered by the signature stored with the layout; a code
  change that alters what a coordinate means is not, so bump `GRAPH_LAYOUT_VERSION` in
  `src/modules/views.ts` for that.

The rest of the graph's traps, and why the full-library view was retired, are in
[UNICONNECTION.md](../../docs/UNICONNECTION.md).

## Stored state

| State | Location |
| --- | --- |
| Per-item provider caches | `<Zotero data dir>/unizero/cache/` shard tree |
| Project and default Board documents | `<Zotero data dir>/unizero/projects/` typed object tree |
| Board paper/text nodes, content blocks, manual edges, geometry, and tombstones | Per-Board typed documents under `unizero/projects/` |
| Stable cache/pinned/Zotero Paper catalog and citation observations | `<Zotero data dir>/unizero/literature/` |
| Graph layout coordinates | `<Zotero data dir>/unizero/graph/<libraryID>.json` |
| Graph display and force settings | `<Zotero data dir>/unizero/graph/settings.json` |
| Zotero item ↔ Obsidian URL bindings | `<Zotero data dir>/unizero/markdown-links/<libraryID>.json` |
| Extracted PDF bibliography | Owned `ZoMiner References` Zotero JSON attachment (`unizero:references`) |
| Preferences | Zotero preference branch, defaults in `addon/prefs.js` |

The derived relation index is memory-only and rebuilt on demand. Explorer tabs are
per-window and not persisted. The small Preview snapshot LRU is also window-only.
Completed empty Citations lookups are saved as a 24-hour negative cache only when at
least one provider answered normally; an all-provider failure is retried next session.

## Runtime connection

The add-on uses `/api/v1` on `127.0.0.1`. Launch resolution is implemented in
`src/runtime-client/launch.ts` and checks, in order:

1. an explicitly configured server script;
2. an explicitly configured Python interpreter;
3. a `PATH` interpreter that can import `unizero_runtime`;
4. the `unizero-runtime` console command.

The selected port is passed to the child process.

The runtime's lifetime follows Zotero's. A main window load starts it in the background
after a short delay, and quitting Zotero stops it again; both steps are silent, and both
are governed by the automatic start and stop preferences. The panel therefore has no
service controls. A start that fails, or a service that stops answering mid-session,
appears as a notice in the panel's Jobs list, carrying a button to try the start again.

Add-on preferences live under *Settings → UniZero*; runtime-backed job and template
controls live in the UniZero panel.

## Build

```bash
npm ci
npm run check
npm test
npm run build
```

`npm run check` runs TypeScript and HTTP-contract drift checks. `npm test` runs the
Vitest suites, which cover the derived index and graph builders plus the host-independent
parts of the Explorer and graph renderer.
`npm run build` writes `build/unizero.xpi`.

## Release

Releases are published by `.github/workflows/release-zotero-addon.yml`. A pushed
`v*` tag must match the version in `package.json`; the workflow installs locked
dependencies, runs the add-on checks and tests, builds the XPI, and attaches
`build/unizero.xpi` to a GitHub Release as `unizero.xpi`.

From a clean `main` branch, create a release with:

```bash
npm run release -- patch
```

Use `minor` or `major` instead of `patch` when appropriate. `release-it` updates
`package.json` and `package-lock.json`, rebuilds the tracked `update.json`, commits the
version, creates the matching `v<version>` tag, and pushes it. GitHub Actions then owns
the GitHub Release, so no local GitHub token is required. Do not create a release tag
manually unless `update.json` has already been regenerated for that version.

## Run in Zotero

Copy `scripts/zotero-cmd-default.json` to the gitignored
`scripts/zotero-cmd.json`, then configure a Zotero executable and development profile.

```bash
npm run start-watch
```

For a packaged build, install `build/unizero.xpi` from Zotero's add-on manager.

Type checking does not verify Zotero APIs, window lifecycle, XUL, or the external dialogs.
Changes in those areas require a manual Zotero check.

## Related documentation

- [Documentation map](../../docs/README.md)
- [Repository architecture](../../docs/ARCHITECTURE.md)
- [Project structure](../../docs/PROJECT_STRUCTURE.md)
- [Unizero Home design](../../docs/UNIZERO_HOME.md)
- [Derived relation index and graph](../../docs/UNICONNECTION.md)
- [Legacy data support](../../docs/LEGACY_SUPPORT.md)
