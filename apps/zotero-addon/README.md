# UniZero Zotero Add-on

The Zotero backend for UniZero: owns Zotero lifecycle, preferences, scholarly-provider
access, item and attachment mutations, the derived relation index, the localhost bridge
used by Obsidian and the MCP server, and the client for the local paper runtime.

## Capabilities

**Bridge (`src/server/`)**

- Loopback endpoints under `/unizero/v1/*` on Zotero’s HTTP server.
- Read-only discovery for libraries, collections, papers, PDFs, `unizero:<kind>` and
  linkable Markdown/Canvas attachments, cached relations + excerpts, citekeys, and running
  runtime templates; non-destructive POSTs for conversion and a paper's own Raw / Canvas
  attachments.
- Contract and endpoint table: [Bridge contract](../../docs/ARCHITECTURE.md#bridge-contract).

**Literature data & UniConnection**

- Metadata candidate lookup and identifier updates.
- **Item-pane References / Citations** (`src/ui/literatureSidebar.ts`): unified search
  across the list and library, `+` import, and drag-and-drop citation excerpts from PDF
  highlights or selected text; local-only Citations (`excerptsAbout` + `relationsOf`).
- **UniConnection full** (`src/ui/uniConnectionFull.ts`, ⤢ button or item menu): uncapped
  side-by-side References and Citations in a standalone window that follows the active
  tab until pinned, plus opt-in provider Citations.
- **Unizero Home** (`src/ui/unizeroHome.ts`, items toolbar button): library/collection
  activity tab pairing papers worked on (left) with papers quoted via hand-attached
  excerpts (right), with quick jumps to PDF, Raw, Canvas (created on demand), and
  UniConnection full.
- Durable Paper catalog (`src/projects/`): [Paper catalog](../../docs/ARCHITECTURE.md#paper-catalog).

**Conversion and annotations**

- PDF and EPUB conversion commands (`conversion.defaultTemplate`, default `Journal Papers`;
  use `Books EPUB` for EPUBs) and `ZoMiner References` (`unizero:references`) extraction.
- **Raw** (`unizero:raw`, user-edited working copy, created once and never overwritten)
  and **Raw Backup** (`unizero:raw-backup`, replaced on each conversion), with sibling
  `attachments/` images — one pair per PDF when a paper has supplements.
- Annotation export, vault Markdown injection, and runtime job/template management.

Document conversion and annotation injection require `services/paper-runtime`; everything
else runs inside Zotero alone.

Where files live and how external dialogs (`addon/chrome/content/`) are wired:
[PROJECT_STRUCTURE.md](../../docs/PROJECT_STRUCTURE.md#zotero-data-plane-bridge-and-runtime)
and [Zotero constraints](../../AGENTS.md#zotero-constraints).

## Stored state

| State | Location |
| --- | --- |
| Per-item provider caches | `<Zotero data dir>/unizero/cache/` shard tree |
| Paper catalog and citation observations | `<Zotero data dir>/unizero/literature/` |
| Zotero item ↔ Obsidian URL bindings | `<Zotero data dir>/unizero/markdown-links/<libraryID>.json` |
| Extracted PDF bibliography | Owned `ZoMiner References` JSON attachment (`unizero:references`) |
| Citation excerpts | Child note of the citing paper tagged `unizero:excerpts` |
| Preferences | Zotero preference branch, defaults in `addon/prefs.js` |

The derived relation index is memory-only. Empty Citations responses are cached for 24h
only when at least one provider answered normally. Resident in-memory caches are small and
bounded; evicted entries reload from disk when disk caching is enabled.

## Runtime connection

Talks to `/api/v1` on `127.0.0.1`. Launch resolution (`src/runtime-client/launch.ts`)
checks: configured server script → configured Python → `PATH` Python importing
`unizero_runtime` → `unizero-runtime` command. Delayed auto-start on window load and
auto-stop on quit follow user preferences; startup errors appear in the panel's Jobs list.

## Build

```bash
npm ci
npm run check
npm test
npm run build
```

`npm run check` runs TypeScript and HTTP-contract drift checks; `npm test` runs Vitest;
`npm run build` packages `build/unizero.xpi`.

## Release

Published by `.github/workflows/release-zotero-addon.yml` from a clean `main` branch:

```bash
npm run release -- patch # or minor | major
```

A `v*` tag releases both the Zotero add-on and the Obsidian plugin (`scripts/sync-obsidian-version.mjs`
keeps versions locked; plugin tests fail on mismatch). Never tag manually without
regenerating `update.json`.

## Run in Zotero

Copy `scripts/zotero-cmd-default.json` to gitignored `scripts/zotero-cmd.json`, set your
Zotero binary and dev profile, and run `npm run start-watch` (or install
`build/unizero.xpi`). Privileged Zotero APIs, lifecycle, XUL/XHTML, and providers always
require a manual Zotero check.
