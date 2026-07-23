# UniZero

UniZero is a modular research workflow extension for Zotero.

It brings together four related capabilities:

- bibliographic metadata completion and review;
- references and citations discovery;
- PDF-to-Markdown conversion and publishing;
- Zotero annotation export and incremental Markdown injection.

UniZero is being formed from the existing **Zoference** and **ZoMiner** projects.
The goal is one coherent Zotero add-on backed by an optional local paper-processing
runtime, not one large process containing every concern.

## Project status

**Foundation phase — no application code has been migrated yet.**

The repository currently defines the intended boundaries, project structure, migration
order, and contributor rules. This is deliberate: code will be moved only after its
destination and compatibility obligations are clear.

## Architecture at a glance

```text
UniZero Zotero add-on (TypeScript)
├── Library Metadata
├── Literature Relations
├── Document Conversion
├── Annotations
└── Application core and Zotero adapters
             │
             │ versioned localhost HTTP API
             ▼
Paper Runtime (Python)
├── jobs and configuration
├── MinerU extraction
├── Markdown transforms
├── artifact generation
└── publishing
```

UniZero uses three different kinds of module:

1. **Feature modules** provide user-facing Zotero capabilities.
2. **Providers** supply metadata, scholarly relations, or computation.
3. **Pipeline steps** transform document artifacts inside the Python runtime.

These concepts are intentionally separate. Metadata completion is a feature module; it
is not a PDF pipeline step and should not be forced into an Extract/Publish workflow.

See [Architecture](docs/ARCHITECTURE.md) for the full boundary model.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/zotero-addon/` | Zotero lifecycle, UI, feature modules, providers, and adapters |
| `services/paper-runtime/` | Python service for heavy PDF and Markdown workflows |
| `packages/contracts/` | Versioned, language-neutral HTTP and artifact contracts |
| `tests/contract/` | Cross-runtime contract fixtures and compatibility tests |
| `docs/` | Architecture, project structure, migration plan, and decisions |
| `scripts/` | Repository-level development and release helpers |

The detailed target tree and dependency rules are in
[Project Structure](docs/PROJECT_STRUCTURE.md).

## Source projects

- **Zoference** is the preferred foundation for the unified Zotero add-on because it
  already has a TypeScript build, current Zotero item-pane integration, and lifecycle
  handling.
- **ZoMiner's Zotero plugin** is a migration source for service management, conversion
  commands, item/attachment adapters, template UI, and artifact registration.
- **ZoMiner's `paper_service`** remains a separate Python runtime and is migrated with
  minimal behavioral change before deeper refactoring.

The source repositories remain authoritative until each migration phase is accepted.
Do not delete or rewrite them as part of the initial integration.

## Design principles

- Zotero is the canonical store for bibliographic metadata and annotations.
- The add-on owns Zotero UI, Zotero mutations, and lightweight scholarly API access.
- The local runtime owns heavyweight PDF processing and filesystem publishing.
- All add-on/runtime communication uses an explicit, versioned contract.
- Feature modules are statically registered in the first UniZero releases.
- Existing user templates, artifacts, caches, and annotation state require an explicit
  migration or compatibility path.
- Generated output and machine-local state are never committed.

## Migration

Migration is organized as independently verifiable phases:

1. repository and contract foundation;
2. unified add-on shell;
3. ZoMiner add-on capability port;
4. Python runtime migration;
5. integrated artifacts and relations;
6. canonical metadata and frontmatter projection;
7. annotation profiles and export modes.

See [Migration Plan](docs/MIGRATION.md) for phase gates and the source-to-target map.

## Building and testing

There is no UniZero build yet because application code has not been migrated. Do not
publish placeholder build commands.

Each migration phase must add its real verification commands to this README and
[AGENTS.md](AGENTS.md). Until then, review the documentation and repository layout
directly.

