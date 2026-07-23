# Migration Plan

This document controls the staged integration of Zoference and ZoMiner into UniZero.
It is a plan, not a statement of implemented features.

## Migration principles

- Move behavior before redesigning it.
- Keep each phase buildable and manually inspectable.
- Preserve legacy data readers before changing writers.
- Do not migrate generated output or user-local state.
- Add tests around boundaries before changing those boundaries.
- Keep the original repositories intact until UniZero reaches feature parity.

## Source-to-target map

| Source | Target | Strategy |
| --- | --- | --- |
| `Zoference/addon` | `apps/zotero-addon/addon` | Use as the initial manifest, locale, and preference foundation |
| `Zoference/src/index.ts`, `addon.ts`, `hooks.ts` | add-on lifecycle and core | Migrate first; preserve symmetric cleanup |
| `Zoference/src/modules/metadataEnrichment.ts` | `features/metadata` | Move at parity, then separate resolution, review, and write-back |
| Zoference references/citations modules | `features/relations` and `providers` | Separate application orchestration from provider adapters |
| `Zoference/src/modules/views.ts` | `ui` plus feature services | Do not copy as the long-term boundary; extract incrementally |
| ZoMiner `api-client.js`, `service.js` | `runtime-client` | Port to TypeScript behind a typed client |
| ZoMiner `commands.js`, `plugin.js` | conversion/annotation features and UI | Port capability by capability |
| ZoMiner `zotero-adapter.js` | Zotero adapters and artifact registry | Preserve behavior, then replace title-based identity |
| `ZoMiner/paper_service` | `services/paper-runtime` | Migrate at behavior parity before package refactoring |
| ZoMiner built-in templates | runtime `templates` | Preserve IDs and support user-template discovery |
| `zominer.references/1` fixtures | `packages/contracts/legacy` | Keep readable during the transition |

## Files that must not be migrated

- source-repository `.git` directories;
- `node_modules`, build output, XPI files, Python environments;
- `.env`, machine-local config, logs, caches;
- `paper_service/work`, `paper_service/store`, and user template overrides;
- real Zotero library data or published vault notes.

Use synthetic fixtures when contract examples require representative data.

## Phase 0 — Foundation

Status: **complete**

Deliverables:

- English repository README and contributor instructions;
- architecture and project-structure documents;
- migration map and accepted runtime-boundary ADR;
- empty ownership directories with no placeholder implementation;
- licensing and attribution decision before source migration.

Exit gate:

- every planned code destination has one clear owner;
- current and target behavior are clearly distinguished;
- no source code or user-local state has been copied;
- the combined license and notice approach is recorded.

## Phase 1 — Unified add-on shell

Status: **code migrated; manual Zotero check outstanding**

Use Zoference as the initial add-on host.

Deliverables:

- working TypeScript add-on build under `apps/zotero-addon` — done;
- UniZero lifecycle and namespace — done, `Zotero.UniZero` via `config.addonInstance`;
- preferences and legacy preference migration strategy — done, see below;
- References/Citations behavior retained — code migrated unchanged;
- metadata identifier completion retained — code migrated unchanged;
- old and new add-ons can be distinguished during development — done, the add-on ID
  changed to `unizero@leavvind` so both can be installed side by side.

### Identifier changes made in this phase

| Identifier | Zoference | UniZero | Compatibility |
| --- | --- | --- | --- |
| add-on ID | `zoference@leavvind` | `unizero@leavvind` | none needed; separate add-on |
| global namespace | `Zotero.Zoference` | `Zotero.UniZero` | debug hooks follow `addonInstance` |
| preference prefix | `extensions.zotero.zoference.*` | `extensions.zotero.unizero.*` | one-time copy in `src/modules/migrate.ts` |
| reference cache | `zoference.json` | `unizero.json` | read-only fallback in `src/modules/localStorage.ts` |
| locale prefix | `zoference-*.ftl` | `unizero-*.ftl` | build-time, no user state |
| XPI | `zoference.xpi` | `unizero.xpi` | new release line, version reset to 0.1.0 |

`config.legacyAddonRef` became `config.legacyAddonRefs`, an array ordered newest first
(`["zoference", "zoteroreference"]`), so users coming directly from zotero-reference are
still covered. Both compatibility readers leave the old state in place.

Internal `zoference-` CSS class names were left unchanged: they are private to the
injected stylesheet, and renaming them would have added a large diff to `views.ts` with
no behavioral effect.

Exit gate:

- [x] type check and production build pass;
- [ ] the XPI installs in Zotero;
- [ ] startup, item pane, References, Citations, import/relate, and shutdown are manually
      checked;
