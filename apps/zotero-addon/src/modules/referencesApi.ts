/**
 * References fetched directly by DOI.
 *
 * The ZoMiner route has to run MinerU to convert the PDF to Markdown first: slow,
 * and only useful for items already processed. But the overwhelming majority of
 * items arrive with a DOI, and publishers already report their reference lists to
 * Crossref, OpenAlex, and Semantic Scholar — so querying those directly answers in
 * seconds, comes with structured metadata, and skips resolve.ts's per-entry fuzzy
 * matching entirely.
 *
 * Why the three engines are ordered as they are:
 *   - OpenAlex: `referenced_works` returns OpenAlex IDs, and one batch request
 *     brings back full metadata (title, authors, year, venue, abstract, citation
 *     count) in a single trip, so it goes first.
 *   - Crossref: the `reference` field has broad coverage, but its content depends
 *     on the publisher — sometimes only an unstructured string, sometimes a DOI as
 *     well. It is the main fallback.
 *   - Semantic Scholar: anonymous rate limiting is tight (~1 rps), so it goes last.
 *
 * Only when all three come back empty does the caller fall back to ZoMiner's PDF
 * extraction; see the call site in views.ts.
 */

import {
  MAILTO, getJSON, getSemanticScholarJSONStrict,
  bareDOI, bareOpenAlexID, unInvertAbstract, composeText,
} from "./scholarlyHttp";
import { resolveOpenAlexCluster } from "./openAlexCluster";
import { encodeSemanticScholarPaperIdentifier } from "./semanticScholarApi";
import { edgeIdentity } from "./edgeIdentity";
import {
  fromOpenAlexPublicationType,
  fromSemanticScholarPublicationType,
} from "./publicationType";

/** Maximum number of IDs one OpenAlex filter query can carry. */
const OPENALEX_BATCH = 50;

/**
 * How each of the three sources fared in the last query. When a reference list
 * looks short, this distinguishes "there really are few" from "one source failed".
 */
export const referencesDiagnostics: {
  doi?: string;
  semanticScholarPaperId?: string;
  semanticScholarLookup?: string;
  openAlex?: string;
  crossref?: string;
  semanticScholar?: string;
  chosen?: string;
} = {};

export interface ReferencesResult {
  references: ItemBaseInfo[];
  /** Which engine matched, shown in the sidebar's source badge and messages. */
  source: "OpenAlex" | "Crossref" | "Semantic Scholar";
}

function fromOpenAlexWork(work: any, index: number): ItemBaseInfo {
  const doi = work?.doi ? bareDOI(work.doi) : undefined;
  const authors = (work?.authorships || [])
    .map((a: any) => a?.author?.display_name)
    .filter(Boolean);
  const info: ItemBaseInfo = {
    identifiers: doi ? { DOI: doi } : {},
    title: work?.display_name || work?.title || "",
    authors,
    year: work?.publication_year ? String(work.publication_year) : undefined,
    primaryVenue: work?.primary_location?.source?.display_name || undefined,
    abstract: unInvertAbstract(work?.abstract_inverted_index),
    citations: typeof work?.cited_by_count === "number" ? work.cited_by_count : undefined,
    url: doi ? `https://doi.org/${doi}` : work?.id,
    number: index + 1,
    type: fromOpenAlexPublicationType(work),
    source: "OpenAlex",
  };
  info.text = composeText(info);
  return info;
}

const OPENALEX_SELECT = "id,doi,display_name,authorships,publication_year,primary_location," +
  "abstract_inverted_index,cited_by_count,type";

/**
 * OpenAlex: fetch referenced_works first — just a list of IDs — then pull the
 * metadata back in batches. Batch requests keep their order so the reference
 * numbers in the sidebar line up roughly with the source paper.
 *
 * Two problems, both found in practice:
 *   1. The record the item's DOI points at is not necessarily the one with the
 *      fullest reference list (23 entries on the preprint versus 185 on the
 *      published version), so the record cluster is gathered first and the one
 *      with the largest `referenced_works_count` is used.
 *   2. A `filter=openalex:` batch query does not follow merge redirects — merged
 *      IDs simply do not come back. A batch of 23 IDs returned 19, and the
 *      remaining 4 had to be fetched individually.
 */
