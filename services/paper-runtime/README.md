# UniZero Paper Runtime

Optional local Python service (`/api/v1` on loopback) for PDF/EPUB extraction, Markdown
transformation, artifact publishing, and annotation injection. It never accesses Zotero
directly and refuses non-loopback `Host` headers or cross-site browser requests (`403
forbidden_origin`).

## Pipeline behavior

- **Extraction & content transform:** MinerU extracts every block; `transform.content`
  controls which formulas, figures, tables, and bibliography stay in Markdown (replacing
  omitted items with PDF page links) and emits ordered `ZoMiner References` records plus
  the HTML table-crop digest without calling external providers.
- **Publishing:** `publish.markdown-directory` writes Markdown (with frontmatter) to a
  vault or folder; `publish.zotero-markdown` stages Markdown and `attachments/` images in
  the runtime store, returning `zotero_md_path` / `zotero_md_images_dir` for the add-on to
  attach as Raw and Raw Backup. `requires_any` skips upstream helper modules (such as
  `transform.frontmatter`) automatically when no downstream consumer is enabled. Legacy
  stored templates are migrated on load ([LEGACY_SUPPORT.md](../../docs/LEGACY_SUPPORT.md)).
- **Cancellation:** `POST /api/v1/jobs/{job_id}/cancel` (`job-cancel` capability) drops
  queued jobs or kills a running MinerU process tree, cleans up its work directory, and
  settles as `cancelled` (`cancel_requested: true` while stopping). Once the first Publish
  module begins, cancellation is ignored so outputs never finish half-written.

## Install

Python 3.12 is required.

```bash
uv venv --python 3.12
uv pip install -e ".[dev]"
```

MinerU 4.2.3 parses PDFs (`flash`, default `basic`, or VLM-assisted `standard` /
`advanced`; configured via `MINERU_HOME/config.yaml` or `MINERU_CONFIG`, models downloaded
on demand). To upgrade, stop the runtime, rerun with `--upgrade`, and restart.

## Run

```bash
python -m unizero_runtime # options: --home PATH, --port N, --no-log-file
```

Usually started and stopped automatically by the Zotero add-on.

## Runtime home & built-in templates

Mutable state (`config.json`, `work/`, `store/`, `user_templates/`, `server.log`) lives
outside the package, resolved in order: `UNIZERO_RUNTIME_HOME` →
`%LOCALAPPDATA%\UniZero\runtime` (Windows) → `$XDG_DATA_HOME/unizero/runtime` or
`~/.local/share/unizero/runtime`.

| Id | Name | Purpose |
| --- | --- | --- |
| `paper-to-markdown` | Journal Papers | VLM-assisted parsing, table digest, extracted References (add-on default) |
| `paper-to-zotero-markdown` | Books Basic | Basic parser, 50-page chunks above 200 pages |
| `paper-to-zotero-markdown-copy` | Book Standard | Long documents with VLM-assisted parsing |
| `book-epub-to-zotero-markdown` | Books EPUB | EPUB without OCR or page links (never chunked by page) |

Source layout: [PROJECT_STRUCTURE.md](../../docs/PROJECT_STRUCTURE.md).

## Test

```bash
uv run --no-sync pytest
```

Tests run against an isolated runtime home (`tests/conftest.py`). End-to-end PDF
conversion with MinerU requires a manual check.

## License

AGPL-3.0-or-later. See the repository `LICENSE` and `NOTICE`.
