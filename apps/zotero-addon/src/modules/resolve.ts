/**
 * Metadata resolution layer: raw citation string → structured metadata.
 *
 * ZoMiner only extracts clean raw citation strings from the PDF (see
 * zomReferences.ts); this module matches them against real publications and fills
 * in DOI, title, authors, venue, year, abstract, and citation count.
 *
 * Why the layer is necessary: in practice, the references of this body of
 * finance/accounting papers contain **no DOIs at all** — the journals' convention
 * is "title + volume + pages" without a DOI — while the sidebar's tooltip
 * enrichment and its "+" import button both require identifiers.DOI. Without this
 * layer, neither display nor import works.
 *
 * Engine order:
 *   1. Crossref `query.bibliographic` — built for matching a whole citation string,
 *      with the highest hit rate, and `is-referenced-by-count` supplies the
 *      citation count for free.
 *   2. OpenAlex — the fallback matcher, and also the main source of abstracts,
 *      since Crossref's abstract coverage is poor.
 * An LLM fallback is reserved by the agreed architecture but not implemented here.
 */

/** A resolution result. Field names follow ItemInfo so it merges straight into the sidebar's data. */
export interface ResolvedInfo {
  identifiers: { DOI?: string; arXiv?: string };
  title?: string;
  authors?: string[];
  year?: string;
  primaryVenue?: string;
  abstract?: string;
  /** Citation count, shown in the tooltip as "Cited N times". */
  citations?: number;
  url?: string;
  /** Which engine matched, so the UI can label the source. */
  source?: string;
  /** Title-to-raw match score in 0..1; results below the threshold are discarded. */
  score?: number;
  /**
   * A guess scoring below MIN_SCORE. Such a result may only be displayed and must
   * never reach the import path — the caller has to refuse to write identifiers
   * from it, or "+" will import the wrong paper into the library.
   */
  lowConfidence?: boolean;
}

/** Both polite pools recommend a contact address, which markedly lowers the chance of throttling. */
import { MAILTO } from "./scholarlyHttp";
/** Below this title match score the result counts as a mismatch: better nothing than wrong. */
const MIN_SCORE = 0.55;

const memo = new Map<string, ResolvedInfo | null>();

/**
 * A retryable transport failure: no network, 429, or 5xx.
 *
 * It must be kept strictly apart from "the query went through and found nothing".
 * Both used to collapse into undefined, so one throttled request looked exactly
 * like a genuine no-such-paper to the layer above, counted as resolved, and was
 * written to the cache — after which the on-disk cache blocked the retry and a
 * single network hiccup left a permanent scar.
 */
export class RetryableResolveError extends Error {}

async function getJSON(url: string): Promise<any | undefined> {
  try {
    // A 404 is a valid answer ("no such record"): handled below as an empty
    // result, not as an exception.
    const res = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      successCodes: [200, 404],
    });
    return res?.status === 200 ? res.response : undefined;
  } catch (error: any) {
    const status = error?.status ?? error?.xmlhttp?.status;
    ztoolkit.log("[resolve] request failed", url, status, error);
    // No status code means the network layer never connected; 429/5xx means the
    // other side asked us to come back later. Both are retryable.
    if (!status || status === 429 || status >= 500) {
      throw new RetryableResolveError(`${url} failed (${status || "network error"})`);
    }
    // Any other 4xx is a problem with the request itself; retrying will not help,
    // so treat it as an empty result.
    return undefined;
  }
}

/** Normalise to a comparable token sequence: lowercase, strip punctuation, drop short stopwords. */
function tokens(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 2);
}

/**
 * The fraction of the title found inside the raw citation string. This measures
 * how many title tokens appear in the raw string rather than a two-way similarity,
 * because the raw string also carries authors, venue, volume, and pages, which
 * would dilute a symmetric comparison.
 */