async function fromOpenAlex(doi: string): Promise<ItemBaseInfo[] | null> {
  const cluster = await resolveOpenAlexCluster(doi);
  if (!cluster.length) { return null; }
  const best = cluster.reduce((a, b) => (b.referencedCount > a.referencedCount ? b : a));
  if (!best.referencedCount) { return null; }

  const work = await getJSON(
    `https://api.openalex.org/works/${best.id}?select=referenced_works&mailto=${MAILTO}`,
    { tag: "referencesApi" },
  );
  const ids: string[] = (work?.referenced_works || [])
    .map((id: string) => bareOpenAlexID(id))
    .filter(Boolean);
  if (!ids.length) { return null; }

  // Index by ID so out-of-order results can be restored to referenced_works order.
  const byId = new Map<string, any>();
  for (let start = 0; start < ids.length; start += OPENALEX_BATCH) {
    const chunk = ids.slice(start, start + OPENALEX_BATCH);
    const page = await getJSON(
      `https://api.openalex.org/works?filter=openalex:${chunk.join("|")}` +
      `&per-page=${OPENALEX_BATCH}&select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
      { tag: "referencesApi" },
    );
    for (const result of page?.results || []) {
      byId.set(bareOpenAlexID(result?.id), result);
    }
  }
  // Fill in what the batch query missed, one at a time: the single-record endpoint
  // does follow merges, so the returned id may differ from the requested one —
  // store under the requested ID to keep the order intact.
  // Capped at 20: normally only a handful are missing, and losing them wholesale
  // means the whole batch request failed, where one-by-one retries only go slower.
  const missing = ids.filter((id) => !byId.has(id)).slice(0, 20);
  for (const id of missing) {
    const single = await getJSON(
      `https://api.openalex.org/works/${id}?select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
      { tag: "referencesApi" },
    );
    if (single?.id) { byId.set(id, single); }
  }
  if (!byId.size) { return null; }
  // Merge redirects can land two requested IDs on the same work; deduplicate by
  // the final id.
  const emitted = new Set<string>();
  return ids
    .map((id) => byId.get(id))
    .filter((work) => {
      const id = bareOpenAlexID(work?.id || "");
      if (!id || emitted.has(id)) { return false; }
      emitted.add(id);
      return true;
    })
    .map(fromOpenAlexWork);
}

/** A Crossref reference entry: it may carry structured fields, an unstructured string, or both. */
function fromCrossrefReference(reference: any, index: number): ItemBaseInfo | null {
  if (!reference) { return null; }
  const doi = reference.DOI ? bareDOI(reference.DOI) : undefined;
  const title = reference["article-title"] || reference["volume-title"] || "";
  const raw = reference.unstructured || "";
  if (!doi && !title && !raw) { return null; }
  const info: ItemBaseInfo = {
    identifiers: doi ? { DOI: doi } : {},
    title,
    authors: reference.author ? [String(reference.author)] : [],
    year: reference.year ? String(reference.year) : undefined,
    primaryVenue: reference["journal-title"] || undefined,
    url: doi ? `https://doi.org/${doi}` : undefined,
    number: index + 1,
    type: "journalArticle",
    source: "Crossref",
  };
  // The raw string wins: it is the line as printed in the source and carries the
  // most information. Only without one do the structured fields get assembled.
  info.text = raw || composeText(info);
  if (!info.text && doi) {
    // The publisher reported only a DOI. Put a placeholder in to give the row
    // something to show, flagged so the resolve pass replaces it.
    info.text = `DOI: ${doi}`;
    info._placeholderText = true;
  }
  return info;
}

async function fromCrossref(doi: string): Promise<ItemBaseInfo[] | null> {
  const message = await getJSON(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`,
    { tag: "referencesApi" },
  ).then((r) => r?.message);
  const list = (message?.reference || [])
    .map(fromCrossrefReference)
    .filter(Boolean) as ItemBaseInfo[];
  return list.length ? list : null;
}

async function fromSemanticScholar(identifier: string): Promise<ItemBaseInfo[] | null> {
  // isInfluential/intents/contexts are citation-edge fields: S2 only returns them
  // when they are requested explicitly, so they must sit in `fields` alongside the
  // paper-level fields that get nested under citedPaper.
  const fields =
    "externalIds,title,authors,year,venue,abstract,citationCount," +
    "influentialCitationCount,publicationTypes,url,isInfluential,intents,contexts";
  const data = await getSemanticScholarJSONStrict(
    `https://api.semanticscholar.org/graph/v1/paper/` +
    `${encodeSemanticScholarPaperIdentifier(identifier)}` +
    `/references?fields=${fields}&limit=1000`,
    "referencesApi",
  );
  const list = (data?.data || [])
    .map((entry: any, index: number) => {
      const paper = entry?.citedPaper;
      if (!paper) { return null; }
      const refDOI = paper.externalIds?.DOI ? bareDOI(paper.externalIds.DOI) : undefined;
      const arxiv = paper.externalIds?.ArXiv;
      const identifiers: ItemBaseInfo["identifiers"] = {};
      if (refDOI) { identifiers.DOI = refDOI; }
      if (arxiv) { identifiers.arXiv = arxiv; }
      if (paper.paperId) { identifiers.paperID = paper.paperId; }
      const info: ItemBaseInfo = {
        identifiers,
        title: paper.title || "",
        authors: (paper.authors || []).map((a: any) => a?.name).filter(Boolean),
        year: paper.year ? String(paper.year) : undefined,
        primaryVenue: paper.venue || undefined,
        abstract: paper.abstract || undefined,
        citations: typeof paper.citationCount === "number" ? paper.citationCount : undefined,
        influentialCitationCount: typeof paper.influentialCitationCount === "number"
          ? paper.influentialCitationCount
          : undefined,
        url: refDOI ? `https://doi.org/${refDOI}` : paper.url,
        number: index + 1,
        type: fromSemanticScholarPublicationType(paper, arxiv, refDOI),
        source: "Semantic Scholar",
        isInfluential: typeof entry.isInfluential === "boolean"
          ? entry.isInfluential
          : undefined,
        intents: Array.isArray(entry.intents) ? entry.intents : undefined,
        contexts: Array.isArray(entry.contexts) ? entry.contexts : undefined,
      };
      info.text = composeText(info);
      return info;
    })
    .filter(Boolean) as ItemBaseInfo[];
  return list.length ? list : null;
}

