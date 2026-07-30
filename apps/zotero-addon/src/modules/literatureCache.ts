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
  return completedEmptyCitations(cache) &&
    now - cache.savedAt <= CITATIONS_NEGATIVE_CACHE_TTL_MS;
}

function sameIdentifier(left: unknown, right: unknown): boolean {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
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
  return sameIdentifier(cache.doi, identifiers.doi) &&
    sameIdentifier(
      cache.semanticScholarPaperId,
      identifiers.semanticScholarPaperId,
    );
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
