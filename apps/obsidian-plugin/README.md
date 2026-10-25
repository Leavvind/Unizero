# UniZero for Obsidian

Search Zotero papers, cite them in notes, and open their metadata, Raw Markdown,
Canvas, or PDF. Zotero remains the source of bibliographic data; the plugin reads
the local UniZero bridge. Only an explicit conversion starts a Zotero-side job.

## Requirements

Desktop Obsidian and a running Zotero 7+ with the UniZero add-on; both must speak
bridge API 2. Zotero's HTTP server must be enabled
(`extensions.zotero.httpServer.enabled`).

## Use

- **Library pane** (opens in a tab): browse libraries and collections; right-click a
  paper to insert a citation or open its files. The last collection is remembered.
  The folder-tree toolbar button (on by default) also lists the papers of every
  subcollection, like Zotero's "Show Items from Subcollections". Papers with a
  Canvas carry a Canvas badge.
- **Paper pane** (right): metadata, vault citation locations, References, Citations,
  and Relation. Uncached relations require an explicit **Fetch from providers**.
- **Search:** type `@` followed by author, title, or year. Insert and drag actions
  write `@libraryID/itemKey`; citation labels and appearance are configurable.
  Sidebar insertion uses the active editor or the last open Markdown note. Dragging
  inserts plain citation text; native Canvas drag integration is not implemented.

| Citation | Click action |
| --- | --- |
| `@1/HLP48L8X` | Open the paper pane |
| `@1/HLP48L8X.md` | Open the Raw Markdown |
| `@1/HLP48L8X.pdf` | Open the PDF in Zotero |
| `@1/HLP48L8X.pdf:15` | Open physical PDF page 15 |

Right-click a citation for Raw, Canvas, PDF, conversion, and the management actions
below.

## Raw and conversion

Raw is the converted paper: a Markdown attachment of the Zotero item (tagged
`unizero:raw`), edited in place. The plugin opens it with the system's Markdown
application, as Zotero does — Obsidian, when it is the default for `.md` files.

**Convert** is the main action while a paper has no Raw; its progress appears in
Zotero's UniZero panel. It runs the **Default conversion template** setting, which
unless set follows the add-on's **Default template** (Journal Papers). To pick a template for one
paper, right-click the paper pane's Convert button or choose **Convert with
template…** in a menu; the list appears once the paper runtime is running. Only a
template that publishes to Zotero creates a Raw. Converting again never overwrites
Raw; it replaces the Raw Backup attachment.

## Canvas

A paper's Canvas is a `.canvas` file attached to the Zotero item (tagged
`unizero:canvas`), so it travels with Zotero file sync. The first click on Canvas —
in the paper pane, the library pane, or a citation menu — asks Zotero to create an
empty `<paper title>.canvas`; every click then opens that file with the system's
handler for `.canvas`.

The file lives in Zotero's storage, not in the vault: citations inside it are not
listed in the paper pane's Vault tab, and vault files cannot be embedded in it by
vault path.

Canvas files linked by earlier versions stay where they were. Their paths remain in
this plugin's `data.json` (`canvasLinks`) for migration but are no longer opened.

## Canvas capture

MarginNote-style excerpting into Canvas text Cards. A Zotero annotation

```text
“Quoted text” ([Smith et al., 2024, p. 17](zotero://open-pdf/...))
```

becomes

```text
Quoted text [Smith et al., 2024](zotero://open-pdf/...)
```

The `open-pdf` link is preferred when present; an annotation comment follows on a new line.

| Mode | Behaviour |
| --- | --- |
| Editing Card auto capture | A Zotero annotation copied in Zotero is inserted at the cursor of the Card being edited. |
| Selected Card paste and drop | `Cmd/Ctrl+V` or a text drop appends to the one selected text Card. |
| Off (default) | Nothing is captured. |

Switch modes in Settings, from the `Capture:` status bar item, or with the
**Canvas capture:** commands.

## Managing Raw and Canvas

In the paper pane, click **Raw** or **Canvas** to open it and right-click it for its
actions. Right-clicking **Convert** offers the restore when only a Raw Backup is
left. Citation and library-pane menus list every action that applies to the paper:

| Action | Effect |
| --- | --- |
| Re-convert (keeps Raw, updates Raw Backup) | Runs conversion again with the default template. Raw is not touched. |
| Re-convert with template… | The same, with a template picked from a second menu. |
| Restore Raw from Raw Backup | Replaces Raw with a copy of Raw Backup, then opens it. The old Raw goes to Zotero's trash. |
| Move Raw to Zotero trash | The next conversion creates a new Raw. |
| Move Canvas to Zotero trash | The next Canvas click creates a new empty Canvas. |

When a Raw or Canvas file is missing on this machine, the plugin offers to show the
attachment in Zotero (so sync can finish) or to replace it: restore or convert again
for Raw, a new empty file for Canvas.

Every action that replaces or removes a file asks first, and nothing is erased; a
trashed Raw or Canvas can be restored from Zotero's trash. Renaming the attachment or
its file in Zotero is safe. Renaming or deleting the file directly in the storage
folder is not; use the actions above instead.

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
search, panes, dialogs, and bridge calls need a manual check in a real vault against
Zotero.
