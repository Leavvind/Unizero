/**
 * Purely derived, in-memory connections between papers in one Zotero library.
 *
 * The source of truth remains each item's References-Resolved-v4 cache shard.
 * UniConnection neither fetches nor writes relation data: it can be discarded and
 * rebuilt at any time from those forward edges.
 */

import { edgeIdentity } from "./edgeIdentity";
import { readItemPaperIdentifiers } from "./itemIdentifiers";
import {
  CACHE_KEY_REFERENCES,
  cacheMatchesItem,
  type ReferencesCache,
} from "./literatureCache";
import { localStorage } from "./localStorage";
import { libraryItemIdentity } from "../zotero/libraryScope";

export type EdgeKey = string;
export type ScopedItemKey = string;

export interface RelationHit {
  /** A library item whose References cache contains the queried paper. */
  scopedKey: ScopedItemKey;
  /** The citing item's own stable identity, when it has one. */
  edge?: EdgeKey;
}

export interface CouplingHit {
  scopedKey: ScopedItemKey;
  shared: number;
}

export interface UniConnectionStats {
  items: number;
  edges: number;
  skippedAnon: number;
  itemsWithRefs: number;
}

interface CacheReader {
  readRecordDirect(item: Zotero.Item, key: string): Promise<unknown>;
}

interface LibraryIndex {
  libraryID: number;
  /** All regular, non-deleted items seen by this index. */
  items: Set<ScopedItemKey>;
  /** Zotero's process-wide numeric item ID -> scoped identity, for delete events. */
  itemIDs: Map<number, ScopedItemKey>;
  /** Reverse of itemIDs, so routine modify/retract stays O(1). */
  scopedItemIDs: Map<ScopedItemKey, number>;
  /** Reference endpoint -> library items whose forward lists contain it. */
  inverted: Map<EdgeKey, Set<ScopedItemKey>>;
  /** Library item -> its distinct, identified reference endpoints. */
  forward: Map<ScopedItemKey, Set<EdgeKey>>;
  /** Library item -> its own stable endpoint. */
  selfEdge: Map<ScopedItemKey, EdgeKey>;
  /** Stable endpoint -> one owning library item (duplicates use a stable first owner). */
  edgeOwner: Map<EdgeKey, ScopedItemKey>;
  /** Items with a non-empty cache, including caches made solely of anonymous rows. */
  itemsWithRefs: Set<ScopedItemKey>;
  /** Anonymous cache rows per item, retained so retract/update fixes diagnostics. */
  anonymousByItem: Map<ScopedItemKey, number>;
}

const READ_BATCH_SIZE = 32;
const DEFAULT_COUPLING_LIMIT = 20;

function emptyIndex(libraryID: number): LibraryIndex {
  return {
    libraryID,
    items: new Set(),
    itemIDs: new Map(),
    scopedItemIDs: new Map(),
    inverted: new Map(),
    forward: new Map(),
    selfEdge: new Map(),
    edgeOwner: new Map(),
    itemsWithRefs: new Set(),
    anonymousByItem: new Map(),
  };
}

function itemEdge(item: Zotero.Item): EdgeKey | undefined {
  const identifiers = readItemPaperIdentifiers(item);
  return edgeIdentity({
    identifiers: {
      DOI: identifiers.doi,
      arXiv: identifiers.arxiv,
      paperID: identifiers.semanticScholarPaperId,
    },
    title: "",
    authors: [],
  });
}

function libraryIDFromScopedKey(scopedKey: ScopedItemKey): number | undefined {
  const separator = scopedKey.indexOf(":");
  if (separator <= 0) { return; }
  const libraryID = Number(scopedKey.slice(0, separator));
  return Number.isFinite(libraryID) ? libraryID : undefined;
}

function isReferencesCache(value: unknown): value is ReferencesCache {
  return Boolean(
    value &&
    typeof value === "object" &&
    Array.isArray((value as ReferencesCache).references),
  );
}

export class UniConnection {
  private indexes = new Map<number, LibraryIndex>();
  private builds = new Map<number, Promise<void>>();

  public constructor(private readonly cache: CacheReader = localStorage) {}

