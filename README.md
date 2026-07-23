# UniZero

UniZero is a modular research workflow extension for Zotero.

It brings together four related capabilities:

- bibliographic metadata completion and review;
- references and citations discovery;
- PDF-to-Markdown conversion and publishing;
- Zotero annotation export and incremental Markdown injection.

It is one Zotero add-on backed by an optional local paper-processing runtime.

## Project status

`apps/zotero-addon` provides references, citations, and metadata enrichment in the item
pane, plus PDF → Markdown conversion, annotation injection, artifact registration, and
local runtime process management.

`services/paper-runtime` is an installable Python
package serving `/api/v1`, with 65 tests and its state kept outside the source tree.

Both were manually checked in Zotero on 2026-07-23. Generated attachments are identified
by an explicit `unizero:<kind>` tag, so they are never found — or erased — by title.
The subsequent feature-registry, multi-window, port-sync, and group-library changes need
the focused manual checks listed in the roadmap.

The HTTP v1 field contract now lives in `packages/contracts` and is checked against both
language models. Common artifact envelopes and legacy contract fixtures are not yet
done. Open verification and planned work are in [Roadmap](docs/ROADMAP.md).

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
| `docs/` | Architecture, project structure, roadmap, and decisions |
| `scripts/` | Repository-level development and release helpers |

The detailed target tree and dependency rules are in
[Project Structure](docs/PROJECT_STRUCTURE.md).

## Origins

UniZero was formed by merging **Zoference** and **ZoMiner**.

Zoference supplied the add-on shell; ZoMiner's Zotero-facing half
was ported into it and its Python half became `services/paper-runtime`.
See [How UniZero Was Assembled](docs/HISTORY.md) for where each piece went and which
identifiers changed, and [Compatibility Readers](docs/COMPATIBILITY.md) for the code that
still reads state written by the predecessors.

## Design principles

- Zotero is the canonical store for bibliographic metadata and annotations.
- The add-on owns Zotero UI, Zotero mutations, and lightweight scholarly API access.
- The local runtime owns heavyweight PDF processing and filesystem publishing.
- All add-on/runtime communication uses an explicit, versioned contract.
- Feature modules are statically registered in the first UniZero releases.
- Existing user templates, artifacts, caches, and annotation state require an explicit
  migration or compatibility path.
- Generated output and machine-local state are never committed.

## Roadmap

Planned work, grouped by area: a common artifact envelope, field-level metadata
management with frontmatter projection, and annotation profiles with multiple output
modes. Group-library, lifecycle, and preference changes still need manual Zotero checks.

See [Roadmap](docs/ROADMAP.md), which also tracks the checks that are still open on work
already landed.

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
