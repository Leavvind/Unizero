# UniZero Zotero Add-on

The UniZero Zotero add-on. It owns Zotero lifecycle, UI, feature modules, scholarly
providers, Zotero adapters, preferences, and localization. In a later phase it will also
own the typed client for the local paper runtime.

## Current state (Phases 1–2)

Both source projects' Zotero-facing features are present, at behavior parity with their
originals.

From Zoference:

- item-pane section with References and Citations;
- reference and citation providers (OpenAlex, Crossref, Semantic Scholar, arXiv);
- identifier-based metadata enrichment;
- import and relate discovered items;
- hover/click tip cards and preferences.

From ZoMiner:

- PDF → Markdown conversion driven by runtime templates, from the item context menu;
- annotation injection into generated Markdown;
- Markdown, tables, and references artifact registration;
- local runtime process management with Python auto-detection;
- the panel under *Tools → UniZero 面板…* for service status, jobs, runtime settings,
  and the template editor.

The add-on talks to [`services/paper-runtime`](../../services/paper-runtime) over
`/api/v1`. It resolves how to launch it in this order, first match wins:

| Order | Condition | Command |
| --- | --- | --- |
| 1 | *server.py 路径* is set | `<python> <script> --port N` |
| 2 | *Python 路径* is set | `<python> -m unizero_runtime --port N` |
| 3 | a `python` on `PATH` can import `unizero_runtime` | `<python> -m unizero_runtime --port N` |
| 4 | `unizero-runtime` is on `PATH` | `unizero-runtime --port N` |

So both path settings are optional once the runtime is installed. Explicit settings
always beat discovery — a ZoMiner user whose migrated `serverScript` points at the old
`paper_service/server.py` keeps running that, and clears the setting to move over.

Order 3 precedes 4 because on Windows it can select `pythonw.exe`, while pip's
`unizero-runtime.exe` is a console program and leaves a terminal window open.

The port is passed on the command line rather than left to the runtime's `config.json`:
when each side reads its own port, the service comes up fine and the add-on waits
forever on a health check that will never answer.

Resolution lives in [`src/runtime-client/launch.ts`](src/runtime-client/launch.ts); it
also mirrors the runtime-home rules from the Python side's `paths.py` so a crashed
startup can still be explained from `server.log`.

No phase has passed its manual Zotero check yet.

## Source layout

Two layouts coexist inside `src/`, on purpose:

| Path | Origin |
| --- | --- |
| `src/modules/` | Zoference, flat, migrated as-is in Phase 1 |
| `src/runtime-client/` | typed client, contracts, settings, and process management |
| `src/features/` | conversion and annotation commands |
| `src/zotero/` | the only code that mutates Zotero items |
| `src/ui/` | menus, panel, progress reporting |

New code goes in the second layout, which is the target described in
[`../../docs/PROJECT_STRUCTURE.md`](../../docs/PROJECT_STRUCTURE.md). Moving the
Zoference modules over belongs to their own migration phases.

## Build

```bash
npm ci
```

```bash
npm run build
```

`npm run build` runs the production bundle and the type check concurrently and writes
`build/unizero.xpi`.

Type check alone:

```bash
npm run check
```

## Run in Zotero

Copy `scripts/zotero-cmd-default.json` to `scripts/zotero-cmd.json` and fill in your
Zotero binary path and a development profile path. That file is machine-local and
gitignored.

```bash
npm run start-watch
```

This builds a development bundle, launches Zotero against the dev profile, and reloads
the add-on when `src/**` or `addon/**` changes.

To install the packaged add-on manually, use `build/unizero.xpi` via Zotero's
*Tools → Add-ons → Install Add-on From File*.

## Naming and compatibility

UniZero is the third name in the Zoference lineage: `zoteroreference` → `zoference` →
`unizero`, and it also absorbs ZoMiner's `extensions.zominer.*` preferences. The add-on
ID, preference prefix, cache filename, and localization prefix all derive from
`config.addonRef` in [`package.json`](package.json).

Because the add-on ID changed, Zotero treats UniZero as a separate add-on rather than an
upgrade — it can be installed alongside Zoference and ZoMiner during development. Three
compatibility readers cover the transition:

- [`src/modules/migrate.ts`](src/modules/migrate.ts) copies preferences the user
  explicitly changed, once, walking `config.legacyAddonRefs` newest-first, guarded by
  `unizero.legacyPrefsMigrated`;
- [`src/modules/localStorage.ts`](src/modules/localStorage.ts) falls back to the older
  reference cache files so users do not re-parse their whole library;
- [`src/runtime-client/settings.ts`](src/runtime-client/settings.ts) copies ZoMiner's
  preferences from `extensions.zominer.*`, guarded by
  `unizero.legacyRuntimePrefsMigrated`.

The runtime reader is separate from the Zoference one because ZoMiner kept its keys on
the global Prefs branch rather than under `extensions.zotero.*`.

All three leave the old state in place. Do not remove any of them without a documented
migration.

Internal CSS class names still use the `zoference-` prefix. They are private to the
injected stylesheet and were deliberately left alone in Phase 1 to keep the migration
diff reviewable.

## Licensing

AGPL-3.0-or-later, inherited from Zoference and from its upstream
`MuiseDestiny/zotero-reference`. See [`../../LICENSE`](../../LICENSE) and
[`../../NOTICE`](../../NOTICE).

## See also

- [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- [`../../docs/MIGRATION.md`](../../docs/MIGRATION.md)
