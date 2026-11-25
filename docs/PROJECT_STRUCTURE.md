# Project Structure

```text
UniZero/
├── apps/
│   ├── obsidian-plugin/
│   │   ├── src/                 Citation syntax, renderers, suggester, panes, Raw/Canvas actions, bridge client
│   │   ├── tests/               Vitest over links, indexes, completion, actions, and panes (Obsidian mocked)
│   │   ├── manifest.json        Obsidian plugin manifest
│   │   ├── styles.css           Link, editor and pane styling
│   │   └── package.json
│   ├── mcp-server/
│   │   ├── src/                 Bridge client, paper resolution, Raw/tables/references readers, MCP tools
│   │   ├── tests/               Vitest over the readers and every tool against a fake bridge
│   │   └── package.json
│   └── zotero-addon/
│       ├── addon/
│       │   ├── chrome/content/  Privileged XHTML/JS: panel, preferences, UniConnection full shell, icons
│       │   ├── locale/          Fluent strings per locale
│       │   ├── manifest.json    Zotero add-on manifest template
│       │   └── prefs.js         Default preferences
│       ├── src/
│       │   ├── core/            Feature registry and lifecycle
│       │   ├── features/        Conversion and annotation commands
│       │   ├── modules/         Relations, metadata, providers, cache, derived index, preferences
│       │   ├── projects/        Paper catalog schemas and persistence
│       │   ├── runtime-client/  Runtime HTTP client and process management
│       │   ├── server/          Bridge (Obsidian, MCP server) and citekey resolution
│       │   ├── ui/              Menus, panel, progress, notices, UniConnection lists/window, Home tab
│       │   ├── utils/           Shared add-on utilities
│       │   └── zotero/          Zotero adapters, excerpt notes, and artifact identity
│       ├── scripts/             Build and local Zotero development tools
│       ├── tests/               Host-independent Vitest suites
│       └── package.json
├── services/
│   └── paper-runtime/
│       ├── src/unizero_runtime/
│       │   ├── api/                 FastAPI transport
│       │   ├── application/         Configuration, jobs, use cases
│       │   ├── pipeline/            Templates and document processing
│       │   ├── providers/           PDF-reference extraction, tables, and remote providers
│       │   ├── templates/           Built-in workflow templates
│       │   ├── cancellation.py      Per-job cancel token and child-process cleanup
│       │   ├── composition.py       Dependency wiring
│       │   ├── contracts.py         Pydantic boundary models
│       │   └── paths.py             Runtime-home resolution
│       ├── scripts/                 Runtime maintenance and launch helpers
│       ├── tests/
│       └── pyproject.toml
├── packages/
│   └── contracts/
│       ├── http/                    Canonical HTTP schemas
│       └── examples/                Synthetic shared payloads
├── docs/                            See docs/README.md for the document map
├── AGENTS.md
├── README.md
├── LICENSE
└── NOTICE
```

Generated output, dependency directories, runtime homes, local configuration, and user
data are not part of this structure. Do not create a directory for a planned abstraction
until executable code or a real schema needs it.

## Where to make a change

### Obsidian (default product surface)

