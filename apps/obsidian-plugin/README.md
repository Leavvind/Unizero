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
| `@1/HLP48L8X.md` | Open the Raw Markdown |
| `@1/HLP48L8X.pdf` | Open the PDF in Zotero |
| `@1/HLP48L8X.pdf:15` | Open physical PDF page 15 |

Right-click a citation for Raw, Canvas, PDF, or conversion. Raw is the converted
paper, stored as a Markdown attachment of the Zotero item (tagged `unizero:raw`)
and edited in place. The plugin opens its file with the system's Markdown
application, as Zotero does — Obsidian, when it is the default for `.md` files.
When the file is not on this machine, the attachment is selected in Zotero
instead. Conversion is offered only when the paper has no Raw, and its progress
appears in Zotero's UniZero panel. Convert runs the **Default conversion template**
setting (Zotero's default, `paper-to-zotero-markdown`, unless you pick another);
right-click the paper pane's Convert button, or choose **Convert with template…** in
a menu, to pick a template for one paper. The list comes from the paper runtime and
appears once it runs. Only a template that publishes to Zotero creates the Raw that
Obsidian opens. Re-converting never overwrites Raw; it replaces the Raw Backup attachment.

The add-on and this plugin must both speak bridge API 2.

## Canvas

A paper's Canvas is stored like Raw: a `.canvas` file attached to the Zotero item
(tagged `unizero:canvas`), which travels with Zotero file sync. The first click in
the paper pane, the library pane, or a citation menu asks Zotero to create an empty
`<paper title>.canvas` attachment; every click then opens that file with the
system's handler for `.canvas` — the same as opening it from Zotero. When the file
is not on this machine, the attachment is selected in Zotero instead. The library
pane marks papers that have one with a Canvas badge.

The file lives in Zotero's storage, not in the vault, so citations inside it are not
part of the vault index and other vault files cannot be embedded in it by vault path.

Canvas files linked by earlier versions stay where they were; their paths remain in
this plugin's `data.json` (`canvasLinks`) for migration, but are no longer opened.

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
search suggestions, panes, bridge calls, and Canvas creation and opening still
require manual checks in a real vault against Zotero.