function matchScore(raw: string, title?: string): number {
  if (!title) { return 0; }
  const titleTokens = tokens(title);
  if (!titleTokens.length) { return 0; }
  const rawSet = new Set(tokens(raw));
  const hit = titleTokens.filter((word) => rawSet.has(word)).length;
  return hit / titleTokens.length;
}

/** Crossref abstracts are JATS XML fragments; strip the tags for plain text. */
function stripJats(abstract?: string): string | undefined {
  if (!abstract) { return undefined; }
  const text = abstract.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** OpenAlex abstracts are an inverted index {word: [positions]}; restore the prose. */
function unInvertAbstract(index?: Record<string, number[]>): string | undefined {
  if (!index) { return undefined; }
  const slots: string[] = [];
  for (const word in index) {
    for (const position of index[word]) { slots[position] = word; }
  }
  const text = slots.join(" ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function fromCrossref(work: any): ResolvedInfo | null {
  if (!work) { return null; }
  const doi = work.DOI ? String(work.DOI) : undefined;
  const title = Array.isArray(work.title) ? work.title[0] : work.title;
  const authors = (work.author || [])
    .map((a: any) => [a.given, a.family].filter(Boolean).join(" ").trim())
    .filter(Boolean);
  const year = work.issued?.["date-parts"]?.[0]?.[0];
  const venue = Array.isArray(work["container-title"])
    ? work["container-title"][0]
    : work["container-title"];
  return {
    identifiers: doi ? { DOI: doi } : {},
    title,
    authors,
    year: year ? String(year) : undefined,
    primaryVenue: venue || undefined,
    abstract: stripJats(work.abstract),
    citations: typeof work["is-referenced-by-count"] === "number"
      ? work["is-referenced-by-count"]
      : undefined,
    url: doi ? `https://doi.org/${doi}` : undefined,
    source: "Crossref",
  };
}

function fromOpenAlex(work: any): ResolvedInfo | null {
  if (!work) { return null; }
  // OpenAlex's doi is a full URL; strip it to a bare DOI.
  const doi = work.doi ? String(work.doi).replace(/^https?:\/\/doi\.org\//i, "") : undefined;
  const authors = (work.authorships || [])
    .map((a: any) => a?.author?.display_name)
    .filter(Boolean);
  return {
    identifiers: doi ? { DOI: doi } : {},
    title: work.display_name || work.title,
    authors,
    year: work.publication_year ? String(work.publication_year) : undefined,
    primaryVenue: work.primary_location?.source?.display_name || undefined,
    abstract: unInvertAbstract(work.abstract_inverted_index),
    citations: typeof work.cited_by_count === "number" ? work.cited_by_count : undefined,
    url: doi ? `https://doi.org/${doi}` : work.id,
    source: "OpenAlex",
  };
}

/** Known DOI: fetch the authoritative record and fill abstract/citations from OpenAlex. */
async function byDOI(doi: string): Promise<ResolvedInfo | null> {
  const crossref = fromCrossref(
    await getJSON(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`)
      .then((r) => r?.message),
  );
  const openalex = fromOpenAlex(
    await getJSON(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${MAILTO}`),
  );
  if (!crossref && !openalex) { return null; }
  // Crossref forms the base, since its bibliographic fields are better
  // standardised; OpenAlex fills in the abstract and citation count it lacks.
  const merged: ResolvedInfo = { ...(openalex || {}), ...(crossref || {}) } as ResolvedInfo;
  merged.abstract = crossref?.abstract || openalex?.abstract;
  merged.citations = crossref?.citations ?? openalex?.citations;
  merged.identifiers = { DOI: doi };
  merged.score = 1;
  merged.source = crossref && openalex ? "Crossref+OpenAlex" : (crossref ? "Crossref" : "OpenAlex");
  return merged;
}

/** Unknown DOI: match on the whole raw citation string. */
async function byRaw(raw: string): Promise<ResolvedInfo | null> {
  const query = encodeURIComponent(raw.slice(0, 500));
  const crossref = fromCrossref(
    await getJSON(
      `https://api.crossref.org/works?query.bibliographic=${query}&rows=1` +
      `&select=DOI,title,author,issued,container-title,abstract,is-referenced-by-count,type` +
      `&mailto=${MAILTO}`,
    ).then((r) => r?.message?.items?.[0]),
  );
  if (crossref) {
    crossref.score = matchScore(raw, crossref.title);
    // A hit that is similar enough: fill the abstract from OpenAlex, since
    // Crossref's abstract coverage is poor.
    if (crossref.score >= MIN_SCORE) {
      if (!crossref.abstract && crossref.identifiers.DOI) {
        const enriched = fromOpenAlex(
          await getJSON(
            `https://api.openalex.org/works/doi:${encodeURIComponent(crossref.identifiers.DOI)}?mailto=${MAILTO}`,
          ),
        );
        crossref.abstract = enriched?.abstract;
        crossref.citations = crossref.citations ?? enriched?.citations;
      }
      return crossref;
    }
  }

  // Crossref missed or scored too low; try OpenAlex instead.
  const openalex = fromOpenAlex(
    await getJSON(
      `https://api.openalex.org/works?search=${query}&per-page=1&mailto=${MAILTO}`,
    ).then((r) => r?.results?.[0]),
  );
  if (openalex) {
    openalex.score = matchScore(raw, openalex.title);
    if (openalex.score >= MIN_SCORE) { return openalex; }
  }

  // Neither is similar enough: return the higher-scoring one but mark it
  // lowConfidence. The caller may only display it and must not write identifiers
  // from it, or the MIN_SCORE gate means nothing.
  const best = [crossref, openalex].filter(Boolean).sort(
    (a, b) => (b!.score || 0) - (a!.score || 0),
  )[0];
  return best && (best.score || 0) > 0
    ? { ...best, source: `${best.source}?`, lowConfidence: true }
    : null;
}

/**
 * Resolve one citation: an authoritative lookup when a DOI is present, otherwise a
 * raw-string match. Results are cached in memory.
 */
export async function resolveOne(
  raw: string,
  identifiers?: { DOI?: string; arXiv?: string },
): Promise<ResolvedInfo | null> {
  const key = identifiers?.DOI ? `doi:${identifiers.DOI}` : `raw:${raw}`;
  if (memo.has(key)) { return memo.get(key)!; }
  let result: ResolvedInfo | null = null;
  try {
    result = identifiers?.DOI ? await byDOI(identifiers.DOI) : await byRaw(raw);
  } catch (error) {
    ztoolkit.log("[resolve] failed", raw.slice(0, 60), error);
    // A transport failure is neither cached nor disguised as "no such paper":
    // rethrow it so the caller can decide this round did not complete.
    if (error instanceof RetryableResolveError) { throw error; }
  }
  memo.set(key, result);
  return result;
}

/**
 * Resolve in bulk. A fixed-concurrency worker pool rather than Promise.all, so a
 * hundred requests do not go out at once and get throttled — both Crossref and
 * OpenAlex answer bursts with 429. Each completed citation invokes the callback,
 * letting the UI update entry by entry instead of waiting for the whole batch.
 */
export async function resolveMany(
  items: { raw: string; identifiers?: { DOI?: string; arXiv?: string } }[],
  onResolved: (index: number, info: ResolvedInfo | null) => void,
  concurrency: number = 4,
): Promise<{ failed: number }> {
  let cursor = 0;
  // Count of transport failures. While it is non-zero the batch is not resolved
  // and the cache must not be marked as such.
  let failed = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      let info: ResolvedInfo | null = null;
      try {
        info = await resolveOne(item.raw, item.identifiers);
      } catch (error) {
        failed += 1;
      }
      try {
        onResolved(index, info);
      } catch (error) {
        ztoolkit.log("[resolve] onResolved callback failed", error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  if (failed) {
    ztoolkit.log(`[resolve] ${failed}/${items.length} entries failed to reach the API`);
  }
  return { failed };
}
