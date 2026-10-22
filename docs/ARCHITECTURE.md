# Architecture

## System

```mermaid
flowchart LR
    Obsidian["Obsidian plugin"]
    Bridge["Zotero HTTP bridge\nGET + artifact actions"]

    subgraph Addon["Zotero add-on · TypeScript"]
        Server["src/server"]
        Features["Feature orchestration"]
        Adapters["Zotero adapters"]
        Providers["Scholarly providers"]
        Cache["Per-item reference cache"]
        Index["UniConnection index"]
        Catalog["Paper catalog"]
        Client["Runtime client"]
        LegacyUI["Legacy Home / Board"]
    end

    Zotero["Zotero library"]

    subgraph Runtime["Paper runtime · Python"]
        API["HTTP /api/v1"]
        App["Jobs and use cases"]
        Pipeline["Document pipeline"]
        IO["MinerU and filesystem"]
    end

    Obsidian --> Bridge
    Bridge --> Server
    Server --> Features
    Server --> Cache
    Server --> Index
    Server --> Catalog
    Features --> Adapters
    Features --> Providers
    Features --> Client
    Providers --> Cache
    Cache --> Index
    Adapters --> Zotero
    Catalog --> Features
    Client --> API
    API --> App
    App --> Pipeline
    Pipeline --> IO
    LegacyUI -.-> Features
```

**Main path:** Obsidian plugin → localhost bridge on Zotero’s HTTP server → add-on data
plane (cache, relations, Paper catalog, conversion) → Zotero items / scholarly providers /
paper runtime.

**Legacy (dashed):** Unizero Home (Project View / Board) reaches the same data plane
through a window API bridge.

Metadata, literature relations, and the Paper catalog run in the add-on. PDF conversion,
artifact publishing, and Markdown annotation injection require the local runtime.

## Add-on layers

| Layer | Current paths | Role |
| --- | --- | --- |
| Lifecycle | `src/hooks.ts`, `src/core/` | Register and clean up features per window |
| Features | `src/features/` | Commands and user-facing orchestration |
| Bridge | `src/server/` | Mostly-read-only endpoints for Obsidian (GET + artifact actions: convert, Canvas, trash, restore Raw) |
| UI | `src/ui/`, `src/modules/views.ts` | Menus, panes, dialogs, progress |
| Dialog content | `addon/chrome/content/` | Privileged XHTML: panel, **legacy** Home, graph renderer |
| Zotero adapters | `src/zotero/` | Read and mutate Zotero items and attachments |
| Providers | `src/modules/*Api.ts`, `src/modules/resolve.ts` | Scholarly HTTP access and normalization |
| Cache | `src/modules/localStorage.ts`, `src/modules/literatureCache.ts` | Per-item shards under the add-on data directory |
| Derived index | `src/modules/uniConnection.ts`, `src/modules/uniConnectionSync.ts` | Reverse-reference index, coupling, graph topology |
| Projects / catalog | `src/projects/` | Portable Project identity, Paper catalog, local object persistence |
| Runtime boundary | `src/runtime-client/` | Contract types, HTTP, launch, process state |

`src/modules/` contains the established item-pane, metadata, provider, and cache
implementation. New code uses the more specific directories above. Existing modules are
split only when the work being done needs that boundary.

Feature IDs are statically registered in `src/core/features.ts`:

- `library.metadata`;
- `literature.relations`;
- `document.convert`;
- `annotations`.

Static registration keeps activation and cleanup auditable in Zotero’s multi-window
environment. The derived index (and legacy Home) belong to `literature.relations`.

## Bridge contract

The Obsidian plugin never holds a second bibliographic store. It calls endpoints on
Zotero’s existing loopback HTTP server (`BRIDGE_API_VERSION` in
`apps/zotero-addon/src/server/bridgePayloads.ts`).

Load-bearing properties:

