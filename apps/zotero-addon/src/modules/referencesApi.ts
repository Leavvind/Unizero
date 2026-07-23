/**
 * DOI 直连参考文献。
 *
 * ZoMiner 那条路要先跑 MinerU 把 PDF 转 Markdown，慢、且只对已经处理过的条目有效。
 * 但绝大多数条目在导入时就带 DOI，出版商本来就把参考文献列表报给了 Crossref /
 * OpenAlex / Semantic Scholar——直接查即可，秒级返回而且自带结构化元数据，
 * 不需要再走 resolve.ts 的逐条模糊匹配。
 *
 * 三个引擎的取舍：
 *   - OpenAlex：`referenced_works` 给的是 OpenAlex ID，可以一次 batch 拉回完整元数据
 *     （标题/作者/年份/期刊/摘要/被引数），一趟到位，所以放第一。
 *   - Crossref：`reference` 字段覆盖广，但内容取决于出版商——有的只有 unstructured
 *     字符串，有的连 DOI 都有。作为主力兜底。
 *   - Semantic Scholar：匿名限流严（~1rps），放最后。
 *
 * 三家都空才回落到 ZoMiner 的 PDF 抽取（见 views.ts 的调用点）。
 */

import {
  MAILTO, getJSON, getSemanticScholarJSONStrict,
  bareDOI, bareOpenAlexID, unInvertAbstract, composeText,
} from "./scholarlyHttp";
import { resolveOpenAlexCluster } from "./openAlexCluster";
import { encodeSemanticScholarPaperIdentifier } from "./semanticScholarApi";

/** OpenAlex 一次 filter 查询能塞的 ID 数上限。 */
const OPENALEX_BATCH = 50;

/** 最近一次查询里三家各自的下场。参考文献偏少时，用它区分“本来就少”和“某家挂了”。 */
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
  /** 命中的引擎，用于在侧栏 source 标记和提示里显示。 */
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
    type: work?.type === "preprint" ? "preprint" : "journalArticle",
    source: "OpenAlex",
  };
  info.text = composeText(info);
  return info;
}

const OPENALEX_SELECT = "id,doi,display_name,authorships,publication_year,primary_location," +
  "abstract_inverted_index,cited_by_count,type";

/**
 * OpenAlex：先取 referenced_works（只是 ID 列表），再分批把元数据拉回来。
 * batch 请求之间保持顺序，好让侧栏里的参考文献编号和原文大致对得上。
 *
 * 两个坑，都是实测踩出来的：
 *   1. 条目 DOI 指向的记录不一定是参考文献最全的那条（预印本 23 条 vs 发表版 185 条），
 *      所以先把记录簇找齐，取 `referenced_works_count` 最大的那条。
 *   2. `filter=openalex:` 批量查不会跟随合并重定向——被合并掉的 ID 直接不返回。
 *      同一批 23 个 ID 只回来 19 条，剩下 4 条得单独取。
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

  // 按 ID 建索引，好把乱序返回的结果还原成 referenced_works 的原始顺序。
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
  // 批量查漏掉的逐条补：单条接口会跟随合并，返回的 id 可能和请求的不同，
  // 所以按请求的 ID 存，顺序才不会乱。
  // 上限 20：正常只漏个位数，漏成片说明是整批请求挂了，那种情况逐条补只会更慢。
  const missing = ids.filter((id) => !byId.has(id)).slice(0, 20);
  for (const id of missing) {
    const single = await getJSON(
      `https://api.openalex.org/works/${id}?select=${OPENALEX_SELECT}&mailto=${MAILTO}`,
      { tag: "referencesApi" },
    );
    if (single?.id) { byId.set(id, single); }
  }
  if (!byId.size) { return null; }
  // 合并重定向会让两个请求 ID 落到同一条 work 上，按最终 id 去重。
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

/** Crossref 的 reference 条目：结构化字段和 unstructured 串都可能出现。 */
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
  // raw 串优先：它是原文里那一行，信息最全；没有才用结构化字段拼。
  info.text = raw || composeText(info);
  if (!info.text && doi) {
    // 出版商只报了 DOI 的条目。先摆个占位串把行撑起来，标记交给 resolve 那一轮换掉。
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
  const fields = "externalIds,title,authors,year,venue,abstract,citationCount,url";
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
        url: refDOI ? `https://doi.org/${refDOI}` : paper.url,
        number: index + 1,
        type: arxiv && !refDOI ? "preprint" : "journalArticle",
        source: "Semantic Scholar",
      };
      info.text = composeText(info);
      return info;
    })
    .filter(Boolean) as ItemBaseInfo[];
  return list.length ? list : null;
}

/**
 * 按条目现有标识符取参考文献。DOI 交给三家，Paper ID 交给 Semantic Scholar；
 * 两者并存时 S2 优先走更精确的 Paper ID。多家有结果时，**条数最多的胜出**。
 *
 * 以前是“第一个非空结果胜出”，OpenAlex 在最前面，于是它给多少就是多少——实测
 * 10.2139/ssrn.3086063 这样只有 19 条，而 Semantic Scholar 有 140 条。参考文献
 * 只会漏不会凭空多，所以条数多的那家覆盖更全，没有理由让顺序决定结果。
 *
 * 代价是三家都要等，而不是命中第一家就返回。但三家并发，慢的那一家决定总时长，
 * 通常也就多一两秒，换来的是不会莫名其妙少一大半。
 *
 * 全空返回 null——调用方据此回落到 ZoMiner 的 PDF 抽取。
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
  // 严格大于才换家：条数打平时保持 OpenAlex → Crossref → Semantic Scholar 的偏好，
  // 前面的元数据更结构化，后面 resolve 那轮要补的东西更少。
  let best: ReferencesResult | null = null;
  for (const result of results) {
    if (result && (!best || result.references.length > best.references.length)) { best = result; }
  }
  referencesDiagnostics.chosen = best ? `${best.source} (${best.references.length})` : "none";
  return best;
}

/** 兼容旧调用点；新 UI 应把条目上的 Semantic Scholar Paper ID 一并传入。 */
export async function fetchReferencesByDOI(rawDOI: string): Promise<ReferencesResult | null> {
  return fetchReferencesByIdentifiers(rawDOI);
}
