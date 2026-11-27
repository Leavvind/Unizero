# UniZero for Obsidian

Search Zotero papers, cite them in notes, and open their metadata, Raw Markdown,
Canvas, or PDF. Zotero remains canonical for bibliographic data; the plugin talks to
the local UniZero bridge and starts Zotero-side work only on explicit conversion or
Raw/Canvas actions.

## Requirements

Desktop Obsidian and a running Zotero 7+ with the UniZero add-on (`BRIDGE_API_VERSION` 2)
and Zotero's HTTP server enabled (`extensions.zotero.httpServer.enabled`).

## Development

```bash
(cd ../../packages/links && npm ci)  # shared link parser, linked as a file dependency
npm install
npm run check
npm test
npm run build
```

`npm run dev` watches for changes. Copy or symlink `manifest.json`, `main.js`, and
`styles.css` into `<vault>/.obsidian/plugins/unizero/`, then reload the plugin.
Code layout: [PROJECT_STRUCTURE.md](../../docs/PROJECT_STRUCTURE.md#obsidian-default-product-surface).
Rendering, search, panes, dialogs, and bridge calls require a manual check against a
running Zotero; open host checks live in
[UNIZERO_LINKS_DESIGN.md](../../docs/UNIZERO_LINKS_DESIGN.md#宿主验收记录).

## Use

- **Library pane** (tab): browse libraries and collections (subcollections included by
  default; remembers last collection; Canvas badge when present); right-click a paper to
  insert a citation or open files; arrow/Page/Home/End keys navigate the list.
- **Item pane** (right): metadata and three tabs.
  - **References** (links out of this paper's Raw and Canvas) / **Citations** (links into
    this paper), each in two groups: **Papers** — between papers' Raw and Canvas — and
    **Notes** — Vault notes this paper links to, or Vault notes, other Markdown
    attachments and the paper's own notes linking to it. Each passage shows its
    paragraph, opens its note, and offers **PDF** for any `zotero://open-pdf` link in the
    same paragraph. Links in Raw and Canvas need **Index Zotero documents**.
  - **Bibliography**: provider References, Citations, and Relation (uncached lists wait
    for explicit **Fetch from providers**).
- **`@` search:** type `@` plus author, title, or year (`@zotero` or `@vault` restricts
  the source). Insert and drag write `[Author, year](unizero://paper/libraryID/itemKey)`
  as plain Markdown labels never rewritten by Zotero edits.
  - `[your words](@query)` keeps your label; `[](@query)` fills it; **Link selection to a
    paper or document…** wraps selected text directly.
  - `↵` finishes; `Tab` / `Shift+↵` continues to `.md` or `.pdf`; `#` or `^` (`＃` / `……`
    in Chinese IMEs) continues to headings or blocks.
  - `-@` inserts the same link with the title `"nocite"`: it opens as usual and renders
    as a grey dashed tag, but counts as no reference, citation, or backlink.
- **Search the Zotero library** (modal command): `↵` Item pane, `Mod+↵` PDF, `Shift+↵`
  Raw (offers conversion if missing), `Alt+↵` Canvas, plus row action buttons.
- **Link styling:** violet badge for paper links, teal dotted underline for Vault links,
  grey dashed tag for `nocite` links in Live Preview, Reading view, and Canvas (Source mode stays plain; styling never fetches
  metadata).

| Link destination | Click action |
| --- | --- |
| `unizero://paper/1/HLP48L8X` | Open the Item pane |
| `unizero://paper/1/HLP48L8X.pdf?page=15` | Open physical PDF page 15 |
| `unizero://paper/1/HLP48L8X.md#Methods` | Open Raw at an exact heading |
| `unizero://paper/1/HLP48L8X.md#%5Eresult-01` | Open Raw at block ID `^result-01` (supports `text^id` without space) |
| `unizero://paper/1/HLP48L8X.md?attachment=ABCD1234#Methods` | Open a specific Markdown attachment (404 if missing, never falls back) |
| `unizero://note/<vaultID>/<UID>#Methods` | Resolve a Vault document by UID, then locate a heading |

Missing/ambiguous anchors or unfinished suffixes (`.md^`, `.md#^`) still open the target
file with a notice. Destination autocomplete suggests attachments, headings, block IDs,
and pages; **Choose location for the UniZero link at the cursor** updates the URI while
keeping the label and title (a `-@` link stays render-only). `unizero://` is internal to Obsidian; external callers use
`obsidian://unizero?target=<encoded-unizero-uri>`. Bare `@libraryID/itemKey` tokens from
pre-0.11.0 are plain text.

## Vault identity, Backlinks, and source indexing

- **UIDs & Vault ID:** defaults to frontmatter `uid` (opaque string; filename UIDs need a
  capture pattern and are never written). Linking to a UID-less note or running **Set
  current document UID** assigns a unique `YYYYMMDDHHmmss` timestamp; duplicate UIDs halt
  navigation and list candidates. Sync settings across devices to share `vaultID`, or run
  **Treat as a new Vault…** for an independent copy.
- **UniZero Backlinks:** follows the last active Vault note, combining UniZero links with
  Obsidian's resolved native links (wikilinks, embeds, Markdown, properties); when a
  Zotero attachment is active, shows links into its parent paper instead. A collapsed
  **Unlinked mentions** section scans Vault notes on demand for title/alias matches (CJK
  substring-aware) with one-click **Link**.
- **UniZero Outgoing links:** the forward counterpart, following the same document. It
  groups what the note links to under **Papers**, **Notes** (UniZero and native links to
  the same note share one group), and **Unresolved** (missing, duplicate, or other-Vault
  UIDs; native links to notes not created yet). A header follows the link; a row jumps to
  where it is written, and its target text (Raw, PDF page, heading, block) follows that
  exact target. The note needs no UID of its own. A collapsed **Unlinked mentions**
  section matches other notes' titles and aliases in this note; **Link** assigns the
  target a UID if needed. For an indexed Zotero attachment it lists the attachment's
  UniZero links. Render-only `-@` links are not listed.
- **Source coverage:** indexes Vault Markdown and Canvas text/group/edge labels
  incrementally (background worker for large files; `link-index-v1.json` is disposable).
  Enabling **Index Zotero documents** also scans local Raw, Canvas, and ordinary
  Markdown/Canvas attachments every minute via `/link-sources` (re-reading known local
  files even while Zotero is closed, without starting conversions or provider calls).
- **Show Vault notes in Zotero** (on by default; turning it off clears this Vault's notes
  from Zotero): after the Vault index settles, the
  plugin sends Zotero the paper links in Vault notes, with their paragraphs, so Zotero's
  Uniconnection lists those notes among a paper's Citations. Only changes are sent;
  Clicking a note in Zotero comes back through `obsidian://unizero` and opens it at its
  first mention's line or Canvas card. A Zotero mention's **Canvas** button opens the
  paper's Zotero Canvas here, found through the bridge, with that card selected.

## Raw, Canvas, and capture

- **Raw (`unizero:raw`) & Convert:** Convert runs **Default conversion template** (falling
  back to the add-on's default) to create Raw and Raw Backup; re-converting updates only
  Raw Backup so user edits in Raw survive.
- **Canvas (`unizero:canvas`):** created empty on first click in Zotero storage and opened
  with the system `.canvas` handler (legacy `canvasLinks` in `data.json` remain unread for
  migration).
- **Managing files:** right-click **Raw**, **Canvas**, or citation/library menus to
  re-convert (default or chosen template), **Restore Raw from Raw Backup**, or move Raw /
  Canvas to Zotero's trash (all destructive-looking actions confirm first and use Zotero
  trash). Never rename or delete files directly inside Zotero's `storage/` folder.
- **Canvas capture:** converts copied/dropped Zotero annotations into `Quoted text [Author, year](zotero://open-pdf/...)`
  (plus comment). Modes via `Capture:` status bar, commands, or Settings: **Auto capture
  into the edited Card or note**, **Selected Card paste and drop**, or **Off** (default).
