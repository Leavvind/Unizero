# UniZero Zotero Add-on

The UniZero Zotero add-on. It owns Zotero lifecycle, UI, feature modules, scholarly
providers, Zotero adapters, preferences, localization, and the typed client for the local
paper runtime.

## What it does

Library and literature features:

- item-pane section with References and Citations;
- reference and citation providers (OpenAlex, Crossref, Semantic Scholar, arXiv);
- identifier-based metadata enrichment;
- import and relate discovered items;
- hover/click tip cards and preferences.

Document features, which need the runtime:

- PDF → Markdown conversion driven by runtime templates, from the item context menu;
- annotation injection into generated Markdown;
- Markdown, tables, and references artifact registration;
- local runtime process management with Python auto-detection;
- the panel under *Tools → UniZero 面板…* for service status, jobs, and the template
  editor.

## Where settings live

Every Zotero preference is in one place, *Settings → UniZero*: data sources, refresh,
tips, related, save policy, and matching, plus the local service (Python path, server
script, port, autostart, autostop) and conversion (Markdown copy).

The panel holds only what needs the runtime to be running — status, jobs, templates, and
the service's own output and work directories, which live in its `config.json` and are
fetched over HTTP.

That is the boundary: **where a setting is stored and when it can be read**, not which
feature it belongs to. Putting the service directories in the preference pane would give
a group of inputs that are blank whenever the service is stopped.

The runtime and conversion groups in the pane are wired in
[`src/modules/prefs.ts`](src/modules/prefs.ts) rather than through XUL `preference=`
bindings, so all writes keep going through the typed `setRuntimePref` /
`setConversionPref` accessors instead of gaining a second path to the same keys.

The add-on talks to [`services/paper-runtime`](../../services/paper-runtime) over
`/api/v1`. It resolves how to launch it in this order, first match wins:

| Order | Condition | Command |
| --- | --- | --- |
| 1 | *server.py 路径* is set | `<python> <script> --port N` |
| 2 | *Python 路径* is set | `<python> -m unizero_runtime --port N` |
| 3 | a `python` on `PATH` can import `unizero_runtime` | `<python> -m unizero_runtime --port N` |
| 4 | `unizero-runtime` is on `PATH` | `unizero-runtime --port N` |

So both path settings are optional once the runtime is installed. Explicit settings
always beat discovery — a user whose `serverScript` still points at a ZoMiner
`paper_service/server.py` keeps running that, and clears the setting to move over.

Order 3 precedes 4 because on Windows it can select `pythonw.exe`, while pip's
`unizero-runtime.exe` is a console program and leaves a terminal window open.

The port is passed on the command line rather than left to the runtime's `config.json`:
when each side reads its own port, the service comes up fine and the add-on waits
forever on a health check that will never answer.

Resolution lives in [`src/runtime-client/launch.ts`](src/runtime-client/launch.ts); it
also mirrors the runtime-home rules from the Python side's `paths.py` so a crashed
startup can still be explained from `server.log`.

All of this was manually checked in Zotero on 2026-07-23; launch resolution itself has
only been checked from the command line so far.

## Source layout

Two layouts coexist inside `src/`, on purpose:

| Path | Contents |
| --- | --- |
| `src/modules/` | Zoference's original flat layout, carried over as-is |
| `src/core/` | static feature registry and symmetric lifecycle dispatch |
| `src/runtime-client/` | typed client, contracts, settings, and process management |
| `src/features/` | conversion and annotation commands |
| `src/zotero/` | new Zotero adapters and library-scoped identity helpers |
| `src/ui/` | menus, panel, progress reporting |

New feature code keeps Zotero mutations in `src/zotero/`. The predecessor
`src/modules/` layout still contains Zotero mutations and is extracted incrementally.

New code goes in the second layout, described in
[`../../docs/PROJECT_STRUCTURE.md`](../../docs/PROJECT_STRUCTURE.md). The flat modules
are extracted incrementally, when that code is being touched for another reason —
`views.ts` alone is 2112 lines and has no tests, so a dedicated refactor buys less than
it risks.

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
upgrade — it can be installed alongside Zoference and ZoMiner. Several readers cover the
transition, including preference copiers in
[`src/modules/migrate.ts`](src/modules/migrate.ts) and
[`src/runtime-client/settings.ts`](src/runtime-client/settings.ts), a cache fallback in
[`src/modules/localStorage.ts`](src/modules/localStorage.ts), and title-based adoption of
pre-migration artifacts in
[`src/zotero/conversionAdapter.ts`](src/zotero/conversionAdapter.ts).

They all leave the old state in place. Each is inventoried with its retirement condition
in [`../../docs/COMPATIBILITY.md`](../../docs/COMPATIBILITY.md); do not remove one as
cleanup.

Internal CSS class names still use the `zoference-` prefix. They are private to the
injected stylesheet, so renaming them would be a large diff through `views.ts` with no
behavioral effect.

## Licensing

AGPL-3.0-or-later, inherited from Zoference and from its upstream
`MuiseDestiny/zotero-reference`. See [`../../LICENSE`](../../LICENSE) and
[`../../NOTICE`](../../NOTICE).

## See also

- [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- [`../../docs/COMPATIBILITY.md`](../../docs/COMPATIBILITY.md)
- [`../../docs/ROADMAP.md`](../../docs/ROADMAP.md)
