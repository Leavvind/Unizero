# UniZero

UniZero is a Zotero extension featuring:

- metadata completion for Zotero items;
- PDF attachment conversion to Markdown;
- annotation export and injection into Markdown;
- a whiteboard for literature connections and exploration.

The runtime-dependent features use a local Python service. Zotero remains the source of
bibliographic metadata and annotations.

## Repository

```text
apps/zotero-addon/       Zotero 8 add-on, UI, commands, and scholarly providers
services/paper-runtime/  Python service for PDF and Markdown processing
packages/contracts/      Shared HTTP schemas and example payloads
docs/                    Architecture, code map, design notes, decisions, and roadmap
```

The add-on and runtime communicate through the versioned `/api/v1` localhost API. 

Start with:

- [Documentation map](docs/README.md) for what each document is and is not;
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
npm test
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

There is no root build command. `npm test` covers only the host-independent parts: the
derived relation index, graph builders, Project and Paper persistence, the sync engine,
and the Home dialog under `happy-dom`. Add-on UI and Zotero API changes also require a
manual Zotero check; neither type checking nor the test suite exercises the host
application.

## License

UniZero is licensed under AGPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
