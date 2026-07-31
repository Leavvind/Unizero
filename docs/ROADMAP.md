# Roadmap

This file contains unfinished work only. Current behavior is documented in the component
READMEs and `docs/ARCHITECTURE.md`.

## Verification

- Run the full add-on smoke check in Zotero: startup, shutdown, metadata review,
  References/Citations previews, Unizero Home Tools/item-toolbar/Collection
  context-menu entry, selected-paper item context-menu entry, Collection
  status/quick actions, relation filtering and current-library import, conversion,
  artifact registration, and annotation injection.
- Verify two-window cleanup: closing one main window must not remove the other window's
  pane or menus.
- Verify personal and group-library conversion with same-title items and repeated runs.
- Verify generated attachment identity after rename and confirm similarly titled user
  attachments are untouched.
- Exercise preferences through close/reopen and confirm runtime port changes reach a
  manually started service.
- Verify the automatic service start and stop: silent startup, shutdown on quit, a
  failed start appearing as a notice in the panel's Jobs list, and its retry action.
- Run a real MinerU conversion and inspect Markdown, tables, links, annotation output,
  and the versioned structured `ZoMiner References` JSON artifact, including an empty
  bibliography and a re-conversion that replaces a stale artifact.
- In Zotero, verify a References query where OpenAlex and Crossref are empty while
  Semantic Scholar is restricted: all three source states must remain visible after
  closing and reopening Unizero Home.
- In Zotero, verify Collection Preview A → B → A reuses A without provider progress,
  a real cache miss does show current-source progress, and a completed zero-Citations
  result survives one restart without turning an all-provider failure into a cache hit.
- Verify graph behaviour beyond a first look: dark theme, layout persistence across a
  restart, a library large enough to stress readability, the graph status line after an
  induced callback failure, rapid switching/closing of paper tabs, personal/group library
  context changes, immediate topology refresh after References updates, fit/drag/menu
  boundaries, Collection node/detail split layout at narrow and wide window sizes, and
  window-close cleanup.
- Verify WebDAV credentials survive closing and reopening settings through Login Manager,
  unchecking remember removes only UniZero's credential, automatic sync observes the
  selected interval after restart, offline startup is quiet, and each background
  notification mode behaves as labelled.
- Verify a Board survives interruption: typing in a Text Node keeps its caret while a
  background status refresh lands, and a card dragged while one lands still follows the
  pointer and saves the position it visibly ends at.

## Contracts and artifacts

- Cover config, job-list, module-description, template-write, and shutdown payloads in
  the shared HTTP schema.
- Validate field values as well as field names and requiredness.
- Define a versioned artifact envelope for Markdown and tables.
- Provide clear add-on/runtime upgrade guidance when capabilities are incompatible.

## Add-on maintainability

- Add host-independent tests for the feature registry, contract client, library scope,
  artifact identity, and metadata comparison. The derived index and graph builders are
  already covered.
- Extract view state, network orchestration, and Zotero mutations from
  `src/modules/views.ts` as those areas change.
- Move the template-editor dialog logic in `addon/chrome/content/panel.js` under the
  TypeScript build.

## Literature data and sync

- Finish unified Paper lifecycle beyond the current stable IDs, monotonic retention,
  terminal-snapshot compaction, orphan cache collection, identifier inspection, and
  explicit merge/redirect operations: add a user-facing conflict-review workflow,
  lifecycle diagnostics, and sync migration coverage for Papers, observations, and
  redirects.
- Extend the landed typed namespaces, backend-neutral engine, conditional WebDAV
  backend, immutable pack transport, secure local credential storage, and
  manual/scheduled Project/Board sync. Add same-subject Project identity
  migration/redirect and conflict review. Then add Literature Paper/observation/redirect
  packs, followed by References, Citations, and explicitly portable settings. Keep device
  paths and secrets local. The constraints and conflict rules are in
  [SYNC_AND_LITERATURE_SOURCES.md](SYNC_AND_LITERATURE_SOURCES.md).
- Introduce a capability-based literature-source boundary before adding more out-of-library
  exploration. Evaluate an optional local corpus behind the versioned runtime API only
  after real queries show that online providers and the portable cache are insufficient.

## Graph

- Grouping and faceting on the board — colouring or clustering by tag, collection, or
  another facet, beyond the year option that exists now. Raised but not designed: what
  the groups should be is the open question, not how to draw them.
- Out-of-library discovery nodes, the Connected Papers style "papers you do not have",
  reusing the References/Citations caches.
- Replace the 2D canvas renderer only if a real library stops being smooth; the data layer
  is already decoupled for that, and the parameter and architecture notes are in
  `UNICONNECTION_GRAPH.md`.

## Unizero Home

- Replace or remove the experimental TextBlock/PaperBlock interaction before extending
  Board content. Prefer an Obsidian Canvas-like composition of independent cards and
  containers; do not add block kinds, rich editing, deeper nesting, or sync-specific
  merge work to the current Text Node model.
- Add notes, colours, multi-selection tools, edge labels/direction, camera persistence
  if user testing justifies it, and per-object sync metadata. A shared
  pan/zoom transform, Pointer interaction state machine, handle-drag connection preview,
  manual edge CRUD/rendering, single selection, deletion, and node resizing are now
  available.
- Replace the hard-coded node menu with capability-based actions, then add named raw
  Markdown and detailed/canvas Obsidian bindings.

## Product work

- Integrate an explicit, provider-backed publication ranking before exposing Unizero
  Home's Publication Level filter; do not infer rank from venue names.
- Let metadata review resolve conflicts field by field, rather than accepting or
  rejecting a candidate paper whole.
- Carry provider provenance and retrieval time for volatile scholarly data — the
  citation count on an item is currently a bare number with no "as of".
- Add annotation profiles with type, color, tags, comments, and managed output modes.
- Allow frontmatter properties to draw on a versioned Zotero snapshot rather than
  the item's state at conversion time.

Prioritize verified behavior and clear boundaries over directory reshuffling.
