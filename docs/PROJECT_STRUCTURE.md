# Project Structure

This is a map of the repository as it exists now.

```text
UniZero/
├── apps/
│   └── zotero-addon/
│       ├── addon/                 Manifest, locales, preferences, dialog assets
│       ├── src/
│       │   ├── core/              Feature registry and lifecycle
│       │   ├── features/          Conversion and annotation commands
│       │   ├── modules/           Relations, metadata, providers, cache, item pane
│       │   ├── runtime-client/    Runtime HTTP client and process management
│       │   ├── ui/                Menus, panel bridge, progress, service notices
│       │   ├── utils/             Shared add-on utilities
│       │   └── zotero/            Zotero adapters and artifact identity
│       ├── scripts/               Build and local Zotero development tools
│       └── package.json
├── services/
│   └── paper-runtime/
│       ├── src/unizero_runtime/
│       │   ├── api/               FastAPI transport
│       │   ├── application/       Configuration, jobs, use cases
│       │   ├── pipeline/          Templates and document processing
│       │   ├── providers/         References, tables, remote providers
│       │   ├── templates/         Built-in workflow templates
│       │   ├── composition.py     Dependency wiring
│       │   ├── contracts.py       Pydantic boundary models
│       │   └── paths.py           Runtime-home resolution
│       ├── scripts/               Runtime maintenance and launch helpers
│       ├── tests/
│       └── pyproject.toml
├── packages/
│   └── contracts/
│       ├── http/                  Canonical HTTP schemas
│       └── examples/              Synthetic shared payloads
├── docs/
│   ├── ARCHITECTURE.md
│   ├── LEGACY_SUPPORT.md
│   ├── PROJECT_STRUCTURE.md
│   ├── ROADMAP.md
│   └── decisions/
├── AGENTS.md
├── README.md
├── LICENSE
└── NOTICE
```

Generated output, dependency directories, runtime homes, local configuration, and user
data are not part of this structure.

## Where to make a change

| Change | Start here |
| --- | --- |
| Add or remove a feature lifecycle hook | `apps/zotero-addon/src/core/` |
| Add a conversion or annotation command | `apps/zotero-addon/src/features/` |
| Change a menu or panel integration | `apps/zotero-addon/src/ui/` |
| Read or mutate Zotero items/attachments | `apps/zotero-addon/src/zotero/` |
| Change References, Citations, or metadata UI | `apps/zotero-addon/src/modules/` |
| Change runtime HTTP behavior | schema, both contract models, client, then `api/` |
| Change conversion orchestration | `services/paper-runtime/.../application/` |
| Add or change a document pipeline step | `services/paper-runtime/.../pipeline/` |
| Change runtime filesystem locations | `services/paper-runtime/.../paths.py` |

## Dependency rules

- UI calls feature or application code; it does not own cache or network policy.
- New Zotero mutations belong in `src/zotero`.
- Runtime-client code contains transport concerns, not document-processing logic.
- Runtime API handlers validate and map; application services orchestrate.
- Pipeline steps do not access Zotero.
- Cross-process shapes start in `packages/contracts`.

Do not create a directory for a planned abstraction until executable code or a real
schema needs it.
