/**
 * Thin wrapper around Semantic Scholar's official Academic Graph API.
 *
 * DOI, S2 paperId, and title lookups all funnel through here, so feature modules
 * never assemble calls to the site's private endpoints themselves and the user's
 * configured API key can never be missed.
 */

import { bareDOI, getSemanticScholarJSON } from "./scholarlyHttp";

export interface SemanticScholarPaper {
  paperId?: string;
  /** The old metadata adapter writes this compatibility field temporarily. */
  DOI?: string;
  title?: string;
  year?: number | string;
  authors?: Array<{ authorId?: string; name?: string }>;
  externalIds?: Record<string, string | undefined>;
  url?: string;
  venue?: string;
  abstract?: string;
  journal?: unknown;
  fieldsOfStudy?: unknown;
  publicationVenue?: unknown;
  publicationDate?: string;
  citationCount?: number;
  referenceCount?: number;
  matchScore?: number;
}

export type SemanticScholarPaperIdentity = {
  doi: string;
  paperId: string;
  title?: string;
};

const DEFAULT_FIELDS = [
  "title",
  "year",
  "authors",
  "externalIds",
  "url",
  "venue",
] as const;

function fieldsQuery(fields: readonly string[]): string {
  const unique = Array.from(new Set(fields));
  return unique.length ? `?fields=${encodeURIComponent(unique.join(","))}` : "";
}

export function encodeSemanticScholarPaperIdentifier(identifier: string): string {
  const separator = identifier.indexOf(":");
  if (separator <= 0) { return encodeURIComponent(identifier); }
  return `${encodeURIComponent(identifier.slice(0, separator))}:` +
    encodeURIComponent(identifier.slice(separator + 1));
}

/** Fetch a paper exactly by any official identifier (paperId, DOI:, CorpusId:, …). */
export async function fetchSemanticScholarPaper(
  identifier: string,
  fields: readonly string[] = DEFAULT_FIELDS,
): Promise<SemanticScholarPaper | undefined> {
  const id = String(identifier || "").trim();
  if (!id) { return; }
  return await getSemanticScholarJSON(
    `https://api.semanticscholar.org/graph/v1/paper/${encodeSemanticScholarPaperIdentifier(id)}` +
      fieldsQuery(fields),
    "semanticscholar-paper",
  );
}

/** Fetch one S2 paper exactly by DOI. */
export async function fetchSemanticScholarPaperByDOI(
  rawDOI: string,
  fields: readonly string[] = DEFAULT_FIELDS,
): Promise<SemanticScholarPaper | undefined> {
  const doi = bareDOI(rawDOI);
  if (!doi) { return; }
  return await fetchSemanticScholarPaper(`DOI:${doi}`, fields);
}

/** Return candidates from the official relevance search for the caller to cross-score. */
export async function searchSemanticScholarPapers(
  title: string,
  limit = 5,
  fields: readonly string[] = DEFAULT_FIELDS,
): Promise<SemanticScholarPaper[]> {
  const query = String(title || "").trim();
  if (!query) { return []; }
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit) || 5));
  const uniqueFields = Array.from(new Set(fields));
  const response = await getSemanticScholarJSON(
    `https://api.semanticscholar.org/graph/v1/paper/search?` +
      `query=${encodeURIComponent(query)}&limit=${safeLimit}` +
      (uniqueFields.length ? `&fields=${encodeURIComponent(uniqueFields.join(","))}` : ""),
    "semanticscholar-search",
  );
  return Array.isArray(response?.data) ? response.data : [];
}

/** Resolve a DOI to a Semantic Scholar SHA paperId. */
export async function resolveSemanticScholarPaperByDOI(
  rawDOI: string,
): Promise<SemanticScholarPaperIdentity | undefined> {
  const doi = bareDOI(rawDOI);
  if (!doi) { return; }

  const paper = await fetchSemanticScholarPaperByDOI(doi, ["title", "externalIds"]);
  const paperId = typeof paper?.paperId === "string" ? paper.paperId.trim() : "";
  if (!paper || !paperId) { return; }

  return {
    doi: bareDOI(String(paper.externalIds?.DOI || doi)),
    paperId,
    title: typeof paper.title === "string" ? paper.title : undefined,
  };
}

export async function resolveSemanticScholarPaperIdByDOI(
  rawDOI: string,
): Promise<string | undefined> {
  return (await resolveSemanticScholarPaperByDOI(rawDOI))?.paperId;
}
