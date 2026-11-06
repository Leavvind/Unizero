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
  Paper links have a small document badge and a subtle violet background in reading
  view, Canvas and Live Preview; Vault document links get a quieter teal label with
  a dotted underline. Placing the cursor inside a link reveals native
  Markdown for editing; Source mode stays plain. Styling never loads paper metadata.
  A plain `@` query also lists up to five matching Vault documents after the
  papers; `@vault query` or `@zotero query` restricts the search to one source, and
  the source-switch row swaps between them. Inside a link destination,
  `[your words](@query)` writes only the URL and keeps your label; `[](@query)`
  fills the label too. So Obsidian's **Add external link** (`[selection]()`, caret
  in the parentheses) followed by `@` links any text, and **Link selection to a
  paper or document…** does both steps at once. `↵` finishes the link. `Tab` or `Shift+↵` continue to Raw or PDF,
  and `#` or `^` go straight to the paper's Raw headings or blocks; the forms a Chinese
  IME writes for those keys (`＃`, `……`) work the same way.
  Sidebar insertion uses the active editor or the last open Markdown note; dragging
  a paper inserts the same link.
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

`attachment=<key>` selects one attachment of the paper and never falls back to
another file. A missing or ambiguous heading or block opens the file with a notice;
headings match exactly. Typing inside a destination completes it the way `[[` does:
the attachment after the item key, headings and block IDs after `.md` or `#` (`#^`
for blocks only), and a page number after `.pdf`. Right-click for actions; **Choose
location for the UniZero link at the cursor** replaces the destination and keeps the
label. In source mode, Ctrl/Cmd-click follows a link.

`unizero://` works only inside Obsidian with this plugin; it is not an
operating-system protocol. From outside, use
`obsidian://unizero?target=<encoded-unizero-uri>`.

## Vault identity and Backlinks

**UID source** defaults to the `uid` frontmatter property, read as written; a
filename UID needs an explicit capture pattern. **Set current document UID**, or
linking to a note that has none, writes a local `YYYYMMDDHHmmss` timestamp to the
property without asking, a second later for each one the Vault already uses; a
note that has a UID keeps it. Filename UIDs are never written. Duplicate UIDs
list every candidate and stop navigation.

The **Vault identity** lives in plugin settings, so sync them between devices;
**Treat as a new Vault…** gives an independent copy its own. Renaming or moving a
note keeps its links. Links into another Vault open only in that Vault.

**UniZero Backlinks** follows the last active Vault note and lists every incoming
link in one place: UniZero links and Obsidian's own links (wikilinks, embeds,
Markdown links to the note, and links in properties), each row labelled with its
form. Obsidian's links come from what Obsidian has already resolved, so they need no
UID; a missing UID or a UID conflict is reported and hides only the UniZero links.
A source whose links Obsidian counted without a position, such as a Canvas, is listed
as a whole file. Wikilinks written in Zotero documents are not read. With a Zotero
attachment such as Raw open, the pane lists the links into its paper instead, with a
button to its Item pane.

Below the links, a collapsed **Unlinked mentions** section lists plain-text
occurrences of the note's title or frontmatter aliases in other Vault notes, ignoring
case, existing links, code, comments and frontmatter. Words in space-separated
scripts must match whole; Chinese or Japanese titles also match inside a sentence.
Each source note starts collapsed to its name and count; expand it to see every
mention in context with the match highlighted. Notes are read only while the section
is open, and a note is read again only after it changes. **Link**, shown on hover,
replaces one mention with a UniZero link to the note, assigning
the note a UID first if it has none. Zotero documents are never scanned for mentions.
Both panes refresh automatically and show nothing when
there are no links; the index status and **Rebuild** are in Settings. The Item pane's
**Links** tab groups incoming UniZero links by Vault or Zotero source, with context
and per-file counts. Provider Citations are not included.

## Document source coverage

Links are indexed in Vault Markdown and in Canvas text cards, group labels and edge
labels; links inside code and comments are ignored. Library badges count Vault links
only.

**Index Zotero documents** also reads local Raw, Canvas and other Markdown/Canvas
attachments, opened or not (Raw Backup and generated summaries excluded). **Source
libraries** limits it; empty means all non-feed libraries. It refreshes every
minute; **Rebuild document links** re-reads everything. Indexing never converts,
downloads or queries providers.

Settings shows coverage, unavailable sources and the last successful Zotero scan.
A file that cannot be read keeps its previous links, marked stale. The
`link-index-v1.json` cache in the plugin folder can be deleted at any time. A link
into a Zotero Canvas opens that file; when the card cannot be focused, a notice
names it.

## Older citation forms

Bare `@libraryID/itemKey` tokens (with `.md`, `.pdf` or `.pdf:15`) are plain text
after 0.11.0. Convert them first with 0.11.0's **Transition legacy citations…**.

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
