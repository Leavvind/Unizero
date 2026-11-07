# Legacy: Unizero Home

> **Product status:** Legacy. Home ships in the XPI and tests still load it, but it is
> not the product focus. Active work is the Obsidian plugin and the Zotero data plane.
> Do not extend Home unless a task names it explicitly.
>
> **Authority:** Behaviour and ownership rules that apply system-wide live in
> [ARCHITECTURE.md](ARCHITECTURE.md). This file is only maintenance traps for the Home
> window.

## What still ships

- A tabbed window with one tab per open paper. Each tab shows that paper's References,
  Relation, or Citations table, with source, library-status, influence, year,
  publication-type and order filters, per-source refresh, and import of missing papers.
- Entry: the item pane's "View all references / citations" links and the item context
  menu. Opening another paper of the same library adds a tab; opening one from another
  library replaces the tabs. Closing the last tab closes the window.
- No provider call on open: a paper with nothing cached shows a fetch prompt.

The Project View, Board, per-paper Graph tab and their stores were removed. Their files
under `<Zotero data dir>/unizero/` (`projects/`, `graph/`, `external/`) are no longer
read and are not deleted by the add-on.

## Code map

| Piece | Path |
| --- | --- |
| Window API bridge | `apps/zotero-addon/src/ui/literatureExplorer.ts` |
| Data producers | `apps/zotero-addon/src/modules/views.ts` |
| Tabs and detail UI | `addon/chrome/content/literature-explorer.js` (+ `.xhtml`) |
| Host-independent tests | `apps/zotero-addon/tests/literatureExplorerRace.test.ts` |

The dialog script is plain JS outside the TypeScript bundle. It only receives
`window.arguments[0].api` — never import bundle modules.

## Maintenance traps

1. **Async ownership.** Papers open as tabs but share one detail DOM. Capture context
   generation, tab, and request generation; write only to that owner while it is
   active. Reopening the window for another library increments the generation and drops
   the old library's in-flight work.
2. **Library scope.** Tabs are keyed by item key, which is unique only within a library.
   Every API call passes the tab's `libraryID`; never resolve a key against whatever
   library the window was last opened for.

## What not to do

- Prefer equivalent UX in the Obsidian plugin (library pane, paper pane, citations).
- Do not treat this document as a build plan. Unfinished product ideas for Home are
  out of the active roadmap.
