# Roadmap

This file contains unfinished work only. Current behavior is documented in the component
READMEs and `docs/ARCHITECTURE.md`. Nothing here is a work order by itself.

## Active focus

**Obsidian plugin** (`apps/obsidian-plugin`) against the add-on's read-only bridge.
Zotero-side **data** work (providers, cache, relations, conversion, bridge contract)
stays in scope when Obsidian needs it.

**Unizero Home / Board** is **legacy** on this branch: do not schedule new Home UI work
here unless product direction changes. Related items below stay under *Background* so
constraints are not lost.

## Obsidian plugin

The first slice — `@libraryID/itemKey` pills (Author/year display), `.md` / `.pdf`
jumps, free-text `@` completion, and a read-only detail pane — is implemented. Open work:

- Manual verification in Obsidian against a running Zotero: rendering in both editor
  modes (including left-click on pills), the multi-word suggester, and every jump target.
- Dragging a Zotero item or a Detail-pane row into a note or canvas. Dropping plain
  `@libraryID/itemKey` text already produces a working citation; a native-looking drag
  needs `app.dragManager`, which is unofficial and should be weighed against what it buys.
- **Write-back design (not implemented):** exploring from Obsidian and creating or
  updating material in UniZero / Zotero. Needs its own contract; do not extend the
  read-only bridge ad hoc.
- Richer literature exploration in the note surface (discovery, ranking, multi-hop
  jumps) — product headroom; each slice needs a clear scope.

## Verification

Neither type checking nor Vitest exercises Zotero or Obsidian hosts. Manual checks:

### Blocking for Obsidian work

- Bridge ping and paper resolve with the installed XPI; free-text multi-word `@`
  completion; pill left-click / right-click actions; detail pane relations without
  unbidden provider fetches.

### Add-on / runtime (still owed; not every iteration)

- **Smoke.** Startup, shutdown, metadata review, References/Citations previews, Collection
  status and quick actions, relation filtering, current-library import, conversion,
  artifact registration, annotation injection. Home entry points exist but are legacy.
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
- **Board / Home (legacy).** Only if touching that surface: Text Node caret under
  background refresh, drag save, pan/zoom, relation hints with pinned Papers.
- **Sync.** Credentials survive close/reopen through Login Manager; unchecking remember
  removes only UniZero's credential; automatic sync keeps its interval across a restart;
  offline startup is quiet; each notification mode behaves as labelled. A first sync
  spanning several runs continues promptly and claims success only when nothing remains.
- **Sync across two real devices.** Personal and group libraries, with the two machines
  holding different local `libraryID`s for the same portable scope. Device settings and
  secrets are never overwritten from the remote. WebDAV authentication failure, TLS
  failure, and insufficient quota each surface a visible, distinguishable error. Once
  Literature namespaces land: device A fetches References, device B restores them and
  rebuilds Relation/Graph without calling a provider, and editing an item's DOI causes
  the old cached record to be rejected rather than loosely matched.
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

The full-library Collection graph and the management table were deleted; the Board
replaced them and the per-paper Graph tab is the only remaining force-graph surface. Do
not reintroduce a whole-library graph without a purpose the Board does not already serve.

- Grouping and faceting — colouring or clustering by tag, collection, or another facet,
  beyond the year option that exists now. What the groups should be is the open question,
  not how to draw them.
- Out-of-library discovery nodes, the Connected Papers style "papers you do not have",
  reusing the References/Citations caches.
- Replace the 2D canvas renderer only if a real library stops being smooth; the data layer
  is already decoupled for that, and the parameter and incident notes are in
  [UNICONNECTION.md](UNICONNECTION.md).

## Background — legacy Unizero Home / Board

Home is not the active product surface. Keep these only so old constraints are not
forgotten if someone must touch the code:

- Replace or remove the experimental TextBlock/PaperBlock interaction before extending
  Board content. Prefer an Obsidian Canvas-like composition of independent cards and
  containers; do not add block kinds, rich editing, deeper nesting, or sync-specific
  merge work to the current Text Node model.
- Add notes, colours, multi-selection, edge labels and direction, per-object sync
  metadata, and camera persistence only if Home is revived.
- Replace the hard-coded node menu with capability-based actions, then add named raw
  Markdown and detailed/canvas Obsidian bindings — **prefer doing equivalent work in
  the Obsidian plugin** rather than reviving Board menus.

## Background — other product / data work

- Integrate an explicit, provider-backed publication ranking before any UI exposes a
  Publication Level filter; do not infer rank from venue names.
- Let metadata review resolve conflicts field by field, rather than accepting or
  rejecting a candidate paper whole.
- Carry provider provenance and retrieval time for volatile scholarly data — the
  citation count on an item is currently a bare number with no "as of".
- Add annotation profiles with type, color, tags, comments, and managed output modes.
- Allow frontmatter properties to draw on a versioned Zotero snapshot rather than
  the item's state at conversion time.

Prioritize verified behavior and clear boundaries over directory reshuffling. Do not
implement Background items unless the task asks for them.
