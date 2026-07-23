# How UniZero Was Assembled

UniZero was formed by merging two existing projects. That merge is finished: no code
remains to be copied, and `../Zoference` and `../ZoMiner` are no longer inputs to
development.

This document is a record, not a plan. It exists to answer two questions that keep coming
up while reading the code: *where did this come from* and *why is this identifier named
that*. Forward work is in [ROADMAP.md](ROADMAP.md); the readers that still support old
user data are in [COMPATIBILITY.md](COMPATIBILITY.md), and those are live code, not
history.

## The two sources

**Zoference** — a TypeScript Zotero add-on for references, citations, and metadata
enrichment. It supplied the add-on shell: build, lifecycle, item-pane integration,
preferences, localization. It is itself a fork of `MuiseDestiny/zotero-reference`, which
is why the whole add-on is AGPL-3.0-or-later.

**ZoMiner** — a plain-JavaScript Zotero plugin plus a Python `paper_service` for
MinerU-based PDF → Markdown conversion. Its Zotero-facing half was ported into the
add-on; its Python half became a real installable package.

Zoference was chosen as the host because reversing that — porting a TypeScript add-on
into a plain-JS one — would have meant giving up the build and the type checker to keep
662 lines of DOM code in place.

## Where things went

| Source | Now |
| --- | --- |
| `Zoference/addon` | `apps/zotero-addon/addon` |
| `Zoference/src/{index,addon,hooks}.ts` | same paths, renamed identifiers |
| `Zoference/src/modules/*` | `apps/zotero-addon/src/modules/*`, unchanged |
| ZoMiner `api-client.js`, `service.js` | `src/runtime-client/` |
| ZoMiner `commands.js`, `plugin.js` | `src/features/`, `src/ui/menus.ts`, `src/ui/panel.ts` |
| ZoMiner `zotero-adapter.js` | `src/zotero/` |
| ZoMiner `panel.{xhtml,js}` | `addon/chrome/content/panel.{xhtml,js}`, verbatim |
| `ZoMiner/paper_service/` | `services/paper-runtime/src/unizero_runtime/` |

Inside the runtime:

| ZoMiner | UniZero |
| --- | --- |
| `contracts.py` | `contracts.py` (package root) |
| `api.py` | `api/app.py` |
| `application.py` | `application/service.py` |
| `jobs.py`, `config.py` | `application/jobs.py`, `application/config.py` |
| `annotate.py` | `application/annotations.py` |
| `pipeline.py` | `pipeline/steps.py` |
| `workflow.py`, `postprocess.py` | `pipeline/workflow.py`, `pipeline/postprocess.py` |
| `template_store.py` | `pipeline/templates.py` |
| `s2.py` | `providers/semantic_scholar.py` |
| `references.py`, `tables_export.py`, `table_vlm.py` | `providers/` |
| `server.py` | `__main__.py` plus `scripts/server.py` |
| `migrate_flat.py`, `reprocess.py` | `scripts/` |

`contracts.py` sits at the package root rather than under `api/` so `application/` does
not import from the transport layer to see its own request models.

## Identifiers that changed

| Identifier | Zoference | UniZero |
| --- | --- | --- |
| add-on ID | `zoference@leavvind` | `unizero@leavvind` |
| global namespace | `Zotero.Zoference` | `Zotero.UniZero` |
| preference prefix | `extensions.zotero.zoference.*` | `extensions.zotero.unizero.*` |
| reference cache | `zoference.json` | `unizero.json` |
| locale prefix | `zoference-*.ftl` | `unizero-*.ftl` |
| XPI | `zoference.xpi` | `unizero.xpi`, version reset to 0.1.0 |

ZoMiner's preferences lived on the global Prefs branch at `extensions.zominer.*`, not
under `extensions.zotero.*`, and moved into two namespaces that reflect ownership:
`runtime.*` for the connection and `conversion.*` for conversion behavior.

Because the add-on ID changed, Zotero treats UniZero as a separate add-on rather than an
upgrade, so all three can be installed side by side. Every one of these renames has a
compatibility reader — see [COMPATIBILITY.md](COMPATIBILITY.md).

Internal CSS class names still use the `zoference-` prefix. They are private to the
injected stylesheet; renaming them would have been a large diff through `views.ts` with
no behavioral effect.

## Deliberate behavior changes

Everything else was moved at parity. These four were not:

**Runtime state left the source tree.** ZoMiner derived `config.json`, `work/`, `store/`
and `user_templates/` from `__file__`, so all mutable state lived inside the checkout.
That stops working once the package is installed: the code directory may be read-only,
and an upgrade replaces it. `paths.py` now resolves one runtime home from
`$UNIZERO_RUNTIME_HOME` or the platform user-data directory.

**Import-time side effects removed.** ZoMiner built its config store, template store,
application, and job manager as module-level singletons in `api.py`. Importing the
transport module therefore created directories, started a worker thread, and shelled out
to `mineru --version` — which is why that service had no tests. Wiring moved to
`composition.py`. `asgi.py` keeps a module-level `app` for the uvicorn command line,
where an import side effect is exactly what the caller asked for.

**The launch command is resolved, not configured.** ZoMiner required the user to supply
both a Python path and a `server.py` path. Packaging the runtime made both unnecessary;
`runtime-client/launch.ts` resolves the command, and explicit settings still win. The
port is now passed to the child process instead of being read independently from
`config.json` — the two could disagree, and the symptom was a service running correctly
while the add-on waited out a 60-second health check against the wrong port.

**Artifacts are identified by tag, not by attachment title.** ZoMiner matched generated
attachments by their display title, so renaming one produced duplicates and an
attachment the user happened to name `ZoMiner MD` could be erased. Ownership now comes
from a `unizero:<kind>` tag; see `src/zotero/artifactIdentity.ts`.

## What the merge was checked against

The add-on's Zotero-facing behavior and the runtime were manually exercised in Zotero on
2026-07-23: startup and shutdown, item pane, References, Citations, import/relate,
conversion, table and reference artifacts, and annotation injection, all driven by the
unified XPI with neither original add-on installed. The runtime's 43 tests cover paths,
template validation, reference extraction, frontmatter, annotation idempotency, and the
`/api/v1` contract.

Two things that check did *not* establish are still open and are tracked in
[ROADMAP.md](ROADMAP.md): whether artifacts are byte-equivalent to ZoMiner's for the same
PDF, and whether a pre-migration artifact is correctly adopted.

## The panel was not rewritten

`addon/chrome/content/panel.{xhtml,js}` came over verbatim — 1129 lines of plain
JavaScript and markup that run in their own dialog window, outside the esbuild bundle,
reaching the add-on only through an injected `api` object supplied by `src/ui/panel.ts`.
Rewriting it in TypeScript during the merge would have produced a diff nobody could check
line by line against the original behavior. It remains the one part of the add-on with no
type checking, which is a live cost rather than a settled one.
