# UniZero Zotero Add-on

The Zotero 8 application component. It owns Zotero lifecycle, UI, preferences,
scholarly-provider access, item and attachment mutations, the derived relation index, and
the client for the local paper runtime.

## Capabilities

- metadata candidate lookup and identifier updates;
- compact References and Citations item-pane previews plus Collection-level
  Unizero Home, available from the item-list toolbar, Collection context
  menu, and Tools. The item context menu opens the selected paper directly in its
  own detail tab. Papers open as tabs beside a pinned Project tab, so several
  can be read at once and returning to one costs no provider call. Transient
  Collection previews also reuse completed snapshots by library, item, and relation
  kind, so A → B → A does not rebuild A;
- one stable Project and default Board per Zotero Collection (or library root),
  keyed by portable Zotero scope and Collection key;
- a three-pane Project View: collapsible Collection paper list, pannable and zoomable
  Board, and collapsible References/Relation/Citations Detail View. Library papers can
  be dragged onto the Board more than once, producing independent card instances whose
  positions and deletion tombstones are persisted. Selected cards can be joined by
  persisted manual connections using four directional drag handles; curved connections
  are independently selectable and deletable. Text Nodes contain ordered, stable-ID
  content blocks; Collection papers can be embedded as PaperBlocks without creating
  another Zotero item, and a library-backed embedded block can be copied back out as a
  standalone paper card. References and Citations rows can also be dragged directly
  onto the Board: out-of-library results become durable pinned Papers without creating
  Zotero items. Hovering an identifiable library or external card temporarily
  highlights every related Board instance and draws derived relation hints without
  persisting manual edges. Paper and Text cards have a zoom-aware resize handle, and
  their updated geometry remains durable;
- Collection paper status for Markdown conversion and cached References/Citations,
  with per-paper quick actions and relation drill-down;
- a Relation view per paper: which library papers cite it, and which share the most of
  its references, both derived locally with no extra network access;
- graph views in the Explorer: a full-library graph that toggles with the management
  table and previews the existing References/Relation/Citations detail surface beside
  the graph without opening a paper tab when a node is selected, plus a graph tab per
  paper that centres the same graph on it, with adjustable display and force settings
  and a per-node menu for PDF, Markdown, and relation actions;
- filtering discovered works by library status, influence, year, publication type, and
  order, plus importing missing papers into the current library. Every loaded
  References/Citations candidate receives a stable catalog Paper ID with `cache`
  retention; Board pinning and Zotero binding promote the same Paper to `pinned` or
  `zotero`. Provider/query observations use one directed citation model. Successful
  terminal provider snapshots replace stale observations and collect orphaned
  cache-only Papers, while incomplete pages and provider failures preserve prior
  evidence. Explicit identity merges retain redirects for old Paper IDs;
- relating discovered works;
- PDF conversion commands and generated-artifact registration, including a versioned
  structured References JSON attachment produced from the PDF bibliography;
- annotation export and Markdown injection;
- runtime lifecycle, jobs, service notices, and templates.

Document conversion and annotation injection require
`services/paper-runtime`. Other features run without it.

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
- [Derived relation index](../../docs/UNICONNECTION.md)
- [Graph views](../../docs/UNICONNECTION_GRAPH.md)
- [Legacy data support](../../docs/LEGACY_SUPPORT.md)
