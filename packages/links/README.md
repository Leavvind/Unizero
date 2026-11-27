# @unizero/links

The UniZero link grammar and document scanning shared by the Obsidian plugin and the
Zotero add-on, so both agree on what counts as one mention
([UNICONNECTION.md](../../docs/UNICONNECTION.md) §1–§3).

```text
src/linkTarget.ts     Strict `unizero://` parsing and canonical serialization
src/documentLinks.ts  Markdown/Canvas link scanning, evidence units, text anchors
src/roles.ts          Paper-to-paper vs. ordinary links; `zotero://open-pdf` anchors
tests/                Vitest over the shared contract
```

Plain TypeScript with no host APIs and no Node built-ins (the add-on runs in Zotero's
privileged Firefox environment). It ships as source: both apps depend on it with
`file:../../packages/links` and bundle it. npm links the folder without installing its
dependencies, so install them here first:

```bash
npm ci
npm run check
npm test
```

A change here also needs `npm run check && npm test` in `apps/obsidian-plugin` and
`apps/zotero-addon`. Labels and other presentation stay in each app.
