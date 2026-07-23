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

**Phase 3 — both source projects have been migrated.**

`apps/zotero-addon` contains the Zoference features (references, citations, metadata
enrichment) and the ported ZoMiner capabilities (PDF conversion, annotation injection,
runtime process management, template panel), under one add-on ID with compatibility
readers for both projects' preferences and caches. It type-checks, builds, and packages
an XPI.

`services/paper-runtime` is an installable Python package serving the same `/api/v1`
contract as before, with 43 tests and its runtime state moved out of the source tree.

`packages/contracts` and `tests/contract` are still empty ownership directories.

**No phase has passed a manual check yet** — nothing has been exercised against a running
Zotero, and no end-to-end conversion has been run. See
[Migration Plan](docs/MIGRATION.md) for what remains on each gate.

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

The add-on builds from `apps/zotero-addon`:

```bash
cd apps/zotero-addon && npm ci
```

```bash
cd apps/zotero-addon && npm run build
```

This type-checks and writes `apps/zotero-addon/build/unizero.xpi`. Development setup and
the Zotero run loop are documented in
[`apps/zotero-addon/README.md`](apps/zotero-addon/README.md).

The runtime installs and tests from `services/paper-runtime`:

```bash
cd services/paper-runtime && uv venv --python 3.12 && uv pip install -e ".[dev]"
```

```bash
cd services/paper-runtime && .venv/Scripts/python.exe -m pytest
```

The add-on has no automated tests, and the runtime's tests stop short of conversion
itself, which needs MinerU and a real PDF. A type check and a green suite do not verify
Zotero UI behavior; add-on changes still require a manual check in Zotero.

Each further migration phase must add its real verification commands here and in
[AGENTS.md](AGENTS.md).

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

UniZero's add-on is a modified version of
[Zoference](https://github.com/Leavvind/Zoference), which is itself a modified version of
[MuiseDestiny/zotero-reference](https://github.com/MuiseDestiny/zotero-reference),
Copyright © Polygon. Copyright notices and component attributions are recorded in
[NOTICE](NOTICE).

The AGPL requires that anyone you distribute the add-on to can obtain the corresponding
source code. If you redistribute a built `.xpi`, publish this repository alongside it.

