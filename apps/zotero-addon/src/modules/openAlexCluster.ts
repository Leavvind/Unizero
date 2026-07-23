/**
 * OpenAlex 里同一篇论文的“记录簇”。
 *
 * OpenAlex 不合并预印本和发表版：SSRN 工作论文和期刊发表版是两条独立 work，
 * 参考文献和被引数各算各的。实测 Short- and Long-Horizon Behavioral Factors：
 *
 *   W2779103412  ssrn.3086063   被引 7   参考文献 23
 *   W3010918279  rfs.hhz069     被引 1   参考文献 185
 *
 * 条目上挂的是哪个 DOI，就只能看到那一半。所以先按标题把同一篇的记录找齐，
 * 被引取并集、参考文献取最全的那条。
 */

import { MAILTO, getJSON, bareOpenAlexID } from "./scholarlyHttp";

export interface OpenAlexWorkStub {
  id: string;
  citedBy: number;
  referencedCount: number;
}

/** 标题归一化：只留字母数字。用于判定“是不是同一篇”。 */
function normalizeTitle(text: string): string {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const SELECT = "id,display_name,cited_by_count,referenced_works_count";

/**
 * 从一个 DOI 出发，找出 OpenAlex 里代表同一篇论文的所有 work。
 * 找不到种子记录时返回空数组。
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
    // 只认标题完全一致的：`title.search` 是全文检索，会带回同主题的别篇论文
    // （这篇就有一条 “Teaching Slides on ...”），松一点就会把别人的数据算进来。
    if (normalizeTitle(candidate?.display_name) !== target) { continue; }
    const id = bareOpenAlexID(candidate?.id || "");
    if (!id || seen.has(id)) { continue; }
    seen.add(id);
    cluster.push(toStub(candidate));
  }
  return cluster;
}
