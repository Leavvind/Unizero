/**
 * 引用本文的论文（Citations）。
 *
 * 与 referencesApi 是同一枚硬币的两面：那边问“这篇文章引了谁”，这边问“谁引了这篇文章”。
 *
 * 为什么不能像 references 那样“第一个非空结果胜出”——两个坑，都是实测踩出来的：
 *
 *   1. **OpenAlex 会把同一篇论文拆成多条 work。** 例：Short- and Long-Horizon Behavioral
 *      Factors 在 OpenAlex 里既有 SSRN 工作论文版（W2779103412，被引 7），又有 RFS 发表版
 *      （W3010918279，被引 1）。条目上挂的是哪个 DOI，就只能看到那一半，于是面板显示
 *      “1 篇引用”。解决办法是按标题把重复 work 找齐，用 `cites:W1|W2` 求并集。
 *
 *   2. **两家的覆盖率差距可以是数量级的。** 同一篇论文 OpenAlex 并集后是 8，Semantic
 *      Scholar 是 287。谁多谁对（引用只会漏不会凭空多），所以两家都查，取多的那个，
 *      而不是谁先返回用谁。
 *
 * 引用可能上千，全拉既慢又没意义；按被引数降序分页取，默认第一页就是“最重要的 N 篇”。
 */

import {
  MAILTO, getJSON, getSemanticScholarJSONStrict, getSemanticScholarKey,
  bareDOI, unInvertAbstract, composeText,
} from "./scholarlyHttp";
import { resolveOpenAlexCluster } from "./openAlexCluster";
import { encodeSemanticScholarPaperIdentifier } from "./semanticScholarApi";

/** 最近一次查询里两家各自的下场。UI 上 “0 篇引用” 分不出是没人引用还是两家都挂了。 */
export const citationsDiagnostics: {
  doi?: string;
  semanticScholarPaperId?: string;
  semanticScholarLookup?: string;
  openAlex?: string;
  semanticScholar?: string;
} = {};

/** 每页条数。按被引数降序，所以第一页是“最重要的 N 篇”而不是随机 N 篇。 */
export const CITATIONS_PAGE_SIZE = 50;

export interface CitationsResult {
  citations: ItemBaseInfo[];
  /** 总被引数，通常远大于 citations.length。 */
  total: number;
  source: "OpenAlex" | "Semantic Scholar";
  /** 还有没有下一页，供 UI 决定是否显示“加载更多”。 */
  hasMore: boolean;
  /** 供翻页复用，省掉再解析一次 DOI→work ID。 */
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
  // 预印本/发表版是各自独立的 work，被引数分开算，得求并集。见 openAlexCluster.ts。
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
 * 取第一页引用。有 DOI 时两家都查；只有 Paper ID 时仍可查 S2。取**总数更大**的
 * 那家——引用只会漏不会凭空多，所以数大的那家覆盖更全。
 * 两家都空返回 null。
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
      // 两家都失败时 UI 只会显示 “0”，和“真的没人引用”长得一模一样。
      // 把各自的失败原因留在这儿，排查时才有得看。
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

/** 兼容旧调用点；新 UI 应把条目上的 Semantic Scholar Paper ID 一并传入。 */
export async function fetchCitationsByDOI(rawDOI: string): Promise<CitationsResult | null> {
  return fetchCitationsByIdentifiers(rawDOI);
}

/** 取后续页。沿用第一页选定的引擎，避免两家排序不同导致翻页时条目错乱或重复。 */
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
    // 第一页已经算过 work 簇，直接复用 filter，不用再解析一遍。
    return openAlexFilter
      ? await fetchOpenAlexPage(openAlexFilter, page)
      : await fromOpenAlex(doi, page);
  } catch (error) {
    ztoolkit.log("[citationsApi] page fetch failed", error);
    return null;
  }
}

/** 供设置页显示“key 已配置”状态。 */
export { getSemanticScholarKey };
