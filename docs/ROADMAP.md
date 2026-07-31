# Roadmap

This file contains unfinished work only. Current behavior is documented in the component
READMEs and `docs/ARCHITECTURE.md`.

## Verification

Neither type checking nor Vitest exercises Zotero itself. These manual checks remain owed.

- **Smoke.** Startup, shutdown, metadata review, References/Citations previews, every
  Unizero Home entry point, Collection status and quick actions, relation filtering,
  current-library import, conversion, artifact registration, annotation injection.
- **Windows and preferences.** Closing one main window leaves the other's pane and menus
  intact. Preferences survive close/reopen, and a runtime port change reaches a manually
  started service. Service auto start/stop is silent, and a failed start appears in the
  panel's Jobs list with a working retry.
- **Conversion.** Personal and group libraries, same-title items, repeated runs. Generated
  attachment identity survives a rename without touching similarly titled user
  attachments. A real MinerU run: Markdown, tables, links, annotations, and the versioned
  `ZoMiner References` artifact — including an empty bibliography and a re-conversion that
  replaces a stale one.
- **Literature data.** A References query with OpenAlex and Crossref empty and Semantic
  Scholar restricted keeps all three source states across a reopen. Preview A → B → A
  reuses A silently, a real miss shows progress, and a zero-Citations result survives a
  restart without turning an all-provider failure into a cache hit.
- **Board.** Typing in a Text Node keeps its caret when a background refresh lands, and a
  card dragged at that moment still follows the pointer and saves where it visibly stops.
  Line-mode wheel deltas pan and zoom; an overflowing Text Node scrolls its own body; a
  card cannot be resized past the size actually saved. Relation hints on a Board mixing
  Zotero-bound and pinned Papers, with one Paper placed twice.
- **Sync.** Credentials survive close/reopen through Login Manager; unchecking remember
  removes only UniZero's credential; automatic sync keeps its interval across a restart;
  offline startup is quiet; each notification mode behaves as labelled. A first sync
  spanning several runs continues promptly and claims success only when nothing remains.
- **Graph tab.** Dark theme, layout persistence across a restart, a library large enough
  to stress readability, the status line after an induced callback failure, rapid tab
  switching and closing, personal/group context changes, topology refresh after References
  updates, fit/drag/menu boundaries, window-close cleanup.

## Contracts and artifacts

- Cover config, job-list, module-description, template-write, and shutdown payloads in
  the shared HTTP schema.
- Validate field values as well as field names and requiredness.
- Define a versioned artifact envelope for Markdown and tables.
- Provide clear add-on/runtime upgrade guidance when capabilities are incompatible.

## Add-on maintainability

- Add host-independent tests for the feature registry, contract client, library scope,
  artifact identity, and metadata comparison.
- Extract view state, network orchestration, and Zotero mutations from
  `src/modules/views.ts` as those areas change.
- Move the template-editor dialog logic in `addon/chrome/content/panel.js` under the
  TypeScript build.

## Literature data and sync

- Reclaim remote sync packs. Packs are immutable and never deleted, so remote storage
  grows without bound and a new device downloads every pack ever written. Deleting one
  safely needs more than a cleanup pass: devices must publish what they have applied,
  superseded content must be identifiable without downloading each pack, and a device
  that has been offline for a long time must not either block reclamation forever or
  have its unread data removed. Design this before implementing it — the operation
  deletes remote data irreversibly.
- Give the Paper lifecycle a user-facing conflict-review workflow and lifecycle
  diagnostics. Identity merges and redirects currently have no UI: the data layer reports
  an ambiguous alias set instead of guessing, and nothing yet lets the user resolve it.
- Extend sync past Project and Board. Next is same-subject Project identity
  migration/redirect and conflict review, then Literature Paper/observation/redirect
  packs, then References, Citations, and explicitly portable settings. Device paths and
  secrets stay local. Constraints and conflict rules are in
  [SYNC_AND_LITERATURE_SOURCES.md](SYNC_AND_LITERATURE_SOURCES.md).
- Introduce a capability-based literature-source boundary before adding more out-of-library
  exploration. Evaluate an optional local corpus behind the versioned runtime API only
  after real queries show that online providers and the portable cache are insufficient.

## Graph

The full-library Collection graph and the management table were replaced by the Board as
Home's leading surface. Their code is still built and still reachable in the dialog, but
hidden. Decide between the two honest endings rather than leaving it in this state:
delete them and keep only the per-paper Graph tab, or give the full-library graph a
purpose the Board does not already serve. Until then, nothing below should be built.

- Grouping and faceting — colouring or clustering by tag, collection, or another facet,
  beyond the year option that exists now. What the groups should be is the open question,
  not how to draw them.
- Out-of-library discovery nodes, the Connected Papers style "papers you do not have",
  reusing the References/Citations caches.
- Replace the 2D canvas renderer only if a real library stops being smooth; the data layer
  is already decoupled for that, and the parameter and incident notes are in
  [UNICONNECTION.md](UNICONNECTION.md).

## Unizero Home

- Replace or remove the experimental TextBlock/PaperBlock interaction before extending
  Board content. Prefer an Obsidian Canvas-like composition of independent cards and
  containers; do not add block kinds, rich editing, deeper nesting, or sync-specific
  merge work to the current Text Node model.
- Add notes, colours, multi-selection, edge labels and direction, per-object sync
  metadata, and camera persistence if user testing justifies it.
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