  /**
   * Rebuild one library without touching the cache LRU.
   *
   * The replacement becomes visible only after every item has been processed.
   * Concurrent callers share the same build, while a later explicit call rebuilds
   * again from current Zotero/cache state.
   */
  public async build(libraryID: number): Promise<void> {
    if (!Number.isFinite(libraryID) || libraryID <= 0) {
      throw new Error(`Invalid Zotero libraryID: ${libraryID}`);
    }
    const active = this.builds.get(libraryID);
    if (active) { return active; }

    const building = this.rebuild(libraryID);
    this.builds.set(libraryID, building);
    try {
      await building;
    } finally {
      if (this.builds.get(libraryID) === building) {
        this.builds.delete(libraryID);
      }
    }
  }

  private async rebuild(libraryID: number): Promise<void> {
    const items = (await Zotero.Items.getAll(libraryID, true, false))
      .filter((item: Zotero.Item) => item.isRegularItem?.() && !item.deleted);
    const next = emptyIndex(libraryID);

    // Establish every library endpoint before reading shards. Coupling still
    // indexes references outside the library; edgeOwner alone is library-only.
    for (const item of items) {
      this.ingestSelf(next, item);
    }

    // Bounded parallel reads keep a large library moving without admitting any
    // of these shards to LocalStorage's 32-entry resident cache.
    for (let offset = 0; offset < items.length; offset += READ_BATCH_SIZE) {
      const batch = items.slice(offset, offset + READ_BATCH_SIZE);
      const records = await Promise.all(batch.map((item) =>
        this.cache.readRecordDirect(item, CACHE_KEY_REFERENCES)));
      batch.forEach((item, index) => {
        const record = records[index];
        if (isReferencesCache(record) && cacheMatchesItem(record, item)) {
          this.ingestReferences(next, item, record);
        }
      });
    }

    this.indexes.set(libraryID, next);
  }

  /**
   * Re-index one item from its current shard. Phase 2's notifier can call this;
   * Phase 1 exposes it so update/retract invariants are testable without writes.
   */
  public async ingestItem(
    item: Zotero.Item,
    buildIfMissing = true,
  ): Promise<boolean> {
    const index = buildIfMissing
      ? await this.indexFor(item.libraryID)
      : this.indexes.get(item.libraryID);
    if (!index) { return false; }
    const scopedKey = libraryItemIdentity(item);
    this.retractFrom(index, scopedKey);
    if (!item.isRegularItem?.() || item.deleted) { return true; }

    this.ingestSelf(index, item);
    const record = await this.cache.readRecordDirect(item, CACHE_KEY_REFERENCES);
    if (isReferencesCache(record) && cacheMatchesItem(record, item)) {
      this.ingestReferences(index, item, record);
    }
    return true;
  }

  /** Remove every contribution made by one library item. */
  public retract(scopedKey: ScopedItemKey): void {
    const libraryID = libraryIDFromScopedKey(scopedKey);
    if (libraryID === undefined) { return; }
    const index = this.indexes.get(libraryID);
    if (index) { this.retractFrom(index, scopedKey); }
  }

  /**
   * Delete notifications can arrive after Zotero has discarded the Item object.
   * Numeric item IDs are process-wide, so the built indexes can still locate and
   * retract the old scoped contribution.
   */
  public retractItemID(itemID: number): number | undefined {
    for (const [libraryID, index] of this.indexes) {
      const scopedKey = index.itemIDs.get(itemID);
      if (!scopedKey) { continue; }
      this.retractFrom(index, scopedKey);
      return libraryID;
    }
    return undefined;
  }

  /**
   * Query A: library items whose cached References contain this paper.
   *
   * The first query for a library lazily builds its index. Results are stable by
   * scoped key so UI consumers do not reshuffle between identical reads.
   */
  public async relationsOf(item: Zotero.Item): Promise<RelationHit[]> {
    const index = await this.indexFor(item.libraryID);
    const scopedKey = libraryItemIdentity(item);
    const self = index.selfEdge.get(scopedKey) || itemEdge(item);
    if (!self) { return []; }

    return [...(index.inverted.get(self) || [])]
      .filter((candidate) => candidate !== scopedKey)
      .sort()
      .map((candidate) => ({
        scopedKey: candidate,
        edge: index.selfEdge.get(candidate),
      }));
  }

