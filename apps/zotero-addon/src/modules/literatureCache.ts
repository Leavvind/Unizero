/**
 * Shared shapes and identity checks for the per-item literature caches.
 *
 * Views owns fetching and persistence policy. Other consumers, such as the
 * derived UniConnection graph, only need to understand the records already on
 * disk. Keeping that small contract here avoids making those consumers depend on
 * the UI-heavy Views module.
 */

import {
  readItemPaperIdentifiers,
  type ItemPaperIdentifiers,
} from "./itemIdentifiers";
import { forPersistence } from "./edgeIdentity";
import type { RelationSourceResult } from "./mergeRelations";

export const CACHE_KEY_REFERENCES = "References-Resolved-v4";
export const CACHE_KEY_CITATIONS = "Citations-v4";
export const CITATIONS_NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReferencesCache {
  savedAt: number;
  source: string;
  /** Identifiers at save time; a change means this list may belong to another paper. */
  doi: string;
  semanticScholarPaperId?: string;
  resolved: boolean;
  references: ItemBaseInfo[];
  perSource?: RelationSourceResult[];
}

export interface CitationsCache {
  savedAt: number;
  doi: string;
  semanticScholarPaperId?: string;
  source: string;
  openAlexFilter?: string;
  page: number;
  loaded: number;
  total: number;
  all: ItemBaseInfo[];
  perSource?: RelationSourceResult[];
}

/**
 * Empty citation lists are useful negative results only when at least one
 * provider completed normally. A page where every provider failed must be
 * retried next session instead of becoming a durable "0 citations" claim.
 */
export function completedEmptyCitations(
  cache: Pick<CitationsCache, "all" | "perSource">,
): boolean {
  return cache.all.length === 0 && Boolean(cache.perSource?.some((source) =>
    source.status === "empty" || source.status === "ok"));
}

/**
 * Whether a References record still answers for this paper.
 *
 * The saved shard and the in-session copy of it are the same record in two
 * places, so both are judged here rather than only on the way off disk: a
 * "no source" answer fetched before a DOI was filled in must stop being the
 * answer the moment the DOI arrives, whichever copy the caller happens to read.
 */
export function referencesCacheIsUsable(
  cache: ReferencesCache | undefined,
  identifiers: ItemPaperIdentifiers,
): cache is ReferencesCache {
  // An empty array is a meaningful completed lookup: its per-source statuses say
  // whether providers answered empty, were restricted, or failed. Do not turn it
  // back into a cache miss and discard that evidence.
  if (!cache || !Array.isArray(cache.references)) { return false; }
  if (!cacheMatchesIdentifiers(cache, identifiers)) { return false; }
  // The shard is this paper's, but an identifier it was saved without may
  // unlock a provider that was skipped last time. Worth another fetch only
  // when there is nothing to show for the last one.
  if (!cache.references.length && identifiersGained(cache, identifiers)) {
    return false;
  }
  return true;
}

export function citationsCacheIsUsable(
  cache: CitationsCache | undefined,
  identifiers: ItemPaperIdentifiers,
  now = Date.now(),
): cache is CitationsCache {
  if (
    !cache ||
    !Array.isArray(cache.all) ||
    !cacheMatchesIdentifiers(cache, identifiers)
  ) {
    return false;
  }
  if (cache.all.length) { return true; }
  // An identifier gained since the save could be exactly what the providers were
  // missing, so an empty list is not a durable answer once one arrives.
  if (identifiersGained(cache, identifiers)) { return false; }
  return completedEmptyCitations(cache) &&
    now - cache.savedAt <= CITATIONS_NEGATIVE_CACHE_TTL_MS;
}

function normalizeIdentifier(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

/**
 * True when a saved identifier and the item's current one name different papers.
 *
 * Absence on either side is "unknown", not a disagreement: the enrichment run
 * that writes a Semantic Scholar ID into Extra long after a list was fetched is
 * describing the same work, and treating that as a new identity threw away a
 * perfectly good shard — intermittently, because it only happened on the runs
 * that actually found an identifier.
 */
function identifierConflicts(saved: unknown, current: unknown): boolean {
  const left = normalizeIdentifier(saved);
  const right = normalizeIdentifier(current);
  return Boolean(left) && Boolean(right) && left !== right;
}

/**
 * Long-lived shards are valid only while their save-time paper identity still
 * matches the Zotero item. This is shared by the normal UI cache path and the
 * whole-library graph scan so they cannot disagree after a DOI/S2 edit.
 */
export function cacheMatchesIdentifiers(
  cache: Pick<ReferencesCache, "doi" | "semanticScholarPaperId">,
  identifiers: ItemPaperIdentifiers,
): boolean {
  return !identifierConflicts(cache.doi, identifiers.doi) &&
    !identifierConflicts(
      cache.semanticScholarPaperId,
      identifiers.semanticScholarPaperId,
    );
}

/**
 * True when the item now carries an identifier the shard was saved without.
 *
 * The shard still belongs to this paper — `cacheMatchesIdentifiers` keeps it —
 * but a provider that was skipped for want of that identifier could now answer.
 * That only justifies fetching again when the shard has nothing to show; a
 * populated list is kept and upgraded on the next explicit refresh.
 */
export function identifiersGained(
  cache: Pick<ReferencesCache, "doi" | "semanticScholarPaperId">,
  identifiers: ItemPaperIdentifiers,
): boolean {
  const gained = (saved: unknown, current: unknown) =>
    !normalizeIdentifier(saved) && Boolean(normalizeIdentifier(current));
  return gained(cache.doi, identifiers.doi) ||
    gained(cache.semanticScholarPaperId, identifiers.semanticScholarPaperId);
}

export function cacheMatchesItem(
  cache: Pick<ReferencesCache, "doi" | "semanticScholarPaperId">,
  item: Zotero.Item,
): boolean {
  return cacheMatchesIdentifiers(cache, readItemPaperIdentifiers(item));
}

export function persistRelationSources(
  perSource?: RelationSourceResult[],
): RelationSourceResult[] | undefined {
  return perSource?.map((entry) => ({
    ...entry,
    entries: forPersistence(entry.entries, entry.name),
  }));
}

/** Build the one canonical on-disk References payload. */
export function makeReferencesCache(
  item: Zotero.Item,
  source: string,
  references: ItemBaseInfo[],
  resolved: boolean,
  perSource?: RelationSourceResult[],
): ReferencesCache {
  const identifiers = readItemPaperIdentifiers(item);
  return {
    savedAt: Date.now(),
    source,
    doi: identifiers.doi || "",
    semanticScholarPaperId: identifiers.semanticScholarPaperId,
    resolved,
    references: forPersistence(references, source),
    perSource: persistRelationSources(perSource),
  };
}
