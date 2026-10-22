# UniZero MCP Server

A Model Context Protocol server that gives coding and research agents the papers in
the user's Zotero library as UniZero sees them: metadata, the Raw Markdown (MinerU
conversion with formulas, tables, and PDF page markers), the table crops, and the
reference list extracted from the PDF.

It exists so agents stop reading papers through generic full-text tools (plain PDF
text without layout, pages, or tables) and stop carrying private copies of UniZero's
rules. Everything goes through the add-on's localhost bridge; this server knows no
artifact tag, attachment-note record, or Zotero API.

## Tools

| Tool | Reads | Notes |
| --- | --- | --- |
| `find_paper` | `GET /suggest` | Free text → `@libraryID/ITEMKEY` addresses |
| `get_paper` | `/paper`, `/artifacts`, files | Metadata, abstract, what each PDF has been converted to, Raw outline with lines and pages |
| `read_paper` | Raw | By section heading or line range; every line `L<line> p.<page>` |
| `search_paper` | Raw | Regex and literal match at once, with context lines |
| `get_table` | Tables digest | Lists tables; with `table` returns the crop as an image |
| `get_references` | References JSON | Raw citation text, page, printed DOI/arXiv |
| `get_relations` | `GET /relations` | Provider cache only, unless `fetch=true` |
| `convert_paper` | `POST /convert` | Starts a conversion with the add-on's default template unless one is named; the only writing tool |

A paper is addressed as `@libraryID/ITEMKEY` (as in notes), an item key in the user
library, a citekey, or title words. Ambiguous text returns the candidates rather than
guessing. `pdf` selects the attachments of one PDF for papers with supplements.

Raw is the user's own edited copy, so it is read, never written. Reading normalises it
in memory: page links become `[p.N]` markers, injected highlight links are dropped,
and relative image links become absolute paths.

## Requirements

- Node.js 18 or later;
- Zotero running with a UniZero add-on whose bridge ping lists the `artifacts`
  capability (the tools that read files say so when the add-on is older);
- `UNIZERO_ZOTERO_URL` only when Zotero's server is not `http://127.0.0.1:23119`.

## Development

```text
npm install
npm run check
npm test
npm run build
```

`npm test` covers Raw normalisation, outline, sections, search, the tables digest and
references readers, and every tool end to end against a fake bridge. The digest fixture
in `tests/fixtures/` is rendered by the paper runtime's `providers/tables.py`;
regenerate it when that HTML changes. A live check needs a running Zotero.

## Use it from an MCP client

Build, then register `dist/index.js` as a stdio server. For Claude Code:

```text
claude mcp add --scope user unizero -- node <repo>/apps/mcp-server/dist/index.js
```

Rebuild after pulling changes; the client starts a new process for each session.