  /**
   * Query B: library papers sharing the greatest number of distinct references.
   */
  public async coupledWith(
    item: Zotero.Item,
    limit = DEFAULT_COUPLING_LIMIT,
  ): Promise<CouplingHit[]> {
    const index = await this.indexFor(item.libraryID);
    const scopedKey = libraryItemIdentity(item);
    const tally = new Map<ScopedItemKey, number>();

    for (const edge of index.forward.get(scopedKey) || []) {
      for (const candidate of index.inverted.get(edge) || []) {
        if (candidate === scopedKey) { continue; }
        tally.set(candidate, (tally.get(candidate) || 0) + 1);
      }
    }

    const safeLimit = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 0));
    return [...tally]
      .map(([candidate, shared]) => ({ scopedKey: candidate, shared }))
      .sort((left, right) =>
        right.shared - left.shared || left.scopedKey.localeCompare(right.scopedKey))
      .slice(0, safeLimit);
  }

  /** Current in-memory diagnostics; an unbuilt library reports an empty index. */
  public stats(libraryID: number): UniConnectionStats {
    const index = this.indexes.get(libraryID);
    if (!index) {
      return { items: 0, edges: 0, skippedAnon: 0, itemsWithRefs: 0 };
    }
    let edges = 0;
    for (const references of index.forward.values()) {
      edges += references.size;
    }
    let skippedAnon = 0;
    for (const count of index.anonymousByItem.values()) {
      skippedAnon += count;
    }
    return {
      items: index.items.size,
      edges,
      skippedAnon,
      itemsWithRefs: index.itemsWithRefs.size,
    };
  }

  private async indexFor(libraryID: number): Promise<LibraryIndex> {
    const active = this.builds.get(libraryID);
    if (active) { await active; }
    if (!this.indexes.has(libraryID)) { await this.build(libraryID); }
    return this.indexes.get(libraryID)!;
  }

  private ingestSelf(index: LibraryIndex, item: Zotero.Item): void {
    const scopedKey = libraryItemIdentity(item);
    index.items.add(scopedKey);
    index.itemIDs.set(item.id, scopedKey);
    index.scopedItemIDs.set(scopedKey, item.id);
    const self = itemEdge(item);
    if (!self) { return; }
    index.selfEdge.set(scopedKey, self);
    // Zotero can contain duplicate records for one paper. Keep the first owner
    // deterministically; queries use selfEdge and therefore still work for both.
    if (!index.edgeOwner.has(self)) {
      index.edgeOwner.set(self, scopedKey);
    }
  }

  private ingestReferences(
    index: LibraryIndex,
    item: Zotero.Item,
    cache: ReferencesCache,
  ): void {
    const scopedKey = libraryItemIdentity(item);
    if (cache.references.length) {
      index.itemsWithRefs.add(scopedKey);
    }

    const forward = new Set<EdgeKey>();
    let anonymous = 0;
    for (const reference of cache.references) {
      const edge = typeof reference?.edge === "string" ? reference.edge.trim() : "";
      if (!edge) {
        anonymous += 1;
        continue;
      }
      forward.add(edge);
    }
    if (anonymous) { index.anonymousByItem.set(scopedKey, anonymous); }
    if (!forward.size) { return; }

    index.forward.set(scopedKey, forward);
    for (const edge of forward) {
      let citingItems = index.inverted.get(edge);
      if (!citingItems) {
        citingItems = new Set();
        index.inverted.set(edge, citingItems);
      }
      citingItems.add(scopedKey);
    }
  }

  private retractFrom(index: LibraryIndex, scopedKey: ScopedItemKey): void {
    for (const edge of index.forward.get(scopedKey) || []) {
      const citingItems = index.inverted.get(edge);
      citingItems?.delete(scopedKey);
      if (!citingItems?.size) { index.inverted.delete(edge); }
    }
    index.forward.delete(scopedKey);
    index.itemsWithRefs.delete(scopedKey);
    index.anonymousByItem.delete(scopedKey);
    index.items.delete(scopedKey);
    const itemID = index.scopedItemIDs.get(scopedKey);
    if (itemID !== undefined) {
      index.itemIDs.delete(itemID);
      index.scopedItemIDs.delete(scopedKey);
    }

    const self = index.selfEdge.get(scopedKey);
    index.selfEdge.delete(scopedKey);
    if (self && index.edgeOwner.get(self) === scopedKey) {
      index.edgeOwner.delete(self);
      // Preserve a valid owner if Zotero has another item with the same endpoint.
      for (const [candidate, candidateEdge] of index.selfEdge) {
        if (candidateEdge === self) {
          index.edgeOwner.set(self, candidate);
          break;
        }
      }
    }
  }
}

export const uniConnection = new UniConnection();
