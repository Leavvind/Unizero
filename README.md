# UniZero

UniZero is a Zotero extension for managing research metadata, literature relations, PDF
conversion, and Markdown annotations.

## Features

| Area | Capability | Local runtime |
| --- | --- | --- |
| Metadata | Find identifiers, compare candidates, update Zotero items | Not required |
| Relations | Browse references and citations, import and relate items | Not required |
| Documents | Convert PDFs to Markdown, tables, and reference artifacts | Required |
| Annotations | Export or inject Zotero annotations into Markdown | Required |

The runtime-dependent features use a local Python service. Zotero remains the source of
truth for bibliographic metadata and annotations.

## Repository

```text
apps/zotero-addon/       Zotero 8 add-on, UI, commands, and scholarly providers
services/paper-runtime/  Python service for PDF and Markdown processing
packages/contracts/      Shared HTTP schemas and example payloads
docs/                    Architecture, code map, decisions, and roadmap
```

The add-on and runtime communicate through the versioned `/api/v1` localhost API. They
do not import each other's implementation.

Start with:

- [Architecture](docs/ARCHITECTURE.md) for system boundaries;
- [Project structure](docs/PROJECT_STRUCTURE.md) for where code belongs;
- [AGENTS.md](AGENTS.md) for repository rules and verification commands;
- [Roadmap](docs/ROADMAP.md) for unfinished work.

## Development

Build and check the add-on:

```bash
cd apps/zotero-addon
npm ci
npm run check
npm run build
```

Install and test the runtime:

```bash
cd services/paper-runtime
uv venv --python 3.12
uv pip install -e ".[dev]"
.venv/Scripts/python.exe -m pytest
```

The add-on build writes `apps/zotero-addon/build/unizero.xpi`. Runtime installation,
launch options, and development-profile setup are documented in the component READMEs.

There is no root build command. Add-on UI and Zotero API changes also require a manual
Zotero check; type checking does not exercise the host application.

## License

UniZero is licensed under AGPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
