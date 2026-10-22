# Roadmap

Open plans and recorded verification tasks only; this is not a work order.
Current behavior is in the component READMEs and [ARCHITECTURE.md](ARCHITECTURE.md).
Obsidian is the active product surface; do not extend legacy Home UI.

Feature ideas, manual checks, and code maintenance are listed separately below.
Manual checks are historical open records, not evidence of a known defect.

## Obsidian plugin

- **Import from Obsidian.** Let an explicit user action add or update papers in Zotero
  from exploration results. Not implemented; needs a separate write contract.
  The existing bridge only acts on the user's own artifacts (convert, create Canvas,
  trash Raw or Canvas, restore Raw).
- **Literature exploration.** Discover papers, sort results, and follow related papers
  from notes. The next concrete feature still needs to be chosen.

## Raw Markdown

Current behavior: [add-on README](../apps/zotero-addon/README.md).

- **Raw attachments — manual check.** In a real Zotero, convert with
  `paper-to-zotero-markdown` and check that Raw and Raw Backup appear, that opening Raw
  from Zotero and from Obsidian's Raw action opens Obsidian, that a second conversion
  replaces only Raw Backup, that deleting Raw lets the next conversion recreate it, and
  that a supplement gets its own pair. With `images_mode: all`, check that images show
  beside both files and survive Zotero file sync (WebDAV and Zotero storage).
- **Raw and Canvas management — manual check.** In a real Zotero and vault, check
  that Re-convert with a Raw replaces only Raw Backup; that Restore Raw from Raw Backup
  trashes the old Raw, keeps images, and opens the new one; that both trash actions
  ask first and land in Zotero's trash; that a Raw or Canvas whose file was deleted
  offers its repair choices and that converting again replaces such a Raw; and that a
  read-only group library reports the refusal.
- **Annotations into Raw.** Annotation injection writes to vault Markdown only; Raw is
  now a Markdown file too, but injecting into it would edit the user's working copy.

## Zotero reader

- **Highlight shortcuts — manual check.** In a real Zotero, check that `Cmd+Option+B/R/P`
  turn a PDF, EPUB and snapshot selection into a highlight annotation of that color
  without changing the reader's tool color (also in split view's second view), that
  `Ctrl+Alt` does the same on Windows while AltGr still types its characters, and that
  annotation comments keep their keys.

## Verification

These remaining records have not been reconfirmed during documentation cleanup.
Run relevant checks when changing the affected area; host behavior is not covered by
TypeScript or Vitest. Obsidian basic behavior and Canvas/file bindings were confirmed
complete by the user on 2026-10-14, and Canvas attachments, basic operation, windows
and settings, and conversion on 2026-10-22; those were removed from the open list.

- **Literature cache.** Preserve distinct provider states across reopen, including empty
  OpenAlex/Crossref results and restricted Semantic Scholar. Switching A → B → A reuses
  cache quietly; misses show progress. Empty Citations persist across restart without
  treating failed requests as successful empty results.
- **Legacy UI — only when touched.** Board text caret under refresh, Graph dark theme,
  layout persistence, and guarded rendering callbacks.

## Contracts and artifacts

These are add-on/runtime communication and output-format improvements.

- **Document all HTTP messages.** Cover configuration, job lists, module descriptions,
  template writes, and shutdown in the shared schema.
- **Check message values.** Validate allowed values as well as field names and required fields.
- **Version generated output.** Define a shared versioned wrapper for Markdown and tables
  so readers can identify the output format.
- **Explain incompatible versions.** Tell users which add-on/runtime component to upgrade.

## Add-on maintainability

These are code maintenance tasks, not new user features.

- **Catch startup dependency failures.** Add a no-DOM bundle evaluation to `npm run check`;
  a dependency using `document` during load previously disabled the add-on.
- **Test core logic.** Cover feature registration, the HTTP client, library scope,
  generated-artifact identity, and metadata comparison without requiring Zotero.
- **Reduce `views.ts` responsibilities when touched.** Separate view state, network work,
  and Zotero mutations as related features change; no standalone wholesale rewrite.
- **Type-check the template editor.** Move its logic from `addon/chrome/content/panel.js`
  into the TypeScript build.

## Background ideas

These are possibilities, not selected implementation tasks.

- **Publication ranking.** Use an explicit data provider before offering a ranking filter;
  do not guess from publication names.
- **Review metadata field by field.** Accept or reject individual conflicting fields
  instead of the entire candidate paper.
- **Show data source and age.** Record the source and retrieval time for changing values
  such as citation counts.
- **Annotation presets.** Configure annotation types, colors, tags, comments, and how
  managed output is generated.
