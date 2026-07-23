# AGENTS.md

Instructions for coding agents and contributors working in this repository.

This file describes what is true now. Plans belong in `docs/ROADMAP.md` and must not be
treated as implemented behavior.

## Current state

Unizero is a project, merging from [Zoference](https://github.com/Leavvind/zotero-reference) and [Zominer](https://github.com/Leavvind/ZoMiner).
- How it was assembled is recorded in `docs/HISTORY.md`.


`apps/zotero-addon` carries all Zotero-facing code. `services/paper-runtime` is an
installable Python package serving `/api/v1`. Both were manually checked in Zotero by the
maintainer on 2026-07-23. The later feature-registry, multi-window, port-sync, and
group-library changes still need the manual checks listed in `docs/ROADMAP.md`. Generated
attachments are identified by an explicit
`unizero:<kind>` tag (`src/zotero/artifactIdentity.ts`), not by their display title.

`packages/contracts/http/v1.schema.json` is the canonical HTTP v1 field/requiredness
declaration, with synthetic examples under `packages/contracts/examples`. Component-native
checks compare it with both `contracts` modules. Artifact schemas and legacy fixtures are
still planned; do not add placeholder build scripts, fake packages, or speculative
abstractions merely to make the target tree look complete.

Open verification and planned work are in `docs/ROADMAP.md`. What still reads state
written by the predecessor add-ons is in `docs/COMPATIBILITY.md`; that code is live and
is not cleanup material.

Two source layouts coexist inside `src/` on purpose: Zoference's original flat
`src/modules/`, and the layout from `docs/PROJECT_STRUCTURE.md` (`runtime-client/`,
`features/`, `zotero/`, `ui/`). New code goes in the second. The flat modules are
extracted incrementally, when that code is being touched for another reason — not as
opportunistic cleanup.

## Predecessor repositories

`../Zoference` and `../ZoMiner` are sibling checkouts, kept as behavioral references for
parity questions. Treat them as read-only unless a task explicitly asks for changes
there. Nothing in this repository depends on them.

Nothing generated or machine-local is ever copied out of them:

- `node_modules/`, `build/`, `.venv/`, and `*.xpi`;
- ZoMiner `paper_service/work/` and `paper_service/store/`;
- local `config.json`, `.env`, logs, and user template overrides;
- caches containing user-library data.

## Architecture invariants

1. **One Zotero add-on.** User-facing UniZero features ship through
   `apps/zotero-addon`.
2. **A separate local runtime.** Heavy PDF processing remains in
   `services/paper-runtime`; do not import Python implementation details into the
   add-on.
3. **A versioned boundary.** Communication crosses an explicit localhost HTTP contract.
   It is currently declared twice — `src/runtime-client/contracts.ts` and
   `src/unizero_runtime/contracts.py` — and `packages/contracts` is where a single
   language-neutral declaration will live.
4. **Zotero is canonical.** Bibliographic metadata and annotations originate from
   Zotero. Derived cache entries and Markdown frontmatter do not become competing
   sources of truth.
5. **Module layers stay distinct.** Feature modules, providers, and document pipeline
   steps use separate interfaces and registries.
6. **UI is an adapter.** Business rules, network orchestration, cache policy, and
   Zotero mutations must not accumulate in a monolithic view class.
7. **Artifact identity is explicit.** Ownership comes from the `unizero:<kind>` tag
   applied by `src/zotero/artifactIdentity.ts`; never erase or overwrite an attachment
   without it. Do not identify artifacts by attachment title — titles are display names,
   and are consulted only when adopting a pre-migration artifact.
8. **Lifecycle is symmetric.** Every menu, pane, listener, observer, and window hook
   registered by the add-on must be unregistered on unload or shutdown.

The accepted add-on/runtime boundary is documented in
`docs/decisions/0001-addon-and-runtime-boundary.md`.

## Target code ownership

| Path | Owns |
| --- | --- |
| `apps/zotero-addon` | Zotero APIs, UI, commands, feature modules, remote scholarly providers |
| `services/paper-runtime` | FastAPI transport, jobs, MinerU, transforms, publishing, runtime state |
| `packages/contracts` | HTTP schemas, artifact schemas, compatibility examples |
| `tests/contract` | Cross-language contract and legacy fixture verification |

Dependency direction:

```text
Zotero UI/adapters → application services → ports/providers
                                      └────→ versioned runtime client

runtime API → runtime application services → pipeline/providers → filesystem/MinerU
```

Neither side may reach through the contract to use the other side's implementation.

## Zotero runtime constraints

The add-on runs in Zotero's privileged Firefox environment, not Node or a normal web
page.

- Do not use Node built-ins such as `fs`, `path`, `zlib`, `events`, or `timers`.
- Use current Zotero APIs for file access and item-pane registration.
- Avoid new Zotero private-API dependencies.
- Keep group libraries in scope: cache and artifact keys must include `libraryID`.
- Any UI or Zotero API change requires a manual Zotero check in addition to type
  checking and building.

These constraints originate in Zoference and continue to apply after migration.

## Change rules

- HTTP v1 changes start in `packages/contracts/http/v1.schema.json`; update
  `src/runtime-client/contracts.ts` and
  `services/paper-runtime/src/unizero_runtime/contracts.py` in the same commit.
  `npm run check` and `tests/test_shared_contract.py` must both pass.
- Everything listed in `docs/COMPATIBILITY.md` reads state written by a predecessor
  add-on. Removing one is its own commit, stating which retirement condition was met and
  how that was determined. Never as cleanup, and never bundled into an unrelated change.
- Do not rename public IDs, add-on IDs, preferences, artifacts, or release files without
  a documented compatibility path. Display names may change freely; stable identifiers
  may not.
- Establish behavior parity before redesigning a capability that came from a predecessor.
- Update `docs/ROADMAP.md` when planned work lands or an open verification closes.

## Documentation conventions

- Repository documentation, public contracts, and new public API names are written in
  English.
- Preserve useful Chinese comments when migrating existing code. Do not create noisy
  translation-only diffs.
- Documentation must distinguish current behavior from target architecture.
- Link design changes to an ADR under `docs/decisions/` when they affect a durable
  boundary.

## Verification

There is no root build or test command. Each component is verified from its own
directory.

Add-on, from `apps/zotero-addon`:

```text
npm run check
npm run build
```

`npm run check` includes the TypeScript/schema contract drift check.

Runtime, from `services/paper-runtime`:

```text
.venv/Scripts/python.exe -m pytest
```

The add-on has no automated tests. A type check and a successful bundle do not verify
Zotero UI behavior — any UI, lifecycle, or Zotero API change also needs a manual check in
Zotero, and if you cannot run one, say so explicitly.

The runtime's tests cover paths, template validation, reference extraction, frontmatter,
annotation idempotency, and the `/api/v1` contract. They deliberately do not cover
conversion, which needs MinerU, a GPU, and a real PDF. Do not add mocked pipeline tests
to close that gap: they would assert that the mocks agree with each other.

Runtime tests must never touch the developer's real runtime home. `tests/conftest.py`
forces an isolated home per test; keep it that way.

For documentation-only changes:

- verify that all referenced repository paths exist;
- inspect Markdown links and headings;
- confirm that no generated or user-local files were added.

The integrated manual smoke check covers:

1. add-on startup and shutdown without leaked registrations;
2. metadata candidate review and safe Zotero write-back;
3. References and Citations loading for an item with identifiers;
4. PDF conversion through the local runtime;
5. Markdown, tables, and references artifact registration;
6. annotation export or injection without duplicate output.

If a manual check cannot be run, state that explicitly.

## Working tree safety

Existing changes belong to the user. Do not discard or rewrite unrelated work. Avoid
destructive Git commands. Keep the predecessor repositories untouched unless the task
explicitly includes them.
