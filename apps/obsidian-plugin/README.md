# UniZero for Obsidian

Search Zotero papers, cite them in notes, and open their metadata, Raw Markdown,
Canvas, or PDF. Zotero remains the source of bibliographic data; the plugin reads
the local UniZero bridge. Only explicit conversion starts a Zotero-side job.

## Requirements

Desktop Obsidian and running Zotero 7+ with the UniZero add-on. Zotero's HTTP
server must be enabled (`extensions.zotero.httpServer.enabled`).

## Use

- **Library pane** (left): browse libraries and collections; right-click a paper
  to insert a citation or open its files. The last collection is remembered.
- **Paper pane** (right): metadata, vault citation locations, References, Citations,
  and Relation. Uncached relations require an explicit **Fetch from providers**.
- Type `@` followed by author, title, or year to search. Insert and drag actions
  write `@libraryID/itemKey`; citation labels and appearance are configurable.
  Sidebar insertion uses the active editor or last open Markdown note. Dragging
  inserts plain citation text; native Canvas drag integration is not implemented.

| Citation | Click action |
| --- | --- |
| `@1/HLP48L8X` | Open the paper pane |
| `@1/HLP48L8X.md` | Open Raw Markdown |
| `@1/HLP48L8X.pdf` | Open the PDF in Zotero |
| `@1/HLP48L8X.pdf:15` | Open physical PDF page 15 |

Right-click a citation for Raw, Canvas, PDF, or conversion. Raw files are located
using the configured folder and identity frontmatter; missing converted files can
be linked manually. Conversion progress appears in Zotero's UniZero panel.

## Canvas

The first click creates, binds, and opens an empty `<paper title>.canvas` in
Obsidian's configured new-note location. Filenames are sanitized and shortened as
needed; unusable titles fall back to `Paper libraryID-itemKey`. Name collisions
get a numbered suffix, preserving existing files.

Bindings follow file and parent-folder renames/moves while UniZero is enabled and
persist across restarts. Changes while Obsidian is closed or UniZero is disabled
cannot be tracked; missing files prompt you to select a Canvas again.

## Development

Run from this directory:

```bash
npm install
npm run check
npm test
npm run build
```

`npm run dev` watches for changes. Copy or symlink `manifest.json`, `main.js`, and
`styles.css` into `<vault>/.obsidian/plugins/unizero/`, then reload the plugin.

Tests cover host-independent logic and mocked asynchronous workflows. Rendering,
search suggestions, panes, bridge calls, Canvas creation, and rename persistence
still require manual checks in a real vault against Zotero.
