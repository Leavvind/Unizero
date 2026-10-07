/**
 * Combine per-source reference/citation lists into one deduplicated view.
 *
 * Each provider answers a different slice of the truth: Crossref preserves the
 * paper's own reference order but often carries only a bare DOI; OpenAlex and
 * Semantic Scholar return rich bibliographic metadata; only Semantic Scholar
 * reports citation-edge influence. The old "longest list wins" rule threw away two
 * of the three every time. This module keeps all of them: it unions the entries by
 * identity and fills each field from whichever source answered it best.
 */

import { edgeIdentity } from "./edgeIdentity";

export type RelationSourceKey = "openAlex" | "crossref" | "semanticScholar";

/**
 * A source that answered successfully but has nothing to give for this paper, and
 * never will — distinct from a transient error. Semantic Scholar throws this for
 * references when the publisher has elided the reference list from its API (common
 * for Wiley, Elsevier, and other major houses): the website shows the references,
 * the API returns `data: null`. Treating it as "empty" reads as a plain 0; treating
 * it as an error reads as "retry me". It is neither, so the UI labels it "restricted".
 */
export class RelationUnavailableError extends Error {
  constructor(reason = "unavailable") {
    super(reason);
    this.name = "RelationUnavailableError";
  }
}

/** Sentinel status for a source that is restricted at the provider (see above). */
export const RELATION_STATUS_UNAVAILABLE = "unavailable";

/** One provider's contribution, plus enough paging state to refresh it alone. */
export interface RelationSourceResult {
  key: RelationSourceKey;
  name: string;
  entries: ItemBaseInfo[];
  /** Provider total (citations) or entries.length (references). */
  total: number;
  /** "ok" | "empty" | "unavailable" | "skipped …" | "error: …" — so 0 ≠ failed. */
  status: string;
  hasMore?: boolean;
  page?: number;
  openAlexFilter?: string;
}

export const RELATION_SOURCE_NAME: Record<RelationSourceKey, string> = {
  openAlex: "OpenAlex",
  crossref: "Crossref",
  semanticScholar: "Semantic Scholar",
};

const RELATION_SOURCE_CODE: Record<RelationSourceKey, string> = {
  openAlex: "OA",
  crossref: "CR",
  semanticScholar: "S2",
};

/**
 * Which source answers a bibliographic field when several disagree. OpenAlex and
 * Semantic Scholar return structured records; Crossref is last because its entries
 * are frequently just a DOI, which is exactly the gap the merge is meant to fill.
 */
const BIBLIO_PRECEDENCE: RelationSourceKey[] = [
  "openAlex",
  "semanticScholar",
  "crossref",
];

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) { return false; }
  if (typeof value === "string") { return value.trim().length > 0; }
  if (Array.isArray(value)) { return value.length > 0; }
  return true;
}

interface Group {
  entries: Map<RelationSourceKey, ItemBaseInfo>;
}

function pickField(group: Group, field: string): any {
  for (const key of BIBLIO_PRECEDENCE) {
    const value = group.entries.get(key)?.[field];
    if (isPresent(value)) { return value; }
  }
  return undefined;
}

function mergedIdentifiers(group: Group): ItemBaseInfo["identifiers"] {
  const identifiers: ItemBaseInfo["identifiers"] = {};
  for (const key of BIBLIO_PRECEDENCE) {
    const source = group.entries.get(key)?.identifiers;
    if (!source) { continue; }
    if (!identifiers.DOI && source.DOI) { identifiers.DOI = source.DOI; }
    if (!identifiers.arXiv && source.arXiv) { identifiers.arXiv = source.arXiv; }
    if (!identifiers.paperID && source.paperID) { identifiers.paperID = source.paperID; }
    if (!identifiers.openAlex && source.openAlex) {
      identifiers.openAlex = source.openAlex;
    }
  }
  return identifiers;
}

function numericMax(group: Group, field: string): number | undefined {
  let max: number | undefined;
  for (const entry of group.entries.values()) {
    const value = entry[field];
    if (typeof value === "number" && (max === undefined || value > max)) { max = value; }
  }
  return max;
}

function contributingSource(group: Group): string {
  return [...group.entries.keys()]
    .map((key) => RELATION_SOURCE_CODE[key])
    .join("·");
}

function composeGroup(group: Group): ItemBaseInfo {
  const s2 = group.entries.get("semanticScholar");
  const merged: ItemBaseInfo = {
    identifiers: mergedIdentifiers(group),
    title: pickField(group, "title") || "",
    authors: pickField(group, "authors") || [],
    year: pickField(group, "year"),
    type: pickField(group, "type"),
    text: pickField(group, "text"),
    url: pickField(group, "url"),
    primaryVenue: pickField(group, "primaryVenue"),
    publicationLevel: pickField(group, "publicationLevel"),
    abstract: pickField(group, "abstract"),
    citations: numericMax(group, "citations"),
    // Influence is a Semantic Scholar edge signal; no other source reports it.
    isInfluential: s2?.isInfluential,
    intents: s2?.intents,
    contexts: s2?.contexts,
    influentialCitationCount: s2?.influentialCitationCount ??
      numericMax(group, "influentialCitationCount"),
    source: contributingSource(group),
  };
  return merged;
}

/**
 * Union the sources into one ordered list.
 *
 * `orderPreference` decides whose sequence the merged list follows: references pass
 * Crossref first so the paper's own reference order survives; citations lead with
 * the provider that sorts by citation count. Entries without any identifier cannot
 * be deduplicated (they never resolved to a DOI/arXiv/paper id), so they are kept
 * as-is and appended rather than risk merging two different papers.
 */
export function mergeRelationSources(
  sources: RelationSourceResult[],
  orderPreference: RelationSourceKey[],
): ItemBaseInfo[] {
  const present = sources.filter((source) => source.entries.length);
  if (present.length === 1) {
    return present[0].entries.map((entry) => ({
      ...entry,
      source: present[0].name,
    }));
  }
  if (!present.length) { return []; }

  const byKey = new Map<RelationSourceKey, ItemBaseInfo[]>();
  for (const source of present) { byKey.set(source.key, source.entries); }

  const groups = new Map<string, Group>();
  for (const source of present) {
    for (const entry of source.entries) {
      const identity = edgeIdentity(entry);
      if (!identity) { continue; }
      let group = groups.get(identity);
      if (!group) { group = { entries: new Map() }; groups.set(identity, group); }
      if (!group.entries.has(source.key)) { group.entries.set(source.key, entry); }
    }
  }

  const walkOrder: RelationSourceKey[] = [
    ...orderPreference.filter((key) => byKey.has(key)),
    ...present.map((source) => source.key)
      .filter((key) => !orderPreference.includes(key)),
  ];

  const merged: ItemBaseInfo[] = [];
  const emitted = new Set<string>();
  for (const key of walkOrder) {
    for (const entry of byKey.get(key) || []) {
      const identity = edgeIdentity(entry);
      if (!identity || emitted.has(identity)) { continue; }
      emitted.add(identity);
      merged.push(composeGroup(groups.get(identity)!));
    }
  }
  // Anonymous entries keep their provider order and source label.
  for (const key of walkOrder) {
    for (const entry of byKey.get(key) || []) {
      if (edgeIdentity(entry)) { continue; }
      merged.push({ ...entry, source: RELATION_SOURCE_CODE[key] });
    }
  }
  merged.forEach((entry, index) => { entry.number = index + 1; });
  return merged;
}
