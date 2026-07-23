/**
 * Papers that cite this one (Citations).
 *
 * The other side of referencesApi's coin: that module asks who this paper cites,
 * this one asks who cites this paper.
 *
 * Why "first non-empty result wins" — the rule references uses — does not work
 * here, from two problems both found in practice:
 *
 *   1. **OpenAlex splits one paper into several works.** For example, "Short- and
 *      Long-Horizon Behavioral Factors" exists in OpenAlex both as the SSRN working
 *      paper (W2779103412, cited 7) and as the RFS publication (W3010918279, cited
 *      1). Whichever DOI the item carries, you see only that half, and the pane
 *      reports "1 citation". The fix is to gather the duplicate works by title and
 *      take the union with `cites:W1|W2`.
 *
 *   2. **Coverage between the two sources can differ by an order of magnitude.**
 *      For one paper OpenAlex gives 8 after the union while Semantic Scholar gives
 *      287. The larger number is the right one — citations can be missed but never
 *      invented — so both are queried and the larger wins, rather than whichever
 *      answers first.
 *
 * A paper may have thousands of citations, and fetching all of them is both slow
 * and pointless; pages are taken in descending citation count, so the first page is
 * the N most important ones.
 */

import {
  MAILTO, getJSON, getSemanticScholarJSONStrict, getSemanticScholarKey,
  bareDOI, unInvertAbstract, composeText,
} from "./scholarlyHttp";
import { resolveOpenAlexCluster } from "./openAlexCluster";
import { encodeSemanticScholarPaperIdentifier } from "./semanticScholarApi";

/**
 * How each source fared in the last query. In the UI, "0 citations" cannot be told
 * apart from "both sources failed".
 */
export const citationsDiagnostics: {
  doi?: string;
  semanticScholarPaperId?: string;
  semanticScholarLookup?: string;
  openAlex?: string;
  semanticScholar?: string;
} = {};

/**
 * Items per page. Sorted by descending citation count, so the first page is the N
 * most important papers rather than a random N.
 */
export const CITATIONS_PAGE_SIZE = 50;

export interface CitationsResult {
  citations: ItemBaseInfo[];
  /** Total citation count, usually far larger than citations.length. */
  total: number;
  source: "OpenAlex" | "Semantic Scholar";
  /** Whether another page exists, so the UI can decide about "Load more". */
  hasMore: boolean;
  /** Reused when paging, to avoid resolving DOI→work ID a second time. */
  openAlexFilter?: string;
}

const OPENALEX_SELECT = "id,doi,display_name,authorships,publication_year,primary_location," +
  "abstract_inverted_index,cited_by_count,type";

function fromOpenAlexWork(work: any, index: number): ItemBaseInfo {
  const doi = work?.doi ? bareDOI(work.doi) : undefined;
  const info: ItemBaseInfo = {
    identifiers: doi ? { DOI: doi } : {},
    title: work?.display_name || "",
    authors: (work?.authorships || []).map((a: any) => a?.author?.display_name).filter(Boolean),
    year: work?.publication_year ? String(work.publication_year) : undefined,
    primaryVenue: work?.primary_location?.source?.display_name || undefined,
    abstract: unInvertAbstract(work?.abstract_inverted_index),
    citations: typeof work?.cited_by_count === "number" ? work.cited_by_count : undefined,
    url: doi ? `https://doi.org/${doi}` : work?.id,
    number: index + 1,
    type: work?.type === "preprint" ? "preprint" : "journalArticle",
    source: "OpenAlex",
  };
  info.text = composeText(info);
  return info;
}

async function fromOpenAlex(doi: string, page: number): Promise<CitationsResult | null> {
  // A preprint and a published version are separate works with separate citation
  // counts, so take the union. See openAlexCluster.ts.
  const cluster = await resolveOpenAlexCluster(doi);
  if (!cluster.length) { return null; }
  const filter = `cites:${cluster.map((work) => work.id).join("|")}`;
  const citedBy = cluster.reduce((sum, work) => sum + work.citedBy, 0);
  return fetchOpenAlexPage(filter, page, citedBy);
}

async function fetchOpenAlexPage(
  filter: string,
  page: number,
  knownTotal?: number,
): Promise<CitationsResult | null> {
  const data = await getJSON(
    `https://api.openalex.org/works?filter=${filter}&page=${page}` +
    `&per-page=${CITATIONS_PAGE_SIZE}&sort=cited_by_count:desc&select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
    { tag: "citationsApi" },
  );
  const results = data?.results || [];
  if (!results.length) { return null; }
  const total = data?.meta?.count ?? knownTotal ?? results.length;
  const offset = (page - 1) * CITATIONS_PAGE_SIZE;
  return {
    citations: results.map((work: any, index: number) => fromOpenAlexWork(work, offset + index)),
    total,
    source: "OpenAlex",
    hasMore: offset + results.length < total,
    openAlexFilter: filter,
  };
}

async function fromSemanticScholar(
  identifier: string,
  page: number,
): Promise<CitationsResult | null> {
  const fields = "externalIds,title,authors,year,venue,abstract,citationCount,url";
  const offset = (page - 1) * CITATIONS_PAGE_SIZE;
  const data = await getSemanticScholarJSONStrict(
    `https://api.semanticscholar.org/graph/v1/paper/` +
    `${encodeSemanticScholarPaperIdentifier(identifier)}` +
    `/citations?fields=${fields}&limit=${CITATIONS_PAGE_SIZE}&offset=${offset}`,
    "citationsApi",
  );
  const entries = data?.data || [];
  if (!entries.length) { return null; }
  const citations: ItemBaseInfo[] = entries
    .map((entry: any, index: number) => {
      const paper = entry?.citingPaper;
      if (!paper) { return null; }
      const citingDOI = paper.externalIds?.DOI ? bareDOI(paper.externalIds.DOI) : undefined;
      const arxiv = paper.externalIds?.ArXiv;
      const identifiers: ItemBaseInfo["identifiers"] = {};
      if (citingDOI) { identifiers.DOI = citingDOI; }
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
        url: citingDOI ? `https://doi.org/${citingDOI}` : paper.url,
        number: offset + index + 1,
        type: arxiv && !citingDOI ? "preprint" : "journalArticle",
        source: "Semantic Scholar",
      };
      info.text = composeText(info);
      return info;
    })
    .filter(Boolean) as ItemBaseInfo[];
  if (!citations.length) { return null; }
  const total = data?.total ?? offset + citations.length;
  return { citations, total, source: "Semantic Scholar", hasMore: offset + citations.length < total };
}

