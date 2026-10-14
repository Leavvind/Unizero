# Roadmap

Open plans and recorded verification tasks only; this is not a work order.
Current behavior is in the component READMEs and [ARCHITECTURE.md](ARCHITECTURE.md).
Obsidian is the active product surface; do not extend legacy Home UI.

Feature ideas, manual checks, and code maintenance are listed separately below.
Manual checks are historical open records, not evidence of a known defect.

## Obsidian plugin

- **Import from Obsidian.** Let an explicit user action add or update papers in Zotero
  from exploration results. Not implemented; needs a separate write contract.
  The existing bridge only permits conversion through `POST /convert`.
- **Literature exploration.** Discover papers, sort results, and follow related papers
  from notes. The next concrete feature still needs to be chosen.

## Raw note

Current behavior: [add-on README](../apps/zotero-addon/README.md).
Maintenance constraints: [ZOTERO_NOTES.md](ZOTERO_NOTES.md).

- **Position links.** Improve links to blocks and headings after the desired behavior
  is clarified. Existing links already work.
- **Paste and tables.** Add Markdown paste and draggable table column widths.
  The other note editor enhancements are already implemented.
- **Long documents — manual check.** Verify every part syncs, Obsidian Raw opens part 1,
  and Replace reuses split notes and trashes only surplus marked parts.
- **Copy as Markdown — deferred.** Plain copy and paste already retains most formatting.
  Converting Zotero citations to `@libraryID/itemKey` depends on a way to insert
  citations in ordinary notes. No copy command or note-export bridge is implemented.
- **PDF highlights in Raw notes.** Annotation injection currently writes to vault
  Markdown only. A note equivalent needs a way to locate highlighted text after edits;
  existing heading and block links do not identify a text range.

## Verification

These remaining records have not been reconfirmed during documentation cleanup.
Run relevant checks when changing the affected area; host behavior is not covered by
TypeScript or Vitest. Obsidian basic behavior and Canvas/file bindings, plus Raw note
Replace and group-library links, were confirmed complete by the user on 2026-10-14
and removed from the open list.

- **Basic operation.** Startup/shutdown, metadata review, References/Citations previews,
  Collection status/actions, relation filtering, current-library import, conversion,
  artifact registration, and annotation injection.
- **Windows and settings.** Closing one window leaves another working. Settings persist;
  runtime port changes reach a manually started service. Automatic start/stop is silent;
  failed startup appears in Jobs with a working retry.
- **Conversion.** Personal/group libraries, same-title papers, repeated runs, and renamed
  generated attachments without affecting user attachments. Real MinerU output includes
  Markdown, tables, links, annotations, and References JSON, including empty references
  and replacement of stale output.
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
