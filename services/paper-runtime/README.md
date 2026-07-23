# UniZero Paper Runtime

The local Python service behind UniZero's document features: MinerU-based PDF
extraction, Markdown transforms, artifact generation, publishing, and annotation
injection.

It runs as a separate process and talks to the Zotero add-on over a versioned localhost
HTTP contract. It does not access Zotero directly and is not required for metadata or
literature-relations features.

It began as ZoMiner's `paper_service` and was moved here at behavior parity, with one
deliberate change: runtime state no longer lives inside the source tree. See
*Runtime home* below. The `/api/v1` contract is unchanged, so the add-on drives this and
the original ZoMiner service identically.

## Install

Requires Python 3.12.

```bash
uv venv --python 3.12
```

```bash
uv pip install -e ".[dev]"
```

## Run

```bash
python -m unizero_runtime
```

Useful flags: `--home` to pick a state directory, `--port` to override the configured
port, `--no-log-file` to keep output on the console instead of `server.log`.

The add-on launches the runtime itself and needs no path configuration once this package
is installed: it finds a `PATH` interpreter that can import `unizero_runtime`, or the
`unizero-runtime` console script. See the resolution table in
[`apps/zotero-addon/README.md`](../../apps/zotero-addon/README.md).

Two cases still need a setting, under *Settings → UniZero → 本地服务* in Zotero:

- the virtualenv is not on `PATH` (this repo's `.venv` normally is not) — set
  *Python 路径* to `.venv/Scripts/pythonw.exe` (Windows) or `.venv/bin/python`;
- you want a specific script — set *server.py 路径* to
  [`scripts/server.py`](scripts/server.py). That file exists so the add-on's older
  interpreter auto-detection resolves this directory's `.venv`; read its docstring
  before moving it.

## Runtime home

All mutable state lives in one directory, resolved in this order:

1. `$UNIZERO_RUNTIME_HOME`
2. `%LOCALAPPDATA%\UniZero\runtime` on Windows, `$XDG_DATA_HOME/unizero/runtime`
   (default `~/.local/share/unizero/runtime`) elsewhere

```text
<home>/
├── config.json        # service configuration, editable from the add-on panel while it runs
├── work/              # per-job scratch space, disposable
├── store/             # annotation injection records
├── user_templates/    # user template overrides
└── server.log         # last run's output; the add-on reads its tail on crashes
```

ZoMiner kept all of this beside `server.py`. That breaks as soon as the package is
installed rather than run from a clone: the code directory may be read-only and is
replaced on upgrade.

**Coming from ZoMiner:** set `UNIZERO_RUNTIME_HOME` to your existing `paper_service`
directory. The layout inside is identical, so your `config.json`, `work/`, `store/` and
`user_templates/` are picked up unchanged. `tests/test_paths.py` covers exactly this.

Built-in templates are package data (`src/unizero_runtime/templates/`), not part of the
home — they ship with the code and are replaced on upgrade, while user overrides in the
home are not.

## Test

```bash
.venv/Scripts/python.exe -m pytest
```

43 tests covering runtime paths, template validation, reference extraction, frontmatter
projection, annotation idempotency, and the `/api/v1` contract the add-on depends on.

They do not cover conversion itself: that needs MinerU, a GPU, and a real PDF. Anything
exercising the pipeline end to end is still a manual check.

## Layout

```text
src/unizero_runtime/
├── contracts.py       # pydantic request/response models, shared by api and application
├── paths.py           # runtime home resolution
├── composition.py     # wiring; nothing is constructed at import time
├── asgi.py            # module-level app for `uvicorn unizero_runtime.asgi:app`
├── __main__.py        # `python -m unizero_runtime`
├── api/               # FastAPI transport
├── application/       # config, job queue, conversion and annotation orchestration
├── pipeline/          # workflow engine, conversion steps, postprocessing, templates
├── providers/         # Semantic Scholar, reference extraction, table export
└── templates/         # built-in conversion templates
```

`artifacts/` from [`../../docs/PROJECT_STRUCTURE.md`](../../docs/PROJECT_STRUCTURE.md)
does not exist yet — the artifact envelope and registry are planned, not built. See
[`../../docs/ROADMAP.md`](../../docs/ROADMAP.md).

## License

AGPL-3.0-or-later, along with the rest of this repository. See
[`../../NOTICE`](../../NOTICE) — this component has a single copyright holder, so that
choice can still be revisited.