/**
 * Fetch the first page of citations. With a DOI both sources are queried; with
 * only a Paper ID, S2 still is. The source with the **larger total** wins —
 * citations can be missed but never invented, so the larger number means better
 * coverage. Returns null when both come back empty.
 */
export async function fetchCitationsByIdentifiers(
  rawDOI?: string,
  rawSemanticScholarPaperId?: string,
): Promise<CitationsResult | null> {
  const doi = bareDOI(rawDOI || "");
  const semanticScholarPaperId = String(rawSemanticScholarPaperId || "").trim();
  const semanticScholarIdentifier = semanticScholarPaperId || (doi ? `DOI:${doi}` : "");
  citationsDiagnostics.doi = doi;
  citationsDiagnostics.semanticScholarPaperId = semanticScholarPaperId;
  citationsDiagnostics.semanticScholarLookup = semanticScholarIdentifier || undefined;
  citationsDiagnostics.openAlex = doi ? "pending" : "skipped (no DOI)";
  citationsDiagnostics.semanticScholar = semanticScholarIdentifier
    ? "pending"
    : "skipped (no Paper ID or DOI)";
  if (!doi && !semanticScholarIdentifier) { return null; }
  const openAlexPromise = doi
    ? fromOpenAlex(doi, 1).then((result) => {
      citationsDiagnostics.openAlex = result ? `ok total=${result.total}` : "empty";
      return result;
    }).catch((error) => {
      // When both sources fail the UI shows "0", which looks exactly like "nobody
      // cites this". Keeping each failure reason here is what makes the
      // difference visible while debugging.
      citationsDiagnostics.openAlex = `error: ${String(error).slice(0, 200)}`;
      ztoolkit.log("[citationsApi] OpenAlex failed", error);
      return null;
    })
    : Promise.resolve(null);
  const semanticScholarPromise = semanticScholarIdentifier
    ? fromSemanticScholar(semanticScholarIdentifier, 1).then((result) => {
      citationsDiagnostics.semanticScholar = result ? `ok total=${result.total}` : "empty";
      return result;
    }).catch((error) => {
      citationsDiagnostics.semanticScholar = `error: ${String(error).slice(0, 200)}`;
      ztoolkit.log("[citationsApi] Semantic Scholar failed", error);
      return null;
    })
    : Promise.resolve(null);
  const [openalex, semanticscholar] = await Promise.all([
    openAlexPromise,
    semanticScholarPromise,
  ]);
  if (!openalex) { return semanticscholar; }
  if (!semanticscholar) { return openalex; }
  return semanticscholar.total > openalex.total ? semanticscholar : openalex;
}

/** Kept for older call sites; new UI should also pass the item's Semantic Scholar Paper ID. */
export async function fetchCitationsByDOI(rawDOI: string): Promise<CitationsResult | null> {
  return fetchCitationsByIdentifiers(rawDOI);
}

/**
 * Fetch a later page, staying with the source the first page chose: the two order
 * results differently, and switching mid-way would scramble or duplicate entries.
 */
export async function fetchCitationsPage(
  rawDOI: string,
  page: number,
  source: CitationsResult["source"],
  openAlexFilter?: string,
  rawSemanticScholarPaperId?: string,
): Promise<CitationsResult | null> {
  const doi = bareDOI(rawDOI);
  const semanticScholarPaperId = String(rawSemanticScholarPaperId || "").trim();
  const semanticScholarIdentifier = semanticScholarPaperId || (doi ? `DOI:${doi}` : "");
  try {
    if (source === "Semantic Scholar") {
      return semanticScholarIdentifier
        ? await fromSemanticScholar(semanticScholarIdentifier, page)
        : null;
    }
    if (!doi) { return null; }
    // The first page already computed the work cluster; reuse the filter instead
    // of resolving it again.
    return openAlexFilter
      ? await fetchOpenAlexPage(openAlexFilter, page)
      : await fromOpenAlex(doi, page);
  } catch (error) {
    ztoolkit.log("[citationsApi] page fetch failed", error);
    return null;
  }
}

/** Lets the settings pane show whether a key is configured. */
export { getSemanticScholarKey };
