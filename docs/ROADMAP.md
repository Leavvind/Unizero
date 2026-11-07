# Roadmap

Open plans and outstanding host checks only; this is not a work order. Current
behavior is in the component READMEs and [ARCHITECTURE.md](ARCHITECTURE.md). An open
check is not evidence of a known defect. Landed items are removed, not annotated.

## Obsidian plugin

- **Unified links and Backlinks — remaining host checks.** Implemented; the open
  checks (Markdown attachment choice, heading and block navigation, folder and offline
  moves, Zotero sources, Canvas, Unlinked mentions, and others) are the single ledger
  in [design handoff](UNIZERO_LINKS_DESIGN.md#宿主验收记录).
- **Import from Obsidian.** Let an explicit user action add or update papers in Zotero
  from exploration results. Not implemented; needs a separate write contract, since
  the bridge only acts on a paper's own Raw and Canvas.
- **Literature exploration.** Discover papers, sort results, and follow related papers
  from notes. The next concrete feature still needs to be chosen.

## Raw Markdown

- **Annotations into Raw.** Annotation injection writes to vault Markdown only; Raw is
  now a Markdown file too, but injecting into it would edit the user's working copy.

## Verification

Not yet reconfirmed in a real host; run the relevant check when changing that area.

- **Performance — host check.** Not run in a real host (user, 2026-11-07); automated
  regression tests cover the paths. In Zotero and a real vault, with disk caching on and
  off, check: cached DOI-only and empty Relations offline and explicit fetch; rapid
  edits, deletion during parsing, folder moves/deletions and rapid note switches;
  scrolling, filtering, keyboard selection, drag and context menus in a large Library
  collection; font sizing and multiple windows; group-library edits; reloading
  References/Citations after session-cache eviction.
- **EPUB conversion.** Reported passing (2026-11-07) without separate results for
  images, chapter headings, Raw/Raw Backup, and parent-item versus attachment entry
  points.
- **Literature cache.** Preserve distinct provider states across reopen, including empty
  OpenAlex/Crossref results and restricted Semantic Scholar. Switching A → B → A reuses
  cache quietly; misses show progress. Empty Citations persist across restart without
  treating failed requests as successful empty results.

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