- **Mostly read-only.** GET endpoints never mutate Zotero or the Paper catalog. The
  write-shaped exceptions all act on the user's own artifacts, and none erases anything:
  - `POST /convert` starts the same conversion job as the Zotero item menu, with the
    default template or the one an optional `template` names. A Raw whose file is gone
    is moved to the trash by the conversion and replaced.
  - `POST /canvas` returns the paper's Canvas attachment (`unizero:canvas`), first
    adding an empty `.canvas` when the paper has none; it accepts no file contents and
    never writes into an existing Canvas.
  - `POST /trash` (`kind=raw|canvas`) moves the paper's Raw or Canvas to Zotero's trash.
  - `POST /restore-raw` imports a copy of Raw Backup as the new Raw, then moves the old
    Raw to the trash.

  Each is announced by a ping capability (`canvas`, `trash`, `restore-raw`), and the
  payload fields they rely on (`links.canvas`, `links.canvasPath`, `links.rawBackup`,
  `links.rawBackupPath`, `hasCanvas`, `hasRawBackup`) are additions, so
  `BRIDGE_API_VERSION` stays 2. Bibliographic edits, Paper-catalog writes, and
  exploration import need a separate write-back design.
- **Templates are listed, never started for.** `GET /templates` asks the paper runtime
  only when it is already running; a stopped runtime is `available: false`. The
  addition is optional for clients, announced by the `templates` ping capability, so
  `BRIDGE_API_VERSION` stays 2.
- **No unrequested provider traffic.** Relations answer from cache. A miss is
  `loaded: false` so the caller can prompt; only explicit `fetch=1` may hit the network.
  Rendering a note must never start conversion or provider work.
- **Identity.** Persisted citations use `libraryID` + `itemKey`. A citekey is a derived
  alias and may collide; ambiguity is reported, never resolved silently.

This boundary is unrelated to the add-on ↔ runtime `/api/v1` contract. Do not merge them.

## Paper catalog

The catalog is stored under `<dataDir>/unizero/literature/`. A Zotero binding uses portable
library scope plus item key, so refreshing metadata never replaces a Paper ID. Dropping an
out-of-library result creates or reuses an identifier-aliased Paper without creating a
Zotero item; a later Zotero-bound observation with a matching identifier adds a binding
to that same Paper.

Loading a References or Citations snapshot materializes every result at `cache` retention,
and retention only ever climbs:

```text
cache → pinned → zotero
```

Reliable DOI, arXiv, Semantic Scholar, and OpenAlex aliases converge provider results.
An unidentified result gets a query-scoped provisional mapping keyed by bibliographic
fingerprint rather than by list position. Where an alias set resolves to more than one
Paper, identifier inspection reports the conflict rather than silently picking one;
an explicit merge chooses the canonical Paper and leaves a `paper-redirect`.

The same snapshot writes `LiteratureCitationObservation` documents: References records
`seed → result`, Citations records `result → seed`, with provider, query kind, retrieval
time, and source order on the observation. Only a successful terminal snapshot may replace
older observations for the same seed, query kind, and provider. After a replacement,
cache-only Papers with no remaining observation are collected; pinned and Zotero-bound
Papers never are.

## Derived relations index

`UniConnection` is a derived layer. It owns no truth: everything it holds is recomputed
from the per-item `References-Resolved-v4` caches and from item identifiers, so it can be
discarded and rebuilt at any time.

One reverse index answers every query it serves — the Relation tab, bibliographic
coupling, topology used by the per-paper Graph tab, Board relation hints, and (via the
bridge) Obsidian’s detail pane — so a change to how edges are stored affects all
consumers. Topology is memoized per library and invalidated by build, ingest, retract,
trash, and delete.

Rules this layer keeps:

- **Edges need a stable identity.** `edgeIdentity` yields `doi:` / `arxiv:` / `s2:` keys;
  a reference without one is skipped rather than keyed by title.
- **Topology carries no Zotero fields.** `GraphNode` holds `id`, `itemKey`, `degree`, and
  `isCenter` only. Display fields are added afterwards by `views.getLiteratureGraph`.
- **The index spans all edges, not just library members.** Library filtering happens at
  query time.
- **Bulk builds read shards directly**, bypassing the cache’s small resident set.
- **Maintenance is incremental.** `uniConnectionSync` registers a Zotero notifier.
- **Reference writes are ordered before topology reads.** A References refresh awaits the
  cache write and `ingestItem` before the bridge resolves.

Design detail: [UNICONNECTION.md](UNICONNECTION.md).

## Runtime layers

| Layer | Path | Role |
| --- | --- | --- |
| Transport | `api/` | Validate and map HTTP requests and responses |
| Application | `application/` | Configuration, job queue, conversion, annotations |
| Pipeline | `pipeline/` | Templates, step registry, transforms, publishing |
| Providers | `providers/` | Reference extraction, tables, remote enrichment |
| Composition | `composition.py` | Construct dependencies without import-time work |

