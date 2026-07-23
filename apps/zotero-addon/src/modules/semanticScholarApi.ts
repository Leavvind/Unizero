/**
 * Semantic Scholar 官方 Academic Graph API 的轻量封装。
 *
 * DOI、S2 paperId 和标题检索都集中走这里，避免业务模块各自拼接网页私有接口，
 * 同时保证用户配置的 API key 不会被漏掉。
 */

import { bareDOI, getSemanticScholarJSON } from "./scholarlyHttp";

export interface SemanticScholarPaper {
  paperId?: string;
  /** 旧 metadata adapter 会临时写入这个兼容字段。 */
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

/** 按任意官方 paper identifier（paperId、DOI:、CorpusId: 等）精确读取论文。 */
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

/** 按 DOI 精确读取一篇 S2 论文。 */
export async function fetchSemanticScholarPaperByDOI(
  rawDOI: string,
  fields: readonly string[] = DEFAULT_FIELDS,
): Promise<SemanticScholarPaper | undefined> {
  const doi = bareDOI(rawDOI);
  if (!doi) { return; }
  return await fetchSemanticScholarPaper(`DOI:${doi}`, fields);
}

/** 用官方 relevance search 返回若干候选，供调用方自行做书目字段交叉评分。 */
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

/** 把 DOI 解析成 Semantic Scholar SHA paperId。 */
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
