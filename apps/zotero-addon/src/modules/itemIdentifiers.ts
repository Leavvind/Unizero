/**
 * External paper identifiers on a Zotero item.
 *
 * A DOI may sit in the native field or in Extra; a Semantic Scholar Paper ID has
 * no native Zotero field and is written to Extra by convention. Keeping the read
 * rules in one place is what stops enrichment, References, and Citations from
 * disagreeing about an identifier that has already been written.
 */

import { bareDOI } from "./scholarlyHttp";

export const S2_ID_FIELD = "Semantic Scholar Paper ID";
export const S2_ID_ALIASES = [
  S2_ID_FIELD,
  "Semantic Scholar Paper",
  "Semantic Scholar ID",
  "S2 Paper ID",
  "S2 ID",
];

/**
 * The Semantic Scholar citation count, as of the last Complete Metadata run.
 *
 * A snapshot rather than a property of the work, so it is refreshed on every
 * run and read back out only to project it into a converted document.
 */
export const CITATION_COUNT_FIELD = "Citation Count";
export const CITATION_COUNT_ALIASES = [
  CITATION_COUNT_FIELD,
  "Citations",
  "citationCount",
];

export interface ItemPaperIdentifiers {
  doi?: string;
  semanticScholarPaperId?: string;
  citations?: number;
}

export function getExtraValue(extra: string, aliases: readonly string[]): string | undefined {
  const escaped = aliases.map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`^(?:${escaped.join("|")})\\s*:\\s*(.+)$`, "im");
  return String(extra || "").match(pattern)?.[1]?.trim() || undefined;
}

/** Accepts a bare SHA, a PaperId: prefix, and a Semantic Scholar paper page URL. */
export function normalizeSemanticScholarPaperId(value?: string): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) { return; }
  const urlMatch = raw.match(
    /semanticscholar\.org\/paper\/(?:[^/]+\/)?([a-f\d]{40})(?:[/?#]|$)/i,
  );
  return (urlMatch?.[1] || raw.replace(/^paperid\s*:\s*/i, "")).trim() || undefined;
}

export function readItemPaperIdentifiers(item: Zotero.Item): ItemPaperIdentifiers {
  const extra = String(item.getField("extra") || "");
  let doi = "";
  try { doi = String(item.getField("DOI") || ""); } catch { /* this item type has no DOI field */ }
  if (!doi) {
    try { doi = String(item.getExtraField("DOI") || ""); } catch { /* unknown Extra field */ }
  }
  doi ||= getExtraValue(extra, ["DOI"]) || "";
  const citations = Number(getExtraValue(extra, CITATION_COUNT_ALIASES));
  return {
    doi: doi ? bareDOI(doi) : undefined,
    semanticScholarPaperId: normalizeSemanticScholarPaperId(
      getExtraValue(extra, S2_ID_ALIASES),
    ),
    citations: Number.isFinite(citations) && citations >= 0 ? citations : undefined,
  };
}
