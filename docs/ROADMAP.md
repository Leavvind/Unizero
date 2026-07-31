# Roadmap

This file contains unfinished work only. Current behavior is documented in the component
READMEs and `docs/ARCHITECTURE.md`. Nothing here is a work order by itself.

## Active focus

**Obsidian plugin** (`apps/obsidian-plugin`) against the add-on’s bridge (GET + convert).
Zotero-side **data** work (providers, cache, relations, conversion, bridge contract)
stays in scope when Obsidian needs it.

**Unizero Home / Board** is **legacy**: do not schedule new Home UI work here unless
product direction changes. Maintenance notes live in [LEGACY_HOME.md](LEGACY_HOME.md).

## Obsidian plugin

The first slice — `@libraryID/itemKey` pills (Author/year display), `.md` / `.pdf`
jumps, free-text `@` completion, library/paper panes, DataTransfer drag of
`@libraryID/itemKey` into notes, and a detail pane — is implemented. Open work:

- Manual verification in Obsidian against a running Zotero: rendering in both editor
  modes (including left-click on pills), the multi-word suggester, and every jump target.
- **Canvas / native drag look.** Dropping plain `@libraryID/itemKey` text already
  produces a working citation. A native-looking drag (Obsidian Canvas, unofficial
  `app.dragManager`) should be weighed against what it buys.
- **Write-back design (not implemented):** exploring from Obsidian and creating or
  updating material in UniZero / Zotero. Needs its own contract. The bridge already
  allows one narrow action (`POST /convert` → Zotero conversion job); do not treat
  that as a blank cheque for bibliographic mutations.
- Richer literature exploration in the note surface (discovery, ranking, multi-hop
  jumps) — product headroom; each slice needs a clear scope.

## Verification

Neither type checking nor Vitest exercises Zotero or Obsidian hosts. Manual checks:

### Blocking for Obsidian work

- Bridge ping and paper resolve with the installed XPI; free-text multi-word `@`
  completion; pill left-click / right-click actions; detail pane relations without
  unbidden provider fetches; Convert to Markdown from the plugin.

### Add-on / runtime (still owed; not every iteration)

- **Smoke.** Startup, shutdown, metadata review, References/Citations previews, Collection
  status and quick actions, relation filtering, current-library import, conversion,
  artifact registration, annotation injection.
- **Windows and preferences.** Closing one main window leaves the other’s pane and menus
  intact. Preferences survive close/reopen; a runtime port change reaches a manually
  started service. Service auto start/stop is silent; a failed start appears in the
  panel’s Jobs list with a working retry.
- **Conversion.** Personal and group libraries, same-title items, repeated runs. Generated
  attachment identity survives a rename without touching similarly titled user
  attachments. A real MinerU run: Markdown, tables, links, annotations, and the versioned
  `ZoMiner References` artifact — including an empty bibliography and a re-conversion that
  replaces a stale one.
- **Literature data.** A References query with OpenAlex and Crossref empty and Semantic
  Scholar restricted keeps all three source states across a reopen. Preview A → B → A
  reuses A silently, a real miss shows progress, and a zero-Citations result survives a
  restart without turning an all-provider failure into a cache hit.
- **Sync.** Credentials survive close/reopen through Login Manager; unchecking remember
  removes only UniZero’s credential; automatic sync keeps its interval across a restart;
  offline startup is quiet; each notification mode behaves as labelled. A first sync
  spanning several runs continues promptly and claims success only when nothing remains.
- **Sync across two real devices.** Personal and group libraries, with the two machines
  holding different local `libraryID`s for the same portable scope. Device settings and
  secrets are never overwritten from the remote. WebDAV authentication failure, TLS
  failure, and insufficient quota each surface a visible, distinguishable error. Once
  Literature namespaces land: device A fetches References, device B restores them and
  rebuilds Relation without calling a provider, and editing an item’s DOI causes the old
  cached record to be rejected rather than loosely matched.
- **Legacy surfaces (only if touching that code):** Board Text Node caret under background
  refresh; per-paper Graph tab dark theme, layout persistence, and `guard()` behaviour.

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
  grows without bound. Designing reclamation is a prerequisite — the operation deletes
  remote data irreversibly. Constraints: [SYNC_AND_LITERATURE_SOURCES.md](SYNC_AND_LITERATURE_SOURCES.md).
- Give the Paper lifecycle a user-facing conflict-review workflow and lifecycle
  diagnostics. Identity merges and redirects currently have no UI.
- Extend sync past Project and Board: same-subject Project identity migration/redirect
  and conflict review, then Literature Paper/observation/redirect packs, then References,
  Citations, and explicitly portable settings. Device paths and secrets stay local.
- Introduce a capability-based literature-source boundary before adding more out-of-library
  exploration. An optional local corpus behind the runtime API is only worth evaluating
  after real queries show online providers and the portable cache are insufficient.

## Background — product / data work

- Integrate an explicit, provider-backed publication ranking before any UI exposes a
  Publication Level filter; do not infer rank from venue names.
- Let metadata review resolve conflicts field by field, rather than accepting or
  rejecting a candidate paper whole.
- Carry provider provenance and retrieval time for volatile scholarly data — the
  citation count on an item is currently a bare number with no "as of".
- Add annotation profiles with type, color, tags, comments, and managed output modes.
- Allow frontmatter properties to draw on a versioned Zotero snapshot rather than
  the item’s state at conversion time.

## Legacy notes (not a build plan)

Home/Board product wishlist and full-library graph ideas are **not** active roadmap.
If that code must be touched, read [LEGACY_HOME.md](LEGACY_HOME.md) and the graph
traps in [UNICONNECTION.md](UNICONNECTION.md). Prefer equivalent work in the Obsidian
plugin.

Prioritize verified behavior and clear boundaries over directory reshuffling. Do not
implement Background or Legacy items unless the task asks for them.
