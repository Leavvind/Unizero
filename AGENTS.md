# AGENTS.md

Instructions for coding agents and contributors working in this repository.

This file describes what is true now. Plans belong in `docs/MIGRATION.md` and must not
be treated as implemented behavior.

## Current phase

Both source projects have been migrated (**Phases 1–3**) and manually checked in Zotero
by the maintainer on 2026-07-23. `apps/zotero-addon` carries all Zotero-facing code;
`services/paper-runtime` is an installable Python package serving the unchanged
`/api/v1` contract.

**Phase 4 is in progress.** Explicit artifact identity has landed
(`src/zotero/artifactIdentity.ts`); the versioned cross-runtime contract has not.
`packages/contracts` and `tests/contract` are still empty ownership directories.

What the manual check did *not* establish: that artifacts produced by this runtime match
what ZoMiner produced for the same PDF. That gate is a comparison against old output and
is still open — see `docs/MIGRATION.md`. Adoption of pre-migration artifacts is likewise
unverified, since it needs an item converted before the migration.

Two source layouts coexist inside `src/` on purpose: Zoference's original flat
`src/modules/`, and the target layout from `docs/PROJECT_STRUCTURE.md`
(`runtime-client/`, `features/`, `zotero/`, `ui/`) used by Phase 2 code. New code goes in
the target layout. Moving the Zoference modules is the business of their own phases, not
an opportunistic cleanup.

Do not add placeholder build scripts, fake packages, or speculative abstractions merely
to make the target tree look complete.

## Source repositories

The migration sources are sibling repositories:

- `../Zoference`
- `../ZoMiner`

Treat them as read-only migration sources unless a task explicitly asks for changes in
those repositories. Preserve their behavior, history, license notices, and useful
rationale comments.

Never migrate generated or machine-local content, including:

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
3. **A versioned boundary.** Communication crosses a localhost HTTP contract defined
   under `packages/contracts`.
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

## Migration rules

- Migrate in bounded, reviewable commits by capability, not by copying whole
  repositories at once.
- Establish behavior parity before redesigning a migrated capability.
- Keep legacy preference, cache, artifact-title, and schema readers until the relevant
  migration is verified.
- `src/runtime-client/contracts.ts` and
  `services/paper-runtime/src/unizero_runtime/contracts.py` are hand-written mirrors of
  one contract. Change one, change the other in the same commit. Both sides type-check
  green while disagreeing, so drift only surfaces as a 4xx at the moment a user acts.
  Until `packages/contracts` exists, this rule is the only thing holding them together.
- The `zominer.references/1` artifact must remain readable during the transition.
- Do not rename public IDs, add-on IDs, preferences, artifacts, or release files without
  a documented migration.
- Complete licensing and attribution work before copying source code.
- Update `docs/MIGRATION.md` when a phase changes status.

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

The integrated manual smoke check will cover:

1. add-on startup and shutdown without leaked registrations;
2. metadata candidate review and safe Zotero write-back;
3. References and Citations loading for an item with identifiers;
4. PDF conversion through the local runtime;
5. Markdown, tables, and references artifact registration;
6. annotation export or injection without duplicate output.

If a manual check cannot be run, state that explicitly.

## Working tree safety

Existing changes belong to the user. Do not discard or rewrite unrelated work. Avoid
destructive Git commands. Keep migration-source repositories untouched unless the task
explicitly includes them.

