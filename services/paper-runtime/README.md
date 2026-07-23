# UniZero Paper Runtime

The optional Python service for PDF extraction, Markdown transformation, artifact
publishing, and annotation injection.

It exposes `/api/v1` on localhost, does not access Zotero directly, and is not required
for metadata or literature-relations features.

## Install

Python 3.12 is required.

```bash
uv venv --python 3.12
uv pip install -e ".[dev]"
```

## Run

```bash
python -m unizero_runtime
```

Options:

- `--home PATH`: select the runtime-state directory;
- `--port N`: override the configured port;
- `--no-log-file`: keep output on the console.

The Zotero add-on can launch the installed module or console command automatically. Set
an explicit Python path in Zotero only when the environment is not discoverable.

## Runtime home

Mutable state is kept outside the package. Resolution order:

1. `UNIZERO_RUNTIME_HOME`;
2. `%LOCALAPPDATA%\UniZero\runtime` on Windows;
3. `$XDG_DATA_HOME/unizero/runtime` or `~/.local/share/unizero/runtime` elsewhere.

```text
<home>/
├── config.json
├── work/
├── store/
├── user_templates/
└── server.log
```

Built-in templates live in `src/unizero_runtime/templates/` and are replaced with the
package. User template overrides live in the runtime home.

## Source map

| Path | Responsibility |
| --- | --- |
| `api/` | FastAPI endpoints and error mapping |
| `application/` | Configuration, jobs, conversion, annotations |
| `pipeline/` | Workflow registry, templates, transforms, publishing |
| `providers/` | Reference extraction, table processing, remote providers |
| `contracts.py` | Pydantic request and response models |
| `composition.py` | Dependency construction |
| `paths.py` | Runtime-home resolution |
| `__main__.py` | Command-line entry point |

## Test

```bash
.venv/Scripts/python.exe -m pytest
```

Tests use an isolated runtime home and cover paths, templates, contracts,
frontmatter, artifact scoping, and annotation idempotency. Real PDF conversion requires
MinerU and is verified manually.

## License

AGPL-3.0-or-later. See the repository `LICENSE` and `NOTICE`.
