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
- **The unified preference pane.** The runtime and conversion settings moved out of the
  panel into *Settings → UniZero*, wired imperatively through `getRuntimePref` /
  `setRuntimePref` rather than through XUL `preference=` binding. Each field needs one
  round trip — change it, reopen the pane, confirm it stuck — and the port additionally
  needs to reach a manually started runtime's `config.json`.
- **Lifecycle after registry extraction.** Normal Zotero exit must stop a runtime started
  by the add-on; closing one of two main windows must leave the other window's item pane
  and global metadata menu working; disabling the add-on must remove every registration.
- **Group-library end to end.** Automated tests cover scoped identities, deep links,
  contract payloads, and runtime routing. A real group item still needs conversion,
  re-conversion, and annotation injection in Zotero, including a same-title item in the
  user library to prove the two outputs do not cross.

## Contracts

`packages/contracts/http/v1.schema.json` now declares HTTP field names, requiredness,
the API version, and required capabilities. `npm run check` compares TypeScript wire
interfaces against it; the runtime suite compares Pydantic models and validates the
shared synthetic examples.

- extend the schema to config, job-list, module-description, and template-write payloads;
- artifact envelopes and artifact-kind schemas;
- legacy fixtures such as `zominer.references/1`;
- full value/type validation on the TypeScript side, beyond current field/requiredness
  comparison.

Do not add generated bindings without a reproducible generation command, and do not
create placeholder files here merely to make the tree look complete.

## Artifacts

- versioned nested item and attachment snapshot;
- a common artifact envelope shared by Markdown, tables, and references;
- conversion jobs return extracted references directly, so the relations feature stops
  depending on reading an attachment back;
- verify group-library conversion in Zotero. Current add-on payloads carry a validated
  Zotero URI scope, caches use `libraryID:itemKey`, and runtime store/artifact keys are
  scoped; older runtimes are rejected for group items instead of silently using the user
  library;
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

- `src/core/featureRegistry.ts` now statically registers the four product feature IDs and
  owns symmetric per-window and shutdown dispatch. Events and shared jobs remain planned.
- `src/modules/` is Zoference's original flat layout and `views.ts` is 2112 lines
  carrying view code, cache policy, network orchestration, and Zotero mutation together.
  It is extracted incrementally, when that code is being touched for another reason —
  a dedicated refactor of an untested file that large is not worth the risk.
- `addon/chrome/content/panel.js` is plain JavaScript outside the bundle and outside the
  type checker. Moving the preferences out shrank it; the template editor is what remains
  and is the part worth typing.

## Licensing

Open: the license for original ZoMiner code. `services/paper-runtime` is original work
running as a separate process behind an HTTP contract, so it is not a derivative of the
AGPL add-on and could carry a different license. It currently ships under
AGPL-3.0-or-later with the rest of the repository, and has a single copyright holder, so
the choice can still be revisited. Record the decision in [NOTICE](../NOTICE).