| Change | Start here |
| --- | --- |
| URI grammar, encoding, labels | `apps/obsidian-plugin/src/linkTarget.ts` |
| Legacy citation syntax and shared drag/insert output | `apps/obsidian-plugin/src/citation.ts` |
| Structural Markdown/Canvas scanning and text anchors | `apps/obsidian-plugin/src/documentLinks.ts` |
| Vault UID mapping and conflicts | `apps/obsidian-plugin/src/vaultIdentity.ts` |
| Shared document links and source coverage | `apps/obsidian-plugin/src/linkIndex.ts`, `externalIndex.ts` |
| Target dispatch and source navigation | `apps/obsidian-plugin/src/linkOpening.ts`, `linkPicker.ts` |
| Completion inside a link destination | `apps/obsidian-plugin/src/linkCompletion.ts`, `targetSuggest.ts` |
| Document Backlinks and unlinked mentions | `apps/obsidian-plugin/src/backlinksView.ts`, `unlinkedMentions.ts` |
| Bridge client (HTTP to Zotero) | `apps/obsidian-plugin/src/bridge.ts` |
| `@` suggester / free-text search | `apps/obsidian-plugin/src/suggest.ts` |
| Library search command (modal with PDF / Raw / Canvas jumps) | `apps/obsidian-plugin/src/searchModal.ts` |
| Library pane | `apps/obsidian-plugin/src/libraryView.ts` |
| Item (detail) pane | `apps/obsidian-plugin/src/detailView.ts` |
| In-memory paper store / cache | `apps/obsidian-plugin/src/paperStore.ts` |
| Raw, Canvas, and conversion actions and menus | `apps/obsidian-plugin/src/actions.ts` |
| Vault source events and compatibility citation counts | `apps/obsidian-plugin/src/vaultIndex.ts` |
| Canvas capture (Zotero excerpts into Canvas Cards and notes) | `apps/obsidian-plugin/src/capture/` |
| Plugin settings | `apps/obsidian-plugin/src/settings.ts` |
| Live-preview link dispatch | `apps/obsidian-plugin/src/render.ts` |
| Link, editor and pane styling | `apps/obsidian-plugin/styles.css` |

### Zotero data plane, bridge, and runtime

| Change | Start here |
| --- | --- |
| Bridge endpoints or payloads | `apps/zotero-addon/src/server/` |
| Bounded document source snapshots | `apps/zotero-addon/src/server/linkSourceDirectory.ts` |
| Add or remove a feature lifecycle hook | `apps/zotero-addon/src/core/` |
| Add a conversion or annotation command | `apps/zotero-addon/src/features/` |
| Change a menu or panel integration | `apps/zotero-addon/src/ui/` |
| Read-only Markdown/Canvas source discovery | `apps/zotero-addon/src/zotero/linkSources.ts` |
| Read or mutate Zotero items/attachments | `apps/zotero-addon/src/zotero/` |
| Change the References / Citations lists (item pane and UniConnection full) | `apps/zotero-addon/src/ui/literatureSidebar.ts` (rows: `literatureSidebarModel.ts`) |
| Change the UniConnection full window shell/following | `apps/zotero-addon/src/ui/uniConnectionFull.ts` |
| Change Unizero Home (tab, toolbar button, columns, activity SQL) | `apps/zotero-addon/src/ui/unizeroHome.ts`, `unizeroHomeModel.ts`, `src/zotero/uniConnectionActivity.ts` |
| Change References / Citations data, providers, or preferences | `apps/zotero-addon/src/modules/` |
| Change the derived relation index or maintenance | `apps/zotero-addon/src/modules/uniConnection.ts`, `uniConnectionSync.ts` |
| Change the citation-excerpt note format or its writer | `apps/zotero-addon/src/zotero/excerptNoteFormat.ts`, `excerptNotes.ts` |
| Change Paper catalog persisted shapes | `apps/zotero-addon/src/projects/` |
| Change cached or persisted add-on state | `apps/zotero-addon/src/modules/localStorage.ts` |
| Change runtime HTTP behavior | schema, both contract models, client, then `api/` |
| Change conversion orchestration or pipeline steps | `services/paper-runtime/src/unizero_runtime/application/`, `pipeline/` |
| Change runtime filesystem locations | `services/paper-runtime/src/unizero_runtime/paths.py` |

## Dialog content (add-on)

`addon/chrome/content/` is privileged XHTML and plain JavaScript outside the TypeScript
bundle, type checker, and automated tests:

| File | Responsibility | Wiring |
| --- | --- | --- |
| `panel.xhtml` / `panel.js` | Runtime jobs, service notices, template editor | `window.arguments[0]` |
| `preferences.xhtml` | UniZero settings pane inside Zotero preferences | `PreferencePanes.register` + `src/modules/prefs.ts` |
| `uniconnection-full.xhtml` | Script-free window shell; bundle draws `LiteratureSidebar` into it | `window.arguments[0]` |

Files in this directory must never import bundle modules. Architectural dependency rules
live in [AGENTS.md](../AGENTS.md#architecture-rules) and [ARCHITECTURE.md](ARCHITECTURE.md).