- [x] no ZoMiner capability is claimed yet.

Phase 2 must not start until the manual check passes, because parity with Zoference is
the only thing this phase asserts.

## Phase 2 — ZoMiner add-on capability port

Status: **code ported; manual Zotero check outstanding**

Port the Zotero-facing parts of ZoMiner into the unified add-on without moving the
Python runtime yet.

Deliverables:

- typed runtime API client and health negotiation — `src/runtime-client/`;
- runtime process management — `src/runtime-client/process.ts`;
- conversion and annotation commands — `src/features/{conversion,annotations}/`;
- conversion target and Zotero snapshot adapters — `src/zotero/`;
- template-management UI — `src/ui/panel.ts` plus `addon/chrome/content/panel.*`;
- existing artifact attachment behavior — preserved, including the legacy
  `Academic MD` title and the `zominer.references/1` schema.

### Structure

New code follows the target layout in `PROJECT_STRUCTURE.md` rather than Zoference's
flat `src/modules/`. The Zoference modules stay where they are until their own phases
move them, so the two layouts coexist for now — this is expected, not drift.

The panel dialog (`addon/chrome/content/panel.{xhtml,js}`) was migrated verbatim. It
runs in its own window, is not part of the esbuild bundle, and touches the add-on only
through a single injected `api` object. Rewriting 662 lines of DOM code in TypeScript
would produce a diff nobody could check line by line against the original behavior.
`src/ui/panel.ts` supplies that `api` object and is the only adapter needed.

### Preference migration

ZoMiner kept its preferences on the global branch at `extensions.zominer.*`, not under
`extensions.zotero.*`. They are copied once into two namespaces that reflect ownership:

| ZoMiner | UniZero |
| --- | --- |
| `extensions.zominer.pythonPath` | `extensions.zotero.unizero.runtime.pythonPath` |
| `extensions.zominer.serverScript` | `extensions.zotero.unizero.runtime.serverScript` |
| `extensions.zominer.port` | `extensions.zotero.unizero.runtime.port` |
| `extensions.zominer.autoStart` | `extensions.zotero.unizero.runtime.autoStart` |
| `extensions.zominer.autoStopOnQuit` | `extensions.zotero.unizero.runtime.autoStopOnQuit` |
| `extensions.zominer.mdSnapshot` | `extensions.zotero.unizero.conversion.mdSnapshot` |

`migrateLegacyRuntimePrefs()` is separate from `migrateLegacyPrefs()` because the two
read different Prefs branches; merging them would tangle the branch handling. It copies
only keys the user explicitly set, never overwrites an existing value, and enumerates
key names explicitly so abandoned experimental keys are not inherited.

Exit gate:

- [x] type check and production build pass;
- [ ] the unified XPI can drive the existing ZoMiner service;
- [ ] conversion, table artifact, reference artifact, and annotation injection match the
      source behavior;
- [ ] the separate ZoMiner XPI is not required for the manual check.

### Deferred to later phases, deliberately

- Artifacts are still identified by attachment title. Renaming an attachment in Zotero
  still produces duplicates. Fixing it needs explicit artifact identity across the
  add-on/runtime contract — Phase 4.
- Annotation support is still limited to highlights and underlines with plain text —
  Phase 6.
- `library_id` defaults to `1` when absent, inherited from ZoMiner. Group libraries need
  auditing before this is trusted — Phase 4.

## Phase 3 — Paper runtime migration

Status: **migrated; end-to-end conversion check outstanding**

Move `paper_service` into `services/paper-runtime` at behavior parity.

Deliverables:

- real Python package layout and dependency configuration — `src/unizero_runtime/`,
  hatchling, `unizero-runtime` console script;
- existing `/api/v1` compatibility — unchanged, verified by `tests/test_api_contract.py`;
- built-in templates and user-template discovery — built-ins are package data, user
  overrides live in the runtime home;
- tests for workflow validation, reference extraction, frontmatter, and annotation
  idempotency — 43 tests;
- clean handling of runtime store, work, and config paths — see below.

### Module mapping

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
| `server.py` | `__main__.py` plus `scripts/server.py` launcher |
| `migrate_flat.py`, `reprocess.py` | `scripts/` |

`contracts.py` sits at the package root rather than under `api/` so that `application/`
does not have to import from the transport layer to see the request models.

### Runtime state moved out of the source tree

The one intentional behavior change. ZoMiner derived `config.json`, `work/`, `store/`
and `user_templates/` from `__file__`, so all runtime state lived inside the checkout.
That stops working once the package is installed: the code directory may be read-only,
and an upgrade replaces it.

