/**
 * The cluster of OpenAlex records describing one paper.
 *
 * OpenAlex does not merge preprints with published versions: an SSRN working paper
 * and the journal version are two separate works, each with its own references and
 * citation count. Measured on "Short- and Long-Horizon Behavioral Factors":
 *
 *   W2779103412  ssrn.3086063   cited 7   references 23
 *   W3010918279  rfs.hhz069     cited 1   references 185
 *
 * Whichever DOI the item carries, you see only that half. So the records for one
 * paper are first gathered by title; citations are then taken as a union and
 * references from whichever record has the most.
 */

import { MAILTO, getJSON, bareOpenAlexID } from "./scholarlyHttp";

export interface OpenAlexWorkStub {
  id: string;
  citedBy: number;
  referencedCount: number;
}

/** Title normalisation: keep only letters and digits. Used to decide "same paper?". */
function normalizeTitle(text: string): string {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const SELECT = "id,display_name,cited_by_count,referenced_works_count";

/**
 * Starting from one DOI, find every OpenAlex work representing the same paper.
 * Returns an empty array when the seed record cannot be found.
 */
export async function resolveOpenAlexCluster(doi: string): Promise<OpenAlexWorkStub[]> {
  const seed = await getJSON(
    `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=${SELECT}&mailto=${MAILTO}`,
    { tag: "openAlexCluster" },
  );
  const seedID = seed?.id ? bareOpenAlexID(seed.id) : "";
  if (!seedID) { return []; }

  const toStub = (work: any): OpenAlexWorkStub => ({
    id: bareOpenAlexID(work.id),
    citedBy: typeof work.cited_by_count === "number" ? work.cited_by_count : 0,
    referencedCount: typeof work.referenced_works_count === "number" ? work.referenced_works_count : 0,
  });

  const cluster: OpenAlexWorkStub[] = [toStub(seed)];
  const seen = new Set<string>([seedID]);
  const title = String(seed.display_name || "").trim();
  if (!title) { return cluster; }

  const target = normalizeTitle(title);
  const page = await getJSON(
    `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(title)}` +
    `&per-page=25&select=${SELECT}&mailto=${MAILTO}`,
    { tag: "openAlexCluster" },
  );
  for (const candidate of page?.results || []) {
    // Only exact title matches count: `title.search` is a full-text search and
    // returns other papers on the same topic (this one has a "Teaching Slides
    // on ..." entry), so anything looser folds someone else's data into the total.
    if (normalizeTitle(candidate?.display_name) !== target) { continue; }
    const id = bareOpenAlexID(candidate?.id || "");
    if (!id || seen.has(id)) { continue; }
    seen.add(id);
    cluster.push(toStub(candidate));
  }
  return cluster;
}
