# Roadmap

Forward work on UniZero, grouped by area rather than by phase. The phased structure this
replaced described a migration that is now finished; see [HISTORY.md](HISTORY.md).

Nothing here is implemented unless it says so. Current behavior is described in the
component READMEs and in [AGENTS.md](../AGENTS.md).

## Open verification

These are unfinished checks on work that has already landed, not new features. They stay
at the top because each one is a claim the repository currently cannot support.

- **Artifact equivalence.** Nothing produced by `services/paper-runtime` has been diffed
  against what ZoMiner produced for the same PDF. Conversion has been run and does
  produce artifacts; that is a weaker statement. This is a comparison against old output,
  so it cannot be automated away — a mocked pipeline test would assert that the mocks
  agree with each other.
- **Adoption of pre-migration artifacts.** Needs an item converted by ZoMiner before the
  merge. Entirely Zotero-side state; neither the type checker nor the runtime tests can
  reach it. See [COMPATIBILITY.md](COMPATIBILITY.md).
- **Artifact identity, in Zotero.** Four cases: a fresh conversion tags its artifacts; a
  re-conversion produces no duplicates; a *renamed* generated attachment still produces
  no duplicate; and an attachment the user created on a never-converted item, titled
  `ZoMiner MD`, survives conversion. The last is the data-loss case.
- **`setNote` on attachments.** Whether Zotero accepts and preserves the artifact record.
  Failure is logged as `artifact note refused` and degrades to title matching rather than
  breaking conversion, so this is a question about which path is live, not about safety.
- **Launch resolution from inside Zotero.** All three modes were verified from the
  command line, each honouring `--port` and writing to the expected runtime home. Not
  from inside Zotero.

## Unified UI

Settings currently live in two places, split by which project they came from rather than
by anything a user would recognize:

| Surface | Contents | Storage |
| --- | --- | --- |
| *Settings → Reference* | Semantic Scholar key, refresh, tips, related, save policy, match opacity | Zotero prefs |
| *Tools → UniZero 面板 → 设置…* | Python path, server script, port, autostart, autostop, MD snapshot | Zotero prefs |
| *Tools → UniZero 面板* | service status, jobs, template editor, service directories | live runtime |

The pane is still labelled *Reference*, which is now inaccurate — it is the add-on's only
preference pane and contains none of the runtime settings.

The honest boundary is not "Zoference settings" versus "ZoMiner settings" but **local
persistent configuration** versus **live runtime state**. The first belongs in Zotero's
preference pane, where users look for settings and where `preference="…"` binding gives
instant-apply for free. The second cannot go there: service directories are fetched from
the runtime over HTTP and are unavailable when it is stopped, and a live job table is not
a preference.

Planned:

- rename the preference pane to *UniZero* and absorb the runtime and conversion settings
  into it;
- keep the panel for what needs a running runtime — status, jobs, templates, service
  directories — and drop its settings overlay;
- one name across the Tools entry, the pane, and the panel title.

## Contracts

`packages/contracts/` and `tests/contract/` are ownership directories holding only
boundary documentation. Until they hold something,
`src/runtime-client/contracts.ts` and `src/unizero_runtime/contracts.py` are hand-written
mirrors of one contract, and the rule in [AGENTS.md](../AGENTS.md) requiring both to
change together is the only thing holding them in agreement.

- versioned HTTP request, response, capability, and error schemas;
- artifact envelopes and artifact-kind schemas;
- synthetic example payloads and legacy fixtures;
- contract tests that fail on drift instead of leaving it to surface as a 4xx.

Do not add generated bindings without a reproducible generation command, and do not
create placeholder files here merely to make the tree look complete.

## Artifacts

- versioned nested item and attachment snapshot;
- a common artifact envelope shared by Markdown, tables, and references;
- conversion jobs return extracted references directly, so the relations feature stops
  depending on reading an attachment back;
- group-library correctness — `library_id` defaults to `1` when absent, inherited from
  ZoMiner, and cache and artifact keys must include `libraryID`;
- a clear compatibility message when a stale add-on meets a newer runtime or vice versa;
- rename the generated attachment titles off the `ZoMiner` prefix, keeping the old
  strings as adoption criteria.

## Metadata and frontmatter

Expand identifier completion into field-level metadata management:

- a normalized candidate model carrying provider provenance;
- identity resolution before field merging;
- review UI for missing and conflicting fields;
- transactional Zotero write-back;
- frontmatter projection over a fresh Zotero snapshot, with template authors controlling
  which fields enter it;
- Semantic Scholar enrichment removed from the default conversion template, while the
  provider stays available to metadata and relations.

Volatile citation data must be labelled with its source and retrieval time. Metadata
changes should be previewable and reversible through Zotero history where available.

## Annotations

Support is currently limited to highlights and underlines with plain text.

- normalized type, colour, tags, comment, and position data;
- profile-driven rendering, so highlight and underline can differ;
- inline, managed-section, and standalone output modes;
- stable markers for managed output, so living Markdown is not overwritten unexpectedly;
- a dry-run and unmatched-annotation report;
- profile behavior testable without Zotero.

Repeated runs must stay idempotent, and existing injected annotation keys must keep
working.

## Structure

- `src/modules/` is Zoference's original flat layout and `views.ts` is 2112 lines
  carrying view code, cache policy, network orchestration, and Zotero mutation together.
  It is extracted incrementally, when that code is being touched for another reason —
  a dedicated refactor of an untested file that large is not worth the risk.
- `addon/chrome/content/panel.js` is plain JavaScript outside the bundle and outside the
  type checker. The unified-UI work above is the natural moment to reconsider that.

## Licensing

Open: the license for original ZoMiner code. `services/paper-runtime` is original work
running as a separate process behind an HTTP contract, so it is not a derivative of the
AGPL add-on and could carry a different license. It currently ships under
AGPL-3.0-or-later with the rest of the repository, and has a single copyright holder, so
the choice can still be revisited. Record the decision in [NOTICE](../NOTICE).
