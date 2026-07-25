# Roadmap

This file contains unfinished work only. Current behavior is documented in the component
READMEs and `docs/ARCHITECTURE.md`.

## Verification

- Run the full add-on smoke check in Zotero: startup, shutdown, metadata review,
  References/Citations previews, Literature Explorer Collection/item context-menu
  entry, Collection status/quick actions, relation filtering and current-library
  import, conversion, artifact registration, and annotation injection.
- Verify two-window cleanup: closing one main window must not remove the other window's
  pane or menus.
- Verify personal and group-library conversion with same-title items and repeated runs.
- Verify generated attachment identity after rename and confirm similarly titled user
  attachments are untouched.
- Exercise preferences through close/reopen and confirm runtime port changes reach a
  manually started service.
- Verify the automatic service start and stop: silent startup, shutdown on quit, a
  failed start appearing as a notice in the panel's Jobs list, and its retry action.
- Run a real MinerU conversion and inspect Markdown, tables, references, links, and
  annotation output.
- Verify graph behaviour beyond a first look: dark theme, layout persistence across a
  restart, a library large enough to stress readability, and the graph status line after
  an induced callback failure.

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
- Promote the throwaway browser harness for `literature-graph.js` into the repository, so
  force parameters and render-loop survival can be measured without packaging an XPI.
- Extract view state, network orchestration, and Zotero mutations from
  `src/modules/views.ts` as those areas change.
- Move the template-editor dialog logic in `addon/chrome/content/panel.js` under the
  TypeScript build.
- Add automated component checks to the release workflow.

## Graph

- Decide the fate of `uniConnection.egoGraph`: it is tested and unused, reserved for a
  possible one-hop-only toggle. Ship the toggle or delete the builder.
- Grouping and faceting on the board — colouring or clustering by tag, collection, or
  another facet, beyond the year option that exists now. Raised but not designed: what
  the groups should be is the open question, not how to draw them.
- Out-of-library discovery nodes, the Connected Papers style "papers you do not have",
  reusing the References/Citations caches.
- Replace the 2D canvas renderer only if a real library stops being smooth; the data layer
  is already decoupled for that, and the parameter and architecture notes are in
  `UNICONNECTION_GRAPH.md`.

## Product work

- Integrate an explicit, provider-backed publication ranking before exposing the
  Literature Explorer's Publication Level filter; do not infer rank from venue names.
- Let metadata review resolve conflicts field by field, rather than accepting or
  rejecting a candidate paper whole.
- Carry provider provenance and retrieval time for volatile scholarly data — the
  citation count on an item is currently a bare number with no "as of".
- Add annotation profiles with type, color, tags, comments, and managed output modes.
- Allow frontmatter properties to draw on a versioned Zotero snapshot rather than
  the item's state at conversion time.

Prioritize verified behavior and clear boundaries over directory reshuffling.
