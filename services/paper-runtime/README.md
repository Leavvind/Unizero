# UniZero Paper Runtime

The optional Python service for PDF extraction, Markdown transformation, artifact
publishing, and annotation injection.

It exposes `/api/v1` on localhost, does not access Zotero directly, and is not required
for metadata or literature-relations features. Requests addressed to a non-loopback
`Host`, or sent by a cross-site browser page (`Sec-Fetch-Site` or a web `Origin`), are
refused with `403 forbidden_origin`, so a web page cannot stop or reconfigure it.

Extraction always keeps every block MinerU finds. The `transform.content` module then
decides what the Markdown keeps of display formulas, figures, tables, and the References
section, replacing whatever it leaves out with a link to its PDF page. From the full
content list it also produces the structured References (ordered records with raw
citation text, source page, and any DOI/arXiv identifier printed in the paper, without
querying scholarly providers) and the table digest, one HTML file of table page crops.
Stored templates that still use the separate References, Markdown post-processing, and
Table digest modules, or Extract's formula and table switches, are migrated on load.

A template ends with one or more Publish modules. `publish.markdown-directory` writes the
Markdown (with frontmatter) to a directory or Obsidian vault; `publish.zotero-markdown`
leaves the same document, with its referenced images under `attachments/`, in a hand-off
directory of the runtime store for the add-on to attach to the Zotero item as Raw and
Raw Backup. The runtime never touches Zotero itself; the hand-off paths come back in the
job result as `zotero_md_path` and, when there are images, `zotero_md_images_dir`. Every
built-in template uses it. A stored template that still names
the removed `publish.zotero-note` is migrated to `publish.zotero-markdown` on load.

A module can declare `requires_any`, the modules it serves. When none of them is enabled
the runner skips it with a log line instead of asking the user to switch it off:
`transform.frontmatter` serves both Markdown Publish modules, so a template with neither
enabled can keep Frontmatter and it simply does nothing. The same field is returned by
`GET /api/v1/modules` for the panel.

## Install

Python 3.12 is required.

```bash
uv venv --python 3.12
uv pip install -e ".[dev]"
```

MinerU 4.0.10 converts all PDF pages and exports Markdown, images, and structured
content. Parsing quality: `flash` for speed, `basic` (default) for OCR, formulas,
and tables, and `standard` / `advanced` for VLM-assisted parsing.

OCR language is automatic. Formula/table switches control exported blocks, not
inference or inline formulas. Configuration: `MINERU_HOME/config.yaml` or
`MINERU_CONFIG`. Models download as needed.

To update, stop the runtime, rerun installation with `--upgrade`, and restart.

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

| Id | Name | For |
| --- | --- | --- |
| `paper-to-markdown` | Journal Papers | Papers: VLM-assisted parsing, table digest, extracted References; the add-on's default |
| `paper-to-zotero-markdown` | Books Basic | Long documents: basic parser, 50-page chunks above 200 pages |
| `paper-to-zotero-markdown-copy` | Book Standard | Long documents with VLM-assisted parsing |

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
