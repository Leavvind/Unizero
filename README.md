# UniZero

UniZero connects **Zotero** (library, providers, cache, conversion) and **Obsidian**
(notes, citations, exploration). Zotero stays canonical for bibliographic identity;
Obsidian is the active note-taking front end.

## What each side does

### Obsidian plugin (`apps/obsidian-plugin`)

The **active product surface** for day-to-day reading and writing:

- free-text `@` search against the Zotero library and Vault documents;
- standard Markdown UniZero links with durable Zotero item or Vault UID targets;
- a library pane for browsing collections, and drag or insert citations into notes;
- a paper pane with metadata, incoming document links, References, Citations, and relations;
- jumps to converted Markdown (Raw), a per-paper Canvas, or the PDF, plus Raw/Canvas management.

Importing explored papers or bibliographic write-back from Obsidian is planned, not
present — see [Roadmap](docs/ROADMAP.md).

### Zotero add-on (`apps/zotero-addon`)

The **library backend** and scholarly data plane inside Zotero:

- metadata completion for Zotero items;
- PDF / EPUB → Markdown conversion (via the local paper runtime) and annotation injection;
- fetching and caching References / Citations through scholarly providers;
- derived relation index and the Uniconnection tab (paper-to-paper relations from Raw / Canvas links);
- localhost bridge used by the Obsidian plugin and the MCP server.

### MCP server (`apps/mcp-server`)

Gives agents (Claude Code and other MCP clients) the library's papers through the
bridge: search, Raw Markdown with PDF pages, table crops, extracted references, and
cached relations. Read-only apart from starting a conversion.

### Paper runtime (`services/paper-runtime`)

Optional local Python service for PDF / EPUB → Markdown conversion and related document
jobs. Talks to the add-on only through the versioned `/api/v1` contract.

## Repository

```text
apps/obsidian-plugin/    Obsidian plugin: citations, links, and panes against the bridge
apps/zotero-addon/       Zotero add-on: data plane, bridge, conversion, UniConnection UI
apps/mcp-server/         MCP server: papers, Raw text, tables, references for agents
services/paper-runtime/  Python service for PDF/EPUB and Markdown processing
packages/contracts/      Shared HTTP v1 schemas and example payloads
packages/links/          Shared UniZero link grammar and Markdown/Canvas link scanning
docs/                    Architecture, code map, design constraints, and roadmap
```

Start with [docs/README.md](docs/README.md) for the documentation map and
[AGENTS.md](AGENTS.md) for repository rules, boundaries, and verification.

## Development

There is no root build command. Each component builds and tests from its own directory:
[Obsidian plugin](apps/obsidian-plugin/README.md#development),
[Zotero add-on](apps/zotero-addon/README.md#build),
[MCP server](apps/mcp-server/README.md#development),
[paper runtime](services/paper-runtime/README.md#install).
Host UI (Zotero or Obsidian) always needs a manual check on top of automated tests.

## License

UniZero is licensed under AGPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
