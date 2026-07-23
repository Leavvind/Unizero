# Compatibility Readers

The merge that produced UniZero is finished, but seven pieces of code still exist only to
read state written by Zoference, zotero-reference, or ZoMiner. **They are live code with
live consequences, not migration leftovers.** Deleting one because "the migration is done"
would be a category error: the migration is a property of this repository, whereas these
readers are a property of a *user's profile and library*, and nothing in the repository
can tell you whether a given profile has been through them yet.

Each entry below states what it reads, what breaks if it is removed too early, and the
condition under which it may go.

## Preferences

### `src/modules/migrate.ts` — Zoference and zotero-reference preferences

Copies `extensions.zotero.{zoference,zoteroreference}.*` into
`extensions.zotero.unizero.*` on first run, newest ref first. Only keys with a user value
are copied, and an existing user value is never overwritten. Guarded by
`unizero.legacyPrefsMigrated`.

*If removed early:* a user upgrading from either predecessor silently loses their
Semantic Scholar key, tip colors, and auto-refresh list — reset to defaults with no
message, while the old keys sit unread in `prefs.js`.

*Retire when:* every profile that will ever run UniZero has started it at least once with
this code present. For a single-user project that is knowable; state it explicitly in the
commit that removes this.

### `src/runtime-client/settings.ts` — `migrateLegacyRuntimePrefs()`

Copies ZoMiner's `extensions.zominer.*` keys, which lived on the global Prefs branch
rather than under `extensions.zotero.*`. Guarded by `unizero.legacyRuntimePrefsMigrated`.
It enumerates key names explicitly so abandoned ZoMiner experiments are not inherited.

It is separate from `migrate.ts` because the two read different Prefs branches; merging
them would tangle the branch handling for no gain.

*Retire when:* same condition as above, independently — a user may have had one
predecessor and not the other.

## Caches

### `src/modules/localStorage.ts` — `adoptLegacyCache()`

Falls back to `zoference.json` / `zoteroreference.json` when `unizero.json` is absent.

*If removed early:* nothing is lost permanently, but the user re-parses their whole
library over the network. This is the mildest entry here.

*Retire when:* the cache format changes for an unrelated reason. There is no point paying
a migration to delete a fallback that costs one failed file read per startup.

## Artifacts

### `src/zotero/conversionAdapter.ts` — `legacyArtifacts()`

Recognizes attachments titled `ZoMiner MD`, `Academic MD`, `ZoMiner Tables`, and
`ZoMiner References` that carry no `unizero:` tag, so the next conversion adopts them
instead of duplicating them.

This is the only place where a display title is allowed to establish identity, and it is
fenced accordingly: adoption requires the parent item to have carried `MD/generated`
*before* the current run. An item never converted before cannot own a legacy artifact,
whatever its attachments happen to be called.

*If removed early:* every pre-migration item grows a second copy of every artifact on its
next conversion. Nothing is destroyed, but the library gets messy in a way that is
tedious to undo.

*Retire when:* every item that was converted by ZoMiner has been re-converted at least
once under UniZero — or when you accept the duplicates for the ones that have not.
**Not verified yet:** this path has never been exercised against a real ZoMiner-converted
item. See [ROADMAP.md](ROADMAP.md).

### `src/modules/zomReferences.ts` — the `zominer.references/1` reader

Reads the structured references JSON attachment that conversion produces, and feeds the
relations feature. It is not only a legacy reader: the current runtime still writes this
exact schema, so today this is the *only* path by which extracted references reach the
add-on.

*Retire when:* conversion jobs return references directly in their response, and every
attachment written under the old schema has been re-read or converted. Both halves are
required — this reader outlives the schema's use as a write format.

### Artifact display titles

Generated attachments are still titled `ZoMiner MD`, `ZoMiner Tables`, and
`ZoMiner References` in a product called UniZero. Since ownership moved to the
`unizero:<kind>` tag, these titles no longer establish identity for anything the add-on
created, so they can be renamed freely — the old strings must simply stay in the adoption
list above. `Academic MD` already demonstrates the pattern: a retired title kept purely as
an adoption criterion.

## Launch

### `src/runtime-client/launch.ts` — `legacy-script` mode

If `runtime.serverScript` is set, it is used: `<python> <script> --port N`. This beats
discovery deliberately, so a migrated ZoMiner user keeps running the server they
configured rather than having it silently swapped for an installed package.

ZoMiner's `server.py` never parsed `argv`, so passing `--port` to it is inert rather than
an error, which is why the flag can be passed unconditionally in all three modes.

*Retire when:* nobody is pointing the add-on at a `paper_service` checkout. Clearing the
setting is the user's move-over action, so the mode becomes dead the moment it is unset —
but leaving the mode in place costs one branch.

## Runtime state

### `UNIZERO_RUNTIME_HOME` pointing at an old `paper_service/`

Not a reader — a documented one-line action. The layout inside a ZoMiner
`paper_service` directory is identical to a UniZero runtime home, so setting the
environment variable adopts the existing `config.json`, `work/`, `store/`, and
`user_templates/` unchanged. `services/paper-runtime/tests/test_paths.py` covers this.

*Retire when:* never, as far as this repository is concerned. It is a supported way to
choose a home, not a compatibility shim.

## Rule

Do not remove any entry above as cleanup, as part of an unrelated change, or because it
looks like dead migration code. Removing one is its own commit, stating which condition
was met and how that was determined.
