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
- **Item pane** (right): metadata, incoming document Links, References, Citations,
  and Relation. Uncached relations require an explicit **Fetch from providers**.
- **Search:** type `@` followed by author, title, or year. Insert and drag actions
  write `[Author, year](unizero://paper/libraryID/itemKey)`. Labels are ordinary
  Markdown: editing Zotero metadata never rewrites text already inserted in a note.
  The source-switch row searches Vault documents instead; `@vault query` selects
  that source directly. `↵` finishes the link. `Tab` or `Shift+↵` continue to Raw or PDF,
  and `#` or `^` go straight to the paper's Raw headings or blocks; the forms a Chinese
  IME writes for those keys (`＃`, `……`) work the same way.
  Sidebar insertion uses the active editor or the last open Markdown note. Dragging
  inserts plain citation text; native Canvas drag integration is not implemented.
- **Search the Zotero library** (command; give it a hotkey): the same search in a
  modal, from anywhere. `↵` opens the paper pane, `Mod+↵` the PDF in Zotero,
  `Shift+↵` Raw, and `Alt+↵` Canvas; each result also has **Insert**, **PDF**, **Raw**, and
  **Canvas** buttons. Choosing Raw for a paper without one offers to convert it.

| Link destination | Click action |
| --- | --- |
| `unizero://paper/1/HLP48L8X` | Open the Item pane |
| `unizero://paper/1/HLP48L8X.pdf?page=15` | Open physical PDF page 15 |
| `unizero://paper/1/HLP48L8X.md#Methods` | Open Raw at a heading |
| `unizero://paper/1/HLP48L8X.md#%5Eresult-01` | Open Raw at an existing block ID |
| `unizero://note/<vaultID>/<UID>#Methods` | Resolve a Vault document by UID, then locate a heading |

File links can include `attachment=<key>` to select an exact attachment of that
paper; missing explicit attachments never fall back to another file. Missing or
ambiguous text locations open the same file with a notice. There is no fuzzy
heading matching. Typing inside a destination completes it the way `[[` does: the
attachment after the item key, headings (marked H1 to H6, indented by level) and existing
block IDs after `.md` or `#` (`#^` for blocks only), and a page number after `.pdf`. Right-click for actions; **Choose location for the UniZero link
at the cursor** replaces only its destination and preserves the authored label.
Reading mode and live preview keep normal Markdown link rendering. Source text
remains editable; Ctrl/Cmd-click follows a source link.

`unizero://` is handled within Obsidian windows running this plugin. This does not
register an operating-system protocol. The optional application transport is
`obsidian://unizero?target=<encoded-unizero-uri>`.

## Vault identity and Backlinks

**UID source** defaults to the `uid` frontmatter property. Existing quoted strings
and lossless integer values are read without changing them. Filename identities
require an explicitly configured capture pattern. **Set current document UID** is
an explicit action for entering an existing UID; rendering never assigns one.
Duplicate UIDs report all candidates and stop navigation.

The logical **Vault identity** is stored in plugin settings. Sync those settings
between devices. **Treat as a new Vault…** is an explicit identity change for an
independent copy. Rename, move and index rebuild update only the UID-to-path mapping.
Other Vaults require opening the matching Vault; the plugin does not search disk.

**UniZero Backlinks** follows the last active Vault Markdown document, including
when a sidebar takes focus. It reports missing UIDs and conflicts instead of a
zero count. The Item pane's **Links** tab groups incoming links by Vault or Zotero
source, with context, location and per-file occurrence counts. Native wikilinks
and provider Citations remain separate.

## Document source coverage

Vault Markdown and supported Canvas text, group labels and edge labels are indexed
structurally; code, comments, image embeds, ordinary links and native wikilinks
are excluded. Legacy bare citations and UniZero links share target identities.
Library badges retain their Vault-only citation counts.

Enable **Index Zotero documents** to scan the bridge's declared local Raw, Canvas
and user Markdown/Canvas attachments, including unopened documents. **Source
libraries** restricts scope; empty means all non-feed libraries. This requires the
`link-sources` capability. The source directory and file states refresh every minute
with a single shared task. **Refresh links** reads what changed; **Rebuild document
links** reads and parses every document again.
Raw Backup and generated summaries are excluded. File reads and refreshes never
start conversion, sync downloads or provider queries.

Coverage, any unavailable sources and the time of the last successful Zotero scan
appear above the lists; hovering shows the scope and full date. Failed reads and interrupted scans retain stale records. A successful
empty read clears that source; only a complete directory scan removes deleted
sources. The versioned `link-index-v1.json` cache in the plugin directory is derived
and can be deleted. External Canvas opens its original file; when card navigation
is unavailable, a notice identifies the original card.

## Transition

**Transition legacy citations…** previews the current document, Vault, or explicitly
selected Zotero sources. Select files after reviewing counts, examples and skip
reasons. Unresolved metadata, code, existing links and incomplete citations remain
unchanged. No migration happens during rendering or indexing.

Apply rechecks current editor and file content. Changed files are skipped. Active
Markdown editors use undoable transactions. Originals and a journal are saved under the plugin's `transitions/` directory before edits. **Restore a
citation Transition…** restores matching files without replacing later edits.
Attachment replacements use a temporary sibling file and a final revision check;
missing files are never recreated. Canvas changes preserve unrelated JSON bytes.

Old `@libraryID/itemKey`, `.md`, `.pdf` and `.pdf:15` forms remain clickable and
indexed, with normal link styling. Stored `pillLabel` and `pillStyle` values are
preserved for compatibility but have no effect and no settings controls.

## Raw and conversion

Raw is the converted paper: a Markdown attachment of the Zotero item (tagged
`unizero:raw`), edited in place. The plugin opens it with the system's Markdown
application, as Zotero does — Obsidian, when it is the default for `.md` files.
A UniZero Markdown URI opens the attachment in Obsidian's own editor, at the heading
or block it names.

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

The file lives in Zotero's storage. Its links appear in **Links** when Zotero
source indexing is enabled. Vault files cannot be embedded in it by Vault path.

Canvas files linked by earlier versions stay where they were. Their paths remain in
this plugin's `data.json` (`canvasLinks`) for migration but are no longer opened.

## Canvas capture

MarginNote-style excerpting into Canvas text Cards and Markdown notes. A Zotero annotation

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
| Auto capture into the edited Card or note | A Zotero annotation copied in Zotero is inserted at the cursor of the Canvas Card or Markdown note being edited. |
| Selected Card paste and drop | `Cmd/Ctrl+V` or a text drop appends to the one selected text Card. |
| Off (default) | Nothing is captured. |

Click the `Capture:` status bar item to pick a mode from a menu. **Canvas capture:
Toggle auto capture** switches auto capture on and off and can take a hotkey; the
other **Canvas capture:** commands and Settings also switch modes.

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

Host verification is recorded in
[the design handoff](../../docs/UNIZERO_LINKS_DESIGN.md#15-本次施工与宿主验收记录).
Tests cover host-independent logic and mocked asynchronous workflows. Rendering,
search, panes, dialogs, and bridge calls need a manual check in a real vault against
Zotero.
