# UniZero Zotero Add-on

The Zotero 8 application component. It owns Zotero lifecycle, UI, preferences,
scholarly-provider access, item and attachment mutations, and the client for the local
paper runtime.

## Capabilities

- metadata candidate lookup and identifier updates;
- References and Citations item-pane views;
- importing and relating discovered works;
- PDF conversion commands and generated-artifact registration;
- annotation export and Markdown injection;
- runtime status, jobs, templates, launch, and shutdown.

Document conversion and annotation injection require
`services/paper-runtime`. Other features run without it.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/core/` | Static feature registry and lifecycle dispatch |
| `src/features/` | Conversion and annotation command orchestration |
| `src/modules/` | Item pane, metadata, relations, providers, cache, preferences |
| `src/runtime-client/` | HTTP contracts, client, launch resolution, process state |
| `src/zotero/` | Zotero adapters, library scope, artifact identity |
| `src/ui/` | Menus, progress, and the panel bridge |
| `addon/` | Manifest, locales, preferences, icons, dialog markup |

New Zotero mutations belong in `src/zotero`; new command orchestration belongs in
`src/features`. Do not rewrite `src/modules` as a single refactor. Extract a focused
responsibility when a feature change needs it.

`addon/chrome/content/panel.js` is plain JavaScript outside the TypeScript bundle. It
currently implements the runtime-backed template editor and requires manual testing.

## Runtime connection

The add-on uses `/api/v1` on `127.0.0.1`. Launch resolution is implemented in
`src/runtime-client/launch.ts` and checks, in order:

1. an explicitly configured server script;
2. an explicitly configured Python interpreter;
3. a `PATH` interpreter that can import `unizero_runtime`;
4. the `unizero-runtime` console command.

The selected port is passed to the child process. Add-on preferences live under
*Settings → UniZero*; runtime-backed job and template controls live in the UniZero panel.

## Build

```bash
npm ci
npm run check
npm run build
```

`npm run check` runs TypeScript and HTTP-contract drift checks. `npm run build` writes
`build/unizero.xpi`.

## Run in Zotero

Copy `scripts/zotero-cmd-default.json` to the gitignored
`scripts/zotero-cmd.json`, then configure a Zotero executable and development profile.

```bash
npm run start-watch
```

For a packaged build, install `build/unizero.xpi` from Zotero's add-on manager.

Type checking does not verify Zotero APIs, window lifecycle, XUL, or the external panel.
Changes in those areas require a manual Zotero check.

## Related documentation

- [Repository architecture](../../docs/ARCHITECTURE.md)
- [Project structure](../../docs/PROJECT_STRUCTURE.md)
- [Legacy data support](../../docs/LEGACY_SUPPORT.md)
