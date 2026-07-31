# UniZero for Obsidian

Turns `@citekey` into a live Zotero paper inside Obsidian notes **and canvases**.

The plugin stores no bibliographic data. Zotero, the reference cache, and the Paper
catalog all live in the [Zotero add-on](../zotero-addon); this is a view of them over
the add-on's localhost bridge.

## Syntax

| Written | Click does |
| --- | --- |
| `@citekey` | Opens the paper pane: metadata, References, Citations, Relation |
| `@citekey.md` | Opens the converted Markdown note in this vault |
| `@citekey.pdf` | Opens the PDF in Zotero |

Right-clicking any of the three offers all four actions, including *Show in Zotero*.
Typing `@` opens a completion list backed by the Zotero library. `\@notacitation`
escapes the syntax, and email addresses are never matched.

A citekey may contain letters, digits, `_`, and `-`, and must start with a letter.
The `.` is reserved so the suffix stays unambiguous.

## Canvas

There is no canvas-specific code here, and that is deliberate. A canvas text node is a
live-preview editor while it is being edited and a rendered Markdown block the rest of
the time, and a file node embeds a normal Markdown view. Registering a post-processor
and a CodeMirror extension therefore covers canvases for free — without touching
Obsidian's unofficial canvas internals, which change between releases.

## Citekeys

A pinned `Citation Key: …` line in a Zotero item's Extra field always wins. Better
BibTeX and Zotero's own citation-key support both write that line, so keys you already
cite by keep working.

Without a pinned key the add-on derives one from the first author, the significant
title words, and the year. A derived key is a **convenience, not an identity**: editing
the title in Zotero changes it. The paper pane labels derived keys as such, and reports
when two items derive the same one rather than picking a winner. Pin the key in Zotero
for anything you intend to keep.

## Requirements

- Zotero 7 or later, running, with the UniZero add-on installed.
- Zotero's HTTP server enabled (it is by default; `extensions.zotero.httpServer.enabled`).
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
directory's `manifest.json`, `main.js`, and `styles.css` into
`<vault>/.obsidian/plugins/unizero/`.

`npm test` covers the citation syntax, which is the part with no Obsidian dependency.
Rendering, the suggester, the detail pane, and everything touching the bridge need a
manual check in a real vault against a running Zotero.
