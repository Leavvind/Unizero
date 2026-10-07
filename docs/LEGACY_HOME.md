# Legacy: Unizero Home / Board

> **Product status:** Legacy. The Project View / Board still ships in the XPI and tests
> still load it, but it is not the product focus. Active work is the Obsidian plugin and
> the Zotero data plane. Do not extend Home unless a task names it explicitly.
>
> **Authority:** Behaviour and ownership rules that still apply system-wide live in
> [ARCHITECTURE.md](ARCHITECTURE.md) (Paper catalog, Project documents, sync). This file
> is only maintenance traps for the Home UI and its on-disk shapes.

## What still ships

- Entry: Tools menu, item-list toolbar, Collection context menu; item context menu can
  open a paper tab.
- One Project + default Board per Collection (or library root), subject =
  portable library scope + Collection key (never numeric `libraryID` / `collectionID`).
- Three-pane Project View: collection list, Board, References/Relation/Citations detail.
- Board: paper/text nodes, manual edges, geometry, tombstones; transient camera.
- Relation hints: derived overlay from UniConnection + catalog observations — never
  written as manual edges.

## On-disk shapes

```text
<Zotero data dir>/unizero/projects/     Project, Board, nodes, edges, tombstones
```

Implemented sync namespaces (`src/sync/types.ts`): `project.meta`, `project.board`,
`project.board-node`, `project.board-edge`. Literature namespaces and portable settings
are not wired — see [ROADMAP.md](ROADMAP.md) and
[SYNC_AND_LITERATURE_SOURCES.md](SYNC_AND_LITERATURE_SOURCES.md).

Node schema is a discriminated union: `kind: "paper"` (standalone paper shorthand) and
`kind: "text"` (ordered blocks with stable IDs). PaperBlocks store `paperID` only —
embedding does not copy metadata or create Zotero items.

## Code map

| Piece | Path |
| --- | --- |
| Window API bridge | `apps/zotero-addon/src/ui/literatureExplorer.ts` |
| Data producers | `apps/zotero-addon/src/modules/views.ts` |
| Board + detail UI | `addon/chrome/content/literature-explorer.js` (+ `.xhtml`) |
| Per-paper Graph tab | `addon/chrome/content/literature-graph.js` |
| Host-independent tests | `apps/zotero-addon/tests/literatureExplorerRace.test.ts` |

Dialog scripts are plain JS outside the TypeScript bundle. They only receive
`window.arguments[0].api` — never import bundle modules.

## Maintenance traps

1. **Async ownership.** Papers open as tabs but share one detail DOM. Capture context
   generation, tab, item key, kind, and request generation; write only to that owner
   while it is active. A context reload increments the generation and drops the old
   library’s in-flight work.
2. **Render vs interaction.** A Board refresh mid-gesture must defer rebuild (caret and
   drag targets live in the DOM).
3. **force-graph callbacks.** Every callback into the animation loop goes through
   `guard()`. One unguarded throw freezes the canvas permanently. Details:
   [UNICONNECTION.md](UNICONNECTION.md).
4. **Layout coordinates.** Valid only at the force scale that produced them. Bump
   `GRAPH_LAYOUT_VERSION` in `views.ts` when code changes coordinate meaning; user force
   settings are covered by the stored force signature.
5. **Board geometry is not graph layout.** Board positions are user-authored Project
   state (syncable). Graph layout under `unizero/graph/` is discardable display state.
   Do not mix namespaces.

## What not to do

- Do not add Board block kinds, deep nesting, or Canvas-like composition to the current
  Text Node model without an explicit product decision to revive Home.
- Prefer equivalent UX in the Obsidian plugin (library pane, paper pane, citations).
- Do not treat this document as a build plan. Unfinished product ideas for Home are
  out of the active roadmap.
