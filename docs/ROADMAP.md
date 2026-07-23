# Roadmap

This file contains unfinished work only. Current behavior is documented in the component
READMEs and `docs/ARCHITECTURE.md`.

## Verification

- Run the full add-on smoke check in Zotero: startup, shutdown, metadata review,
  References, Citations, conversion, artifact registration, and annotation injection.
- Verify two-window cleanup: closing one main window must not remove the other window's
  pane or menus.
- Verify personal and group-library conversion with same-title items and repeated runs.
- Verify generated attachment identity after rename and confirm similarly titled user
  attachments are untouched.
- Exercise preferences through close/reopen and confirm runtime port changes reach a
  manually started service.
- Run a real MinerU conversion and inspect Markdown, tables, references, links, and
  annotation output.

## Contracts and artifacts

- Cover config, job-list, module-description, template-write, and shutdown payloads in
  the shared HTTP schema.
- Validate field values as well as field names and requiredness.
- Define a versioned artifact envelope for Markdown, tables, and extracted references.
- Return extracted references in conversion results instead of making another feature
  read a generated attachment.
- Provide clear add-on/runtime upgrade guidance when capabilities are incompatible.

## Add-on maintainability

- Add host-independent tests for the feature registry, contract client, library scope,
  artifact identity, and metadata comparison.
- Extract view state, network orchestration, and Zotero mutations from
  `src/modules/views.ts` as those areas change.
- Move the template-editor dialog logic in `addon/chrome/content/panel.js` under the
  TypeScript build.
- Add automated component checks to the release workflow.

## Product work

- Expand metadata review from identifier completion to field-level candidate comparison.
- Carry provider provenance and retrieval time for volatile scholarly data.
- Add annotation profiles with type, color, tags, comments, and managed output modes.
- Allow frontmatter templates to select fields from a versioned Zotero snapshot.

Prioritize verified behavior and clear boundaries over directory reshuffling.
