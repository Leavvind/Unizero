/**
 * Shared HTTP layer for the scholarly APIs.
 *
 * It exists for two reasons:
 *   1. A Semantic Scholar key has to travel in the `x-api-key` header. Anonymous
 *      requests share one public quota, while a key's allowance depends on the
 *      account — so every call to S2 must go through one entry point, since a
 *      single miss is the same as not configuring the key at all.
 *   2. Crossref's and OpenAlex's polite pools want contact details, which likewise
 *      have to be attached in one place.
 */

import { config } from "../../package.json";

/** Contact address for the Crossref / OpenAlex polite pools. */
export const MAILTO = config.contactEmail;

/**
 * The Semantic Scholar key from settings; an empty string when unset, which tells
 * callers to take the anonymous path.
 */
export function getSemanticScholarKey(): string {
  return String(Zotero.Prefs.get(`${config.addonRef}.semanticScholar.apiKey`) || "").trim();
}

/**
 * S2's entry-level key is currently issued at 1 RPS. Every feature module shares
 * this one queue, so References cannot fire immediately after metadata enrichment
 * finishes and collect a 429. Only request start times are gated, so a slow
 * request never blocks later ones indefinitely.
 */
const SEMANTIC_SCHOLAR_INTERVAL_MS = 1050;
let semanticScholarGate: Promise<void> = Promise.resolve();
let lastSemanticScholarRequestAt = 0;

async function waitForSemanticScholarTurn(): Promise<void> {
  const turn = semanticScholarGate.then(async () => {
    const remaining = SEMANTIC_SCHOLAR_INTERVAL_MS - (Date.now() - lastSemanticScholarRequestAt);
    if (remaining > 0) { await Zotero.Promise.delay(remaining); }
    lastSemanticScholarRequestAt = Date.now();
  });
  // An unexpected failure in the previous turn must not leave the whole queue
  // permanently rejected.
  semanticScholarGate = turn.catch(() => undefined);
  await turn;
}

/**
 * The common GET-JSON helper. Any failure returns undefined so callers can take
 * their own fallback instead of blowing up the whole pane.
 */
export async function getJSON(
  url: string,
  options: { headers?: Record<string, string>; tag?: string } = {},
): Promise<any | undefined> {
  try {
    const res = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      headers: options.headers,
    });
    return res?.status === 200 ? res.response : undefined;
  } catch (error) {
    ztoolkit.log(`[${options.tag || "http"}] request failed`, url, error);
    return undefined;
  }
}

/** Total attempts (one initial + retries) for a throttled or flaky S2 request. */
const SEMANTIC_SCHOLAR_MAX_ATTEMPTS = 3;

/** Pull the HTTP status out of whatever shape the request layer threw. */
function httpErrorStatus(error: any): number {
  return Number(error?.status ?? error?.xmlhttp?.status ?? 0) || 0;
}

/** Honour a Retry-After header when S2 sends one, capped so a bad value can't stall. */
function retryAfterMs(error: any): number | undefined {
  const header = error?.xmlhttp?.getResponseHeader?.("Retry-After");
  if (!header) { return undefined; }
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0) * 1000, 15_000) : undefined;
}

/**
 * The strict variant for Semantic Scholar: HTTP failures are thrown to the caller,
 * which is what lets References and Citations tell "429 or network failure" apart
 * from "the request succeeded and the list really is empty".
 *
 * S2's public quota is one shared bucket, so a 429 is common and usually transient —
 * a competing app drained the second's allowance. Rather than surfacing that to the
 * user as "Could not load", a 429 (or a transient 5xx) is retried with backoff, each
 * attempt still passing through the 1 RPS gate. Only a non-retriable status (404,
 * malformed request) or the last attempt actually throws.
 */
export async function getSemanticScholarJSONStrict(url: string, tag?: string): Promise<any> {
  const key = getSemanticScholarKey();
  let lastError: any;
  for (let attempt = 1; attempt <= SEMANTIC_SCHOLAR_MAX_ATTEMPTS; attempt++) {
    await waitForSemanticScholarTurn();
    try {
      const res = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        headers: key ? { "x-api-key": key } : undefined,
      });
      if (res?.status !== 200) {
        throw new Error(`Semantic Scholar HTTP ${res?.status || "unknown"}`);
      }
      return res.response;
    } catch (error) {
      lastError = error;
      const status = httpErrorStatus(error);
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable || attempt === SEMANTIC_SCHOLAR_MAX_ATTEMPTS) {
        ztoolkit.log(`[${tag || "semanticscholar"}] request failed`, url, error);
        throw error;
      }
      const backoff = retryAfterMs(error) ??
        SEMANTIC_SCHOLAR_INTERVAL_MS * Math.pow(2, attempt - 1);
      ztoolkit.log(
        `[${tag || "semanticscholar"}] HTTP ${status}, retry ${attempt}/` +
        `${SEMANTIC_SCHOLAR_MAX_ATTEMPTS - 1} in ${backoff}ms`,
        url,
      );
      await Zotero.Promise.delay(backoff);
    }
  }
  throw lastError;
}

/** Metadata search may fail and fall through to Crossref, so the soft variant stays. */
export async function getSemanticScholarJSON(url: string, tag?: string): Promise<any | undefined> {
  try {
    return await getSemanticScholarJSONStrict(url, tag);
  } catch {
    return undefined;
  }
}

/** Strip any doi.org prefix down to a bare DOI. */
export function bareDOI(doi: string): string {
  return String(doi || "")
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .trim();
}

/** OpenAlex abstracts are an inverted index {word: [positions]}; restore the prose. */
export function unInvertAbstract(index?: Record<string, number[]>): string | undefined {
  if (!index) { return undefined; }
  const slots: string[] = [];
  for (const word in index) {
    for (const position of index[word]) { slots[position] = word; }
  }
  const text = slots.join(" ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** With no raw citation string, build one from structured fields for the list. */
export function composeText(info: Partial<ItemBaseInfo>): string {
  return [
    info.authors?.length ? info.authors.slice(0, 3).join(", ") : undefined,
    info.year,
    info.title,
    info.primaryVenue,
  ].filter(Boolean).join(". ");
}

/** Strip OpenAlex's full URL id form (https://openalex.org/W123) to a bare id. */
export function bareOpenAlexID(id: string): string {
  return String(id || "").replace(/^https?:\/\/openalex\.org\//i, "");
}