`paths.py` resolves a single runtime home from `$UNIZERO_RUNTIME_HOME`, falling back to
the platform's user-data directory. Built-in templates stay package data, since they
ship with the code and should be replaced on upgrade.

Compatibility for existing ZoMiner users is a one-line action rather than a migration:
point `UNIZERO_RUNTIME_HOME` at the old `paper_service` directory. The layout inside is
identical, so existing config, work, store and user templates are adopted as they are.
`tests/test_paths.py` covers this.

### Import-time side effects removed

ZoMiner built its config store, template store, application and job manager as
module-level singletons in `api.py`. Importing the transport module therefore created
directories, started the worker thread, and shelled out to `mineru --version`, which is
why the service had no tests. Wiring moved to `composition.py`; `asgi.py` keeps a
module-level `app` for the uvicorn command line, where an import side effect is exactly
what the caller asked for.

Exit gate:

- [x] runtime tests pass — 43 passed;
- [x] the runtime boots, reports the capabilities the add-on requires, and serves
      templates from package data;
- [ ] existing conversion fixtures produce equivalent artifacts;
- [ ] the unified add-on can start, query, and stop the migrated runtime.

The remaining two need MinerU on a real PDF and a running Zotero. The test suite
deliberately does not fake them: a mocked conversion would assert that the mocks agree
with each other, not that artifacts are unchanged.

## Phase 4 — Contracts and artifact integration

Replace implicit cross-feature coupling with explicit contracts.

Deliverables:

- versioned nested item and attachment snapshot;
- common artifact envelope;
- artifact registry keyed by library, item, attachment, kind, and schema;
- direct delivery of extracted references from conversion jobs;
- legacy `zominer.references/1` reader retained;
- cache key and persistence correctness fixes.

Exit gate:

- stale add-on/runtime combinations fail with a clear compatibility message;
- group-library keys do not collide;
- artifact lookup does not depend only on display titles;
- legacy reference attachments still populate the relations feature.

## Phase 5 — Canonical metadata and frontmatter

Expand identifier completion into field-level metadata management.

Deliverables:

- normalized candidate model with provider provenance;
- identity resolution before field merging;
- review UI for missing and conflicting fields;
- transactional Zotero write-back;
- frontmatter field projection over a fresh Zotero snapshot;
- Semantic Scholar enrichment removed from the default conversion template while the
  provider remains available to metadata and relations features.

Exit gate:

- metadata changes are previewable and reversible through Zotero history where
  available;
- conversion reflects newly applied Zotero metadata;
- template authors control which Zotero fields enter frontmatter;
- volatile citation data is labeled with source and retrieval time.

## Phase 6 — Annotation profiles and export modes

Deliverables:

- normalized type, color, tags, comment, and position data;
- profile-driven rendering;
- inline, managed-section, and standalone output modes;
- stable markers for managed output;
- dry-run and unmatched-annotation report;
- compatibility with existing injected annotation keys.

Exit gate:

- repeated runs are idempotent;
- highlight and underline can render differently;
- profile behavior is testable without Zotero;
- living Markdown is not regenerated or overwritten unexpectedly.

## Cross-cutting migration work

### Licensing and attribution

Status: **done for the add-on; open for the runtime.**

Zoference is a fork of `MuiseDestiny/zotero-reference` — its git history starts with
commits by Polygon (MuiseDestiny), and upstream is AGPL-3.0. UniZero's add-on is
therefore a second-generation derivative and inherits AGPL-3.0-or-later. That is not a
choice: the upstream copyright holder's terms carry forward, and the copyright and
license notices must be preserved in any distribution.

Completed:

- full AGPL-3.0-or-later text in `LICENSE`;
- upstream and modifier copyright notices in `NOTICE`;
- notices for bundled components (zotero-plugin-toolkit, zotero-plugin-template,
  zotero-types) in `NOTICE`.

Open:

- the license for original ZoMiner code. `paper_service` is original work that runs as a
  separate process behind an HTTP contract, so it is not a derivative of the AGPL add-on
  and may carry a different license. Decide before Phase 3 and record it in `NOTICE`.

### Naming and compatibility

Track migrations for:

- add-on ID and global Zotero namespace;
- preference prefixes;
- cache filenames and keys;
- XPI and update-manifest filenames;
- attachment titles and generated tags;
- service names, ports, and local paths;
- template and artifact schema IDs.

Display names may change early. Stable identifiers change only with a compatibility
reader or explicit one-time migration.

### Verification

Every phase updates:

- root documentation;
- component build and test commands;
- manual Zotero smoke-check steps;
- migration status in this document.

