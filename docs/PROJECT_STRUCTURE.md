# Project Structure

This is the target repository structure. Directories may contain only boundary
documentation until their migration phase begins.

```text
UniZero/
├── AGENTS.md
├── README.md
├── apps/
│   └── zotero-addon/
│       ├── addon/                 # Manifest, locales, icons, preferences
│       ├── src/
│       │   ├── core/              # Module registry, events, jobs, shared services
│       │   ├── features/
│       │   │   ├── metadata/
│       │   │   ├── relations/
│       │   │   ├── conversion/
│       │   │   └── annotations/
│       │   ├── providers/         # Crossref, OpenAlex, Semantic Scholar
│       │   ├── runtime-client/    # Versioned client for the Python service
│       │   ├── zotero/            # Zotero adapters and lifecycle
│       │   └── ui/                # Item pane, dialogs, menus, progress
│       ├── scripts/
│       └── package.json
├── services/
│   └── paper-runtime/
│       ├── src/unizero_runtime/
│       │   ├── api/               # HTTP transport and contract mapping
│       │   ├── application/       # Jobs and use-case orchestration
│       │   ├── pipeline/          # Registry, templates, and pipeline steps
│       │   ├── providers/         # MinerU, PDF, filesystem, publishing
│       │   └── artifacts/         # Artifact creation and runtime index
│       ├── templates/
│       ├── scripts/
│       ├── tests/
│       └── pyproject.toml
├── packages/
│   └── contracts/
│       ├── http/
│       ├── artifacts/
│       ├── examples/
│       └── legacy/
├── tests/
│   └── contract/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── MIGRATION.md
│   ├── PROJECT_STRUCTURE.md
│   └── decisions/
└── scripts/
```

## Why the add-on lives under `apps/`

The Zotero add-on is the user-facing application. It owns:

- startup and shutdown;
- UI registrations and preferences;
- Zotero item and attachment operations;
- feature orchestration;
- lightweight network providers;
- the client for the local runtime.

Zoference supplies the initial build and lifecycle foundation. ZoMiner's plain
JavaScript add-on is ported into this application by capability; it does not remain as
a second embedded plugin.

## Why the runtime lives under `services/`

The Python runtime is a separately started process even when distributed as part of
one product. It owns:

- FastAPI transport;
- the single-worker job queue;
- MinerU and PDF tooling;
- conversion template execution;
- Markdown transforms and artifact publishing;
- local processing state.

The runtime is not required for metadata and relations features. Keeping that boundary
allows the add-on to start quickly and avoids shipping Python implementation concerns
into Zotero's Firefox sandbox.

## Why contracts are a package

The TypeScript and Python components cannot share implementation code. They can share:

- JSON Schema or equivalent language-neutral schemas;
- versioned example payloads;
- legacy compatibility fixtures;
- artifact envelopes and identifiers;
- error code definitions.

Schemas are treated as public compatibility surfaces. Generated language bindings, if
introduced later, are outputs and must have a reproducible generation command.

## Dependency rules

- `ui` depends on feature application services, not on provider implementations.
- features depend on ports and normalized domain models.
- providers implement ports and may depend on transport helpers.
- Zotero adapters are the only add-on code that directly mutates Zotero items.
- the runtime client never imports or duplicates Python pipeline logic.
- runtime API handlers map requests and responses but do not orchestrate pipelines
  directly.
- pipeline steps do not access Zotero.

Cycles between feature modules are avoided through capabilities and events. For
example, conversion can publish a `document.converted` event consumed by relations and
annotations without directly importing their UI.

## Naming

- Product feature IDs use stable dotted names such as `library.metadata`.
- Runtime pipeline IDs keep explicit verbs such as `extract.mineru` and
  `publish.markdown-directory`.
- Artifact kinds describe data, not brands, for example
  `literature.references` rather than `zominer-references`.
- Display names may change without changing identifiers.

