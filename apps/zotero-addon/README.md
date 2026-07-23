# UniZero Zotero Add-on

The UniZero Zotero add-on. It owns Zotero lifecycle, UI, feature modules, scholarly
providers, Zotero adapters, preferences, and localization. In a later phase it will also
own the typed client for the local paper runtime.

## Current state (Phase 1)

Migrated from Zoference at behavior parity. Present today:

- item-pane section with References and Citations;
- reference and citation providers (OpenAlex, Crossref, Semantic Scholar, arXiv);
- identifier-based metadata enrichment;
- import and relate discovered items;
- hover/click tip cards and preferences.

Not yet present: ZoMiner conversion, annotation export, and runtime process management.
Those arrive in Phase 2. See [`../../docs/MIGRATION.md`](../../docs/MIGRATION.md).

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

UniZero is the third name in this lineage: `zoteroreference` → `zoference` → `unizero`.
The add-on ID, preference prefix, cache filename, and localization prefix all derive from
`config.addonRef` in [`package.json`](package.json).

Because the add-on ID changed, Zotero treats UniZero as a separate add-on rather than an
upgrade — it can be installed alongside Zoference during development. Two compatibility
readers cover the transition, both keyed on `config.legacyAddonRefs` (ordered newest
first):

- [`src/modules/migrate.ts`](src/modules/migrate.ts) copies preferences the user
  explicitly changed, once, guarded by `unizero.legacyPrefsMigrated`;
- [`src/modules/localStorage.ts`](src/modules/localStorage.ts) falls back to the older
  reference cache files so users do not re-parse their whole library.

Both leave the old preferences and cache files in place. Do not remove either reader
without a documented migration.

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
