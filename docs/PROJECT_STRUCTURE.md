# Project Structure

This is a map of the repository as it exists now.

```text
UniZero/
├── apps/
│   └── zotero-addon/
│       ├── addon/
│       │   ├── chrome/content/      Privileged dialogs: panel, explorer, graph, vendor, icons
│       │   ├── locale/              Fluent strings per locale
│       │   ├── manifest.json        Zotero add-on manifest template
│       │   └── prefs.js             Default preferences
│       ├── src/
│       │   ├── core/                Feature registry and lifecycle
│       │   ├── features/            Conversion and annotation commands
│       │   ├── modules/             Relations, metadata, providers, cache, derived index, item pane
│       │   ├── projects/            Project/Board/Paper schemas and Project persistence
│       │   ├── runtime-client/      Runtime HTTP client and process management
│       │   ├── ui/                  Menus, panel and explorer bridges, progress, service notices
│       │   ├── utils/               Shared add-on utilities
│       │   └── zotero/              Zotero adapters and artifact identity
│       ├── scripts/                 Build and local Zotero development tools
│       ├── tests/                   Host-independent Vitest suites
│       └── package.json
├── services/
│   └── paper-runtime/
│       ├── src/unizero_runtime/
│       │   ├── api/                 FastAPI transport
│       │   ├── application/         Configuration, jobs, use cases
│       │   ├── pipeline/            Templates and document processing
│       │   ├── providers/           PDF-reference extraction, tables, and remote providers
│       │   ├── templates/           Built-in workflow templates
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
data are not part of this structure.

## Dialog content

`addon/chrome/content/` is plain JavaScript and XHTML: not compiled and not type checked.
`literature-explorer.xhtml` and its scripts are loaded by the `happy-dom` harness in
`tests/literatureExplorerRace.test.ts`, so their host-independent behaviour is covered;
`panel.js`, Zotero APIs, privileged-window lifecycle, and the real canvas are not.

| File | Responsibility |
| --- | --- |
| `panel.xhtml` / `panel.js` | Runtime jobs, service notices, template editor |
| `literature-explorer.xhtml` | Home markup, CSS variables, and light/dark theming |
| `literature-explorer.js` | Home Board state, pointer interaction, filters, detail tabs, graph hosting |
| `literature-graph.js` | Force simulation and canvas drawing for the per-paper Graph tab |
| `vendor/force-graph.min.js` | Vendored MIT force-graph UMD build; see the sibling LICENSE |

These files talk to the add-on only through the plain-object API supplied as
`window.arguments[0].api`, built in `src/ui/literatureExplorer.ts` and
`src/ui/panel.ts`. Anything they need must be added to that bridge; they must not import
bundle modules.

## Where to make a change

| Change | Start here |
| --- | --- |
| Add or remove a feature lifecycle hook | `apps/zotero-addon/src/core/` |
| Add a conversion or annotation command | `apps/zotero-addon/src/features/` |
| Change a menu or panel integration | `apps/zotero-addon/src/ui/` |
| Read or mutate Zotero items/attachments | `apps/zotero-addon/src/zotero/` |
| Change References, Citations, or metadata UI | `apps/zotero-addon/src/modules/` |
| Change relation or graph topology | `apps/zotero-addon/src/modules/uniConnection.ts` |
| Change index maintenance or reference backfill | `apps/zotero-addon/src/modules/uniConnectionSync.ts` |
| Change Project/Board/Paper persisted shapes | `apps/zotero-addon/src/projects/` |
| Add data Unizero Home needs | `views.ts` producer, then the `src/ui/literatureExplorer.ts` bridge |
| Change Board layout, interaction, or detail tabs | `addon/chrome/content/literature-explorer.js` |
| Change graph visuals, forces, or interaction | `addon/chrome/content/literature-graph.js` |
| Change cached or persisted add-on state | `apps/zotero-addon/src/modules/localStorage.ts` |
| Change runtime HTTP behavior | schema, both contract models, client, then `api/` |
| Change conversion orchestration | `services/paper-runtime/.../application/` |
| Add or change a document pipeline step | `services/paper-runtime/.../pipeline/` |
| Change runtime filesystem locations | `services/paper-runtime/.../paths.py` |

## Dependency rules

- UI calls feature or application code; it does not own cache or network policy.
- New Zotero mutations belong in `src/zotero`.
- The derived index consumes the reference cache and item identifiers only. It does not
  fetch, does not write back to shards, and does not read display metadata.
- Graph topology stays free of Zotero fields; `views.ts` enriches it for display.
- Dialog content consumes the window API bridge, never bundle internals.
- Runtime-client code contains transport concerns, not document-processing logic.
- Runtime API handlers validate and map; application services orchestrate.
- Pipeline steps do not access Zotero.
- Cross-process shapes start in `packages/contracts`.

Do not create a directory for a planned abstraction until executable code or a real
schema needs it.
