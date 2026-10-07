# UniZero

UniZero connects **Zotero** (library, providers, cache, conversion) and **Obsidian**
(notes, citations, exploration). Zotero stays canonical for bibliographic identity;
Obsidian is the active note-taking front end.

## What each side does

### Obsidian plugin (`apps/obsidian-plugin`)

The **active product surface** for day-to-day reading and writing:

- free-text `@` search against the Zotero library;
- durable citations written as `@libraryID/itemKey`, displayed as Author (year) / title;
- drag or insert citations into notes; jumps to the paper pane, converted Markdown, or PDF;
- a detail view of metadata, References, Citations, and relations from the add-on;
- **Convert to Markdown** via the bridge (same job as Zotero’s item menu).

Importing explored papers or other bibliographic write-back from Obsidian is planned,
not present — it needs a separate design beyond today’s bridge.

### Zotero add-on (`apps/zotero-addon`)

The **library backend** and scholarly data plane inside Zotero:

- metadata completion for Zotero items;
- PDF → Markdown conversion (via the local paper runtime);
- annotation export and injection into Markdown;
- fetching and caching References / Citations through scholarly providers;
- derived relation index, Paper catalog, and optional WebDAV sync of Project documents.

It exposes a **mostly read-only localhost bridge** for Obsidian: GET endpoints never
mutate Zotero or the Paper catalog; the sole action endpoint is `POST /convert`.

### Paper runtime (`services/paper-runtime`)

Optional local Python service for PDF → Markdown conversion and related document jobs.
Talks to the add-on only through the versioned `/api/v1` contract.

## Product direction (this branch)

| Surface | Role |
| --- | --- |
| **Obsidian plugin** | Active development focus: citations, panes, search, jumps |
| **Zotero add-on data plane** | Required backend: providers, cache, relations, Paper catalog, bridge, conversion |
| **Unizero Home (Project View / Board)** | **Legacy** — still ships in the XPI; do not extend unless a task says so |
| Item-pane literature previews / per-paper graph | Still in the add-on; not the main roadmap |

## Repository

```text
apps/obsidian-plugin/    Obsidian plugin: citations and panes against the bridge
apps/zotero-addon/       Zotero add-on: data plane, bridge, conversion, (legacy) Home UI
services/paper-runtime/  Python service for PDF and Markdown processing
packages/contracts/      Shared HTTP schemas and example payloads
docs/                    Architecture, code map, design notes, and roadmap
```

Two process boundaries — do not merge them:

1. Add-on ↔ runtime: versioned `/api/v1` (`packages/contracts/http/v1.schema.json`).
2. Add-on ↔ Obsidian: mostly-read-only bridge on Zotero’s HTTP server
   (`BRIDGE_API_VERSION` in `apps/zotero-addon/src/server/bridgePayloads.ts`).

Start with:

- [Obsidian plugin README](apps/obsidian-plugin/README.md) — default entry for note-side work;
- [Documentation map](docs/README.md) — what each document is and when to open it;
- [Architecture](docs/ARCHITECTURE.md) — system boundaries;
- [Project structure](docs/PROJECT_STRUCTURE.md) — where code belongs;
- [AGENTS.md](AGENTS.md) — repository rules, current focus, verification;
- [Roadmap](docs/ROADMAP.md) — unfinished work (not a work order by itself).

## Development

There is no root build command. Build each component from its directory.

**Obsidian plugin (current focus):**

```bash
cd apps/obsidian-plugin
npm ci
npm run check
npm test
npm run build
```

**Zotero add-on:**

```bash
cd apps/zotero-addon
npm ci
npm run check
npm test
npm run build
```

The add-on build writes `apps/zotero-addon/build/unizero.xpi`.

**Paper runtime:**

```bash
cd services/paper-runtime
uv venv --python 3.12
uv pip install -e ".[dev]"
.venv/Scripts/python.exe -m pytest   # Windows; use .venv/bin/python on macOS/Linux
```

Runtime installation, Zotero profile setup, and Obsidian vault install steps live in the
component READMEs. Host UI (Zotero or Obsidian) always needs a manual check on top of
automated tests.

## License

UniZero is licensed under AGPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
