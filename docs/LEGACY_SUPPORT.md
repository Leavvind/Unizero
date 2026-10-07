# Legacy Data Support

UniZero contains a small number of readers for state created by earlier installations.
They are compatibility boundaries, not the organizing model for new code.

| Reader | Supported state | Removal condition |
| --- | --- | --- |
| `apps/zotero-addon/src/modules/migrate.ts` | Older add-on preference prefixes | All relevant profiles have completed the guarded migration |
| `apps/zotero-addon/src/runtime-client/settings.ts` | `extensions.zominer.*` runtime preferences | All relevant profiles have completed its independent migration |
| `apps/zotero-addon/src/modules/localStorage.ts` | Single-document caches, under the current and older filenames | The one-shot import has run everywhere; it renames its source, so a second run is already a no-op |
| `apps/zotero-addon/src/zotero/conversionAdapter.ts` | Untagged generated attachments with known historical titles | Existing libraries have adopted or intentionally abandoned those artifacts |
| `apps/zotero-addon/src/modules/zomReferences.ts` | Legacy `zominer.references/1` reference envelopes alongside current `unizero.references/2` attachments | Retire only the legacy envelope compatibility after existing libraries have been migrated; the current structured-reference reader remains |
| `apps/zotero-addon/src/runtime-client/launch.ts` | Explicit legacy `server.py` launch setting | Support for that user-configured launch mode is intentionally ended |
| `apps/zotero-addon/src/zotero/markdownLinkRegistry.ts` | Generated Obsidian URLs whose uid is `unizero-<libraryID>-<itemKey>` | The URL is rewritten to the item key after that paper is successfully reconverted |
| `apps/zotero-addon/src/projects/paperCatalog.ts` | Schema 1 observation indexes, rebuilt once from their observation documents and persisted as schema 2 | Existing catalogs have been read at least once by a build that writes schema 2 |
| `UNIZERO_RUNTIME_HOME` | An existing compatible runtime-state directory | Supported indefinitely as an explicit runtime-home choice |

Rules:

- Do not remove one of these paths as incidental cleanup.
- Keep compatibility branches isolated from normal identity and write paths.
- Display titles may identify an untagged historical artifact only inside the guarded
  adoption code. New artifacts use `unizero:<kind>` tags.
- A retirement change must state which condition was met and how it was verified.

Not every version marker belongs here. `GRAPH_LAYOUT_VERSION` in
`apps/zotero-addon/src/modules/views.ts` guards cached graph coordinates, which are
derived and cheap to recompute: a version mismatch is discarded, deliberately, and must
not grow a migration path.

Legal provenance is recorded separately in `NOTICE`.