/**
 * Fetch references from whatever identifiers the item has. A DOI goes to all three
 * sources, a Paper ID to Semantic Scholar; when both exist, S2 takes the more
 * precise Paper ID. When several sources answer, **the longest list wins**.
 *
 * This used to be "first non-empty result wins", with OpenAlex first, so whatever
 * OpenAlex returned was the answer — and for 10.2139/ssrn.3086063 that was 19
 * entries against Semantic Scholar's 140. References can be missed but never
 * invented, so the longer list has the better coverage, and there is no reason to
 * let ordering decide the outcome.
 *
 * The cost is waiting for all three rather than returning on the first hit. But
 * they run concurrently, so the slowest one sets the total, usually a second or
 * two more — in exchange for never inexplicably losing half the list.
 *
 * Returns null when all are empty, which tells the caller to fall back to
 * ZoMiner's PDF extraction.
 */
export async function fetchReferencesByIdentifiers(
  rawDOI?: string,
  rawSemanticScholarPaperId?: string,
): Promise<ReferencesResult | null> {
  const doi = bareDOI(rawDOI || "");
  const semanticScholarPaperId = String(rawSemanticScholarPaperId || "").trim();
  const semanticScholarIdentifier = semanticScholarPaperId || (doi ? `DOI:${doi}` : "");
  referencesDiagnostics.doi = doi;
  referencesDiagnostics.semanticScholarPaperId = semanticScholarPaperId;
  referencesDiagnostics.semanticScholarLookup = semanticScholarIdentifier || undefined;
  referencesDiagnostics.chosen = undefined;
  referencesDiagnostics.openAlex = doi ? "pending" : "skipped (no DOI)";
  referencesDiagnostics.crossref = doi ? "pending" : "skipped (no DOI)";
  referencesDiagnostics.semanticScholar = semanticScholarIdentifier
    ? "pending"
    : "skipped (no Paper ID or DOI)";
  if (!doi && !semanticScholarIdentifier) { return null; }

  const run = async (
    source: ReferencesResult["source"],
    key: "openAlex" | "crossref" | "semanticScholar",
    engine: () => Promise<ItemBaseInfo[] | null>,
  ): Promise<ReferencesResult | null> => {
    referencesDiagnostics[key] = "pending";
    try {
      const references = await engine();
      referencesDiagnostics[key] = references?.length ? `ok count=${references.length}` : "empty";
      return references?.length ? { references, source } : null;
    } catch (error) {
      referencesDiagnostics[key] = `error: ${String(error).slice(0, 200)}`;
      ztoolkit.log(`[referencesApi] ${source} failed`, error);
      return null;
    }
  };

  const results = await Promise.all([
    doi ? run("OpenAlex", "openAlex", () => fromOpenAlex(doi)) : Promise.resolve(null),
    doi ? run("Crossref", "crossref", () => fromCrossref(doi)) : Promise.resolve(null),
    semanticScholarIdentifier
      ? run("Semantic Scholar", "semanticScholar", () => fromSemanticScholar(semanticScholarIdentifier))
      : Promise.resolve(null),
  ]);
  // Only a strictly larger count switches source: on a tie, keep the OpenAlex →
  // Crossref → Semantic Scholar preference, since the earlier ones return more
  // structured metadata and leave the resolve pass less to fill in.
  let best: ReferencesResult | null = null;
  for (const result of results) {
    if (result && (!best || result.references.length > best.references.length)) { best = result; }
  }
  // Coverage still decides which list wins, but Semantic Scholar's citation-edge
  // signals are orthogonal metadata. Merge them into an OpenAlex/Crossref winner
  // where an identifier overlaps instead of throwing away either the longer list
  // or the influence/intent information.
  const semanticScholar = results.find((result) => result?.source === "Semantic Scholar");
  if (best && semanticScholar && best !== semanticScholar) {
    const edgeByIdentity = new Map(
      semanticScholar.references
        .map((entry) => [edgeIdentity(entry), entry] as const)
        .filter(([identity]) => Boolean(identity)),
    );
    for (const entry of best.references) {
      const identity = edgeIdentity(entry);
      const edge = identity ? edgeByIdentity.get(identity) : undefined;
      if (!edge) { continue; }
      entry.isInfluential = edge.isInfluential;
      entry.intents = edge.intents;
      entry.contexts = edge.contexts;
      entry.influentialCitationCount ??= edge.influentialCitationCount;
    }
  }
  referencesDiagnostics.chosen = best ? `${best.source} (${best.references.length})` : "none";
  return best;
}

/** Kept for older call sites; new UI should also pass the item's Semantic Scholar Paper ID. */
export async function fetchReferencesByDOI(rawDOI: string): Promise<ReferencesResult | null> {
  return fetchReferencesByIdentifiers(rawDOI);
}
