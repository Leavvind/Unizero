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
When the file is not on this machine, you can show the attachment in Zotero (to
let sync finish), restore Raw from Raw Backup, or convert again. Convert is the
main action while the paper has no Raw, and its progress appears in Zotero's
UniZero panel. Convert runs the **Default conversion template**
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
is not on this machine, you can show the attachment in Zotero (to let sync
finish) or start a new empty Canvas. The library pane marks papers that have one
with a Canvas badge.

The file lives in Zotero's storage, not in the vault, so citations inside it are not
part of the vault index and other vault files cannot be embedded in it by vault path.

Canvas files linked by earlier versions stay where they were; their paths remain in
this plugin's `data.json` (`canvasLinks`) for migration, but are no longer opened.

## Managing Raw and Canvas

In the paper pane, click **Raw** or **Canvas** to open it and right-click it to
manage it: Raw's menu holds the Raw actions below, Canvas's menu its trash action.
When the paper has no Raw but still has a Raw Backup, right-clicking **Convert**
also offers the restore. A citation's menu and the library pane's menu list all of
them, as far as the paper has a Raw, a Raw Backup, or a Canvas:

| Action | Effect |
| --- | --- |
| Re-convert (keeps Raw, updates Raw Backup) | Runs conversion again with the default template. Raw is not touched. |
| Re-convert with template… | The same, with a template picked from a second menu. |
| Restore Raw from Raw Backup | Replaces Raw with a copy of Raw Backup, the latest conversion, then opens it. The old Raw goes to Zotero's trash. |
| Move Raw to Zotero trash | The next conversion creates a new Raw. |
| Move Canvas to Zotero trash | The next Canvas click creates a new empty Canvas. |

Everything that replaces or removes a file asks first, and nothing is erased: restore
a trashed Raw or Canvas from Zotero's trash. In Zotero itself, renaming the attachment
or its file (with Zotero's Rename File) changes nothing for UniZero; renaming or
deleting the file in the storage folder directly does, so use the actions above.

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
search suggestions, panes, dialogs, bridge calls, and Canvas and Raw management
still require manual checks in a real vault against Zotero.
