# UniZero

UniZero is a literature-management project that **connects Zotero and Obsidian**.

Zotero remains the home of the library: items, PDFs, and annotations. Obsidian is the
note-taking front end: citations, exploration, and jumps into the same library. The two
share identity and derived literature data through the UniZero Zotero add-on; they are not
two independent apps glued by file export.

## What each side does

### Zotero add-on (`apps/zotero-addon`)

The add-on is the **library backend** and the place where scholarly work happens inside
Zotero:

- metadata completion for Zotero items;
- PDF attachment conversion to Markdown (via the local paper runtime);
- annotation export and injection into Markdown;
- fetching and caching References / Citations (and related derived state) from item
  metadata through scholarly providers.

It also exposes a **read-only localhost bridge** so the Obsidian plugin can resolve papers
without holding a second bibliographic store.

### Obsidian plugin (`apps/obsidian-plugin`)

The plugin is the **active note-taking surface**:

- free-text `@` search against the Zotero library;
- durable citations written as `@libraryID/itemKey`, displayed as Author (year) / title;
- jumps to the paper pane, a converted Markdown note, or the PDF in Zotero;
- a detail view of metadata, References, Citations, and relations **read from** the
  add-on.

**Today the bridge is read-only.** A deliberate write path — exploring from Obsidian and
sending new material back into the UniZero / Zotero side — is planned product work, not
an extension of the current bridge. Do not invent mutation endpoints casually.

### Paper runtime (`services/paper-runtime`)

Optional local Python service for PDF → Markdown conversion and related document jobs.
Talks to the add-on only through the versioned `/api/v1` contract.

## Product direction (this branch)

| Surface | Role |
| --- | --- |
| **Obsidian plugin** | Active development focus: citations, exploration UX, note jumps |
| **Zotero add-on data plane** | Still required: providers, cache, relations, Paper catalog, bridge, conversion |
| **Unizero Home (Project View / Board)** | **Legacy** — kept in the tree for now; not the product focus; do not extend unless a task says so |
| Item-pane literature previews / per-paper graph | Still part of the add-on; not the main roadmap |

Exploration, ranking, and richer write-back from notes have large headroom; those land as
explicit designs, not drive-by features.

## Repository

```text
apps/zotero-addon/       Zotero add-on: library backend, providers, cache, bridge, (legacy) Home UI
apps/obsidian-plugin/    Obsidian plugin: live papers against the add-on bridge
services/paper-runtime/  Python service for PDF and Markdown processing
packages/contracts/      Shared HTTP schemas and example payloads
docs/                    Architecture, code map, design notes, and roadmap
```

Two process boundaries, do not merge them:

1. Add-on ↔ runtime: versioned `/api/v1` (`packages/contracts/http/v1.schema.json`).
2. Add-on ↔ Obsidian: read-only bridge on Zotero's HTTP server
   (`BRIDGE_API_VERSION` in `apps/zotero-addon/src/server/bridgePayloads.ts`).

Start with:

- [Documentation map](docs/README.md) — what each document is and when to open it;
- [Architecture](docs/ARCHITECTURE.md) — system boundaries;
- [Project structure](docs/PROJECT_STRUCTURE.md) — where code belongs;
- [AGENTS.md](AGENTS.md) — repository rules, current focus, verification;
- [Roadmap](docs/ROADMAP.md) — unfinished work (not a work order by itself);
- [Obsidian plugin README](apps/obsidian-plugin/README.md) — default entry for note-side work.

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
