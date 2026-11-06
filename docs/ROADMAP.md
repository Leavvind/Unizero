# Roadmap

Open plans and recorded verification tasks only; this is not a work order.
Current behavior is in the component READMEs and [ARCHITECTURE.md](ARCHITECTURE.md).
Obsidian is the active product surface; do not extend legacy Home UI.

Feature ideas, manual checks, and code maintenance are listed separately below.
Manual checks are historical open records, not evidence of a known defect.

## Obsidian plugin

- **Unified links — remaining host verification.** Run the new Zotero source
  directory and target resolver against a real library: all four link directions,
  unopened attachments, external edits, offline cache, multiple PDFs/Raw files,
  deletion/restore, Canvas navigation, folder/offline moves, and multiple windows.
  Vault rename, reading links and Backlinks were checked in Obsidian. On 2026-11-06,
  native paper badges were also checked in Live Preview and reading view under
  Baseline, including opening the Item pane from a styled Live Preview link.
  Formatted labels, light mode and multi-window styling still need host checks. Detailed results:
  [design handoff](UNIZERO_LINKS_DESIGN.md#15-本次施工与宿主验收记录).
- **Merged Backlinks — host check.** In a real Vault, check that UniZero Backlinks
  lists wikilinks, embeds, Markdown links and property links beside UniZero links,
  refreshes after an edit or rename, shows native links for a note without a UID, and
  how links from a Vault Canvas appear. Wikilinks inside Zotero documents are not read.
  Also check Unlinked mentions: title and alias matches in Chinese and English notes,
  that **Link** writes a UniZero link (assigning a UID if needed), and how long the
  first expansion takes in a large Vault.
- **Import from Obsidian.** Let an explicit user action add or update papers in Zotero
  from exploration results. Not implemented; needs a separate write contract, since
  the bridge only acts on a paper's own Raw and Canvas.
- **Literature exploration.** Discover papers, sort results, and follow related papers
  from notes. The next concrete feature still needs to be chosen.

## Raw Markdown

Current behavior: [add-on README](../apps/zotero-addon/README.md).
- **EPUB conversion — manual check.** In a real Zotero, convert an EPUB book with the
  Books EPUB template and check that Raw and Raw Backup appear with the book's images,
  that headings follow the book's chapters, and that converting the EPUB attachment
  itself and its parent item both work.
- **Annotations into Raw.** Annotation injection writes to vault Markdown only; Raw is
  now a Markdown file too, but injecting into it would edit the user's working copy.


## Zotero reader

- **Highlight shortcuts — manual check.** In a real Zotero, check that `Cmd+Option+B/R/P`
  turn a PDF, EPUB and snapshot selection into a highlight annotation of that color
  without changing the reader's tool color (also in split view's second view), that
  `Ctrl+Alt` does the same on Windows while AltGr still types its characters, and that
  annotation comments keep their keys.

## Verification

Not yet reconfirmed in a real host; run the relevant check when changing that area.

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
