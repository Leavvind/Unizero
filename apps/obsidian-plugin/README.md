# UniZero for Obsidian

The **active note-taking front end** of UniZero: free-text search, durable citations, and
jumps into the same Zotero library the add-on manages.

The plugin stores no bibliographic data. Zotero, the reference cache, and the Paper
catalog all live in the [Zotero add-on](../zotero-addon); this is a view of them over
the add-on’s localhost bridge. One side-effect is allowed: **Convert to Markdown**
posts to the bridge and runs the same conversion job as Zotero’s item menu. Importing
explored papers or other library write-back still needs a separate design.

## Sidebars

| Command | Side | Role |
| --- | --- | --- |
| **Open the library pane** | Left | Pick a library/collection, browse items, open a paper |
| **Open the paper pane** | Right | Metadata, References, Citations, Relation |

The library pane can switch libraries and collections inside Obsidian; the last choice
is remembered across sessions. Click a row to open it in the paper pane; right-click for
insert / PDF / note / convert.

**Insert & drag.** *Insert citation* (library context menu or paper-pane Relation row)
writes `@libraryID/itemKey` into the **last Markdown note you had open**, even while a
sidebar holds focus. You can also **drag** a library row, the paper-pane header, or an
in-library Relation row onto the note body (plain `@libraryID/itemKey` text via
DataTransfer). Native Canvas / `app.dragManager` integration is not implemented.

## Syntax

| Written | Click does |
| --- | --- |
| `@libraryID/itemKey` | Opens the paper pane: metadata, References, Citations, Relation |
| `@libraryID/itemKey.md` | Opens the converted Markdown note in this vault |
| `@libraryID/itemKey.pdf` | Opens the PDF in Zotero |

Example: `@1/HLP48L8X`. Right-clicking a pill offers the paper pane, Markdown note,
**Convert to Markdown**, and PDF. *Show in Zotero* was removed — *Open PDF in Zotero*
already jumps to the item when no PDF is attached. `\@notacitation` escapes the
syntax, and email addresses are never matched.

**Open Markdown note** and **Convert to Markdown** are exclusive: if Zotero (or this
vault) already has Markdown for the paper, only Open is shown; otherwise only Convert.
Conversion runs in Zotero (UniZero panel); when it finishes, open the note again.
Re-conversion stays on the Zotero item menu.

The pill label defaults to **Author (year)** (or title). What is written in the
source is the durable Zotero identity; you rarely need to read it.

## Finding a paper (`@` completion)

Typing `@` opens a completion list backed by the Zotero library. The query is
**free text**: author names, title words, years, and citekey fragments all match,
and every word in a multi-word query must hit somewhere.

| You type | What happens |
| --- | --- |
| `@richardson` | Author / title / citekey / year search |
| `@richardson accounting` | Multi-word search (spaces stay inside the query) |
| pick a hit | Inserts `@libraryID/itemKey` into the note |

Search is how you *find* a paper; `libraryID/itemKey` is what gets *written*.

## Identity

| Role | What it is |
| --- | --- |
| **Search** | Free text at the `@` prompt |
| **Written address** | `@libraryID/itemKey` in the note — durable, unambiguous across libraries |
| **Display** | Author (year) / title on the pill; citekey may appear in the detail pane as metadata |

A citekey (pinned in Extra or derived from metadata) is still useful for search and
display. It is **not** the link: editing a title in Zotero can change a derived
citekey, but never the item key.

## Requirements

- Zotero 7 or later, running, with the UniZero add-on installed.
- Zotero’s HTTP server enabled (it is by default; `extensions.zotero.httpServer.enabled`).
- Desktop Obsidian. The plugin talks to `127.0.0.1` and opens `zotero://` links, neither
  of which exists on mobile.

## Development

```bash
npm install
npm run check
npm test
npm run build
```

`npm run dev` starts esbuild in watch mode. To try it in a vault, symlink or copy this
directory’s `manifest.json`, `main.js`, and `styles.css` into
`<vault>/.obsidian/plugins/unizero/`.

`npm test` covers the citation syntax, which is the part with no Obsidian dependency.
Rendering, the suggester, the library pane, the detail pane, and everything touching
the bridge need a manual check in a real vault against a running Zotero (add-on with
the `collections` / `collection-items` bridge capabilities).