The runtime keeps mutable state outside the installed package. `paths.py` resolves a
single runtime home containing configuration, work files, generated state, user
templates, and logs.

## Boundary

The add-on sends typed requests to `/api/v1`; the runtime returns typed responses and
capabilities. The shared field contract is
`packages/contracts/http/v1.schema.json`, mirrored by TypeScript and Pydantic models.

During conversion, the `transform.content` module reads MinerU’s untouched content list
before it removes the bibliography from the Markdown. The runtime returns ordered local extraction
records only; the add-on persists them in the owned, versioned `ZoMiner References` JSON
attachment. Provider matching and library resolution remain add-on responsibilities.

Dependency direction:

```text
Obsidian plugin → localhost bridge → add-on features / cache / catalog

add-on UI → feature orchestration → Zotero/provider/runtime ports

legacy dialog content → window API bridge → views → cache/derived index

runtime API → application services → pipeline/providers → filesystem/MinerU
```

Neither component reaches through an HTTP boundary to reuse the other’s implementation.

## Data ownership

| Data | Owner |
| --- | --- |
| Bibliographic fields and item relations | Zotero items |
| Stable library/external paper identity and Zotero bindings | UniZero Paper catalog |
| Project identity, Board objects and paper-node layout | Versioned Project documents |
| Highlight and underline annotations | Zotero attachment annotations |
| Provider responses | Refreshable add-on cache, one shard per item |
| Reverse-reference index, coupling, graph topology | Derived from the reference cache; rebuildable, never authoritative |
| Graph layout coordinates | Add-on data directory, per library; versioned and discardable |
| Graph display and force settings | Add-on data directory |
| Conversion templates and jobs | Paper runtime |
| Work files and processing records | Runtime home |
| Published Markdown | User-selected filesystem destination |
| Converted paper text inside Zotero | Raw: an imported Markdown attachment tagged `unizero:raw`, edited by the user and never overwritten; `unizero:raw-backup` holds the latest conversion |
| Extracted PDF bibliography | Versioned `ZoMiner References` Zotero JSON attachment |
| Note identity (`uid` frontmatter) | Published Markdown; the runtime supplies a stable default |
| Zotero item ↔ Obsidian URL binding | Add-on data directory, per library |
| Generated Zotero attachment identity | `unizero:<kind>` tags |

Add-on file paths are listed under *Stored state* in the
[add-on README](../apps/zotero-addon/README.md#stored-state).

Derived data never becomes a second authority for Zotero metadata. Layout coordinates sit
outside the shard tree on purpose: shards are keyed by item and swept when an item
disappears, which would delete a library-scoped file on every start.

The Markdown link registry contains no bibliographic fields or absolute paths. It joins
the canonical Zotero item identity to one user-editable `obsidian://` URL. Conversion
creates a missing binding from the configured vault and stable uid; an existing edited
URL survives re-conversion.

## Identity and safety

- Item-scoped keys include both `libraryID` and item key.
- Group-library requests carry an explicit Zotero library scope.
- Generated attachments are matched by `unizero:<kind>` tags, not titles.
- Existing user-authored attachments are not overwritten merely because their titles
  resemble generated artifacts.
- Registrations are released on window unload or add-on shutdown, including the derived
  index’s notifier observer.

## Legacy surfaces (Home / Board / Graph)

Opening Unizero Home for a Collection ensures one stable Project and one default Board,
keyed by portable library scope plus Collection key — not numeric `libraryID` /
`collectionID`. Project and Board are separate schema-versioned documents under
`<dataDir>/unizero/projects/`. Board nodes and manual edges are independent documents;
camera is transient window state.

Home is a privileged XHTML dialog (`literature-explorer.js` + `literature-graph.js`),
not part of the TypeScript bundle. It reaches the add-on only through
`window.arguments[0]`. Rules that still matter when touching that code:

- Every async result belongs to exactly one owner (tab / generation / request).
- Board render and interaction are separate — a refresh mid-gesture defers rebuild.
- Every force-graph callback passes through `guard()`.
- Saved layout coordinates need matching `GRAPH_LAYOUT_VERSION` and force signature.

Maintenance detail: [LEGACY_HOME.md](LEGACY_HOME.md). Graph force traps:
[UNICONNECTION.md](UNICONNECTION.md).

Unfinished architecture work is listed in [ROADMAP.md](ROADMAP.md), not in this current
state description.
