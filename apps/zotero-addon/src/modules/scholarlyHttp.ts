/**
 * 学术 API 的共用 HTTP 层。
 *
 * 存在的理由有两个：
 *   1. Semantic Scholar 的 key 必须走 `x-api-key` 请求头。匿名请求共用公共配额，key 的
 *      具体额度则取决于账户——所以凡是打 S2 的地方都得走同一个入口，漏一处就等于没配。
 *   2. Crossref / OpenAlex 的 polite pool 要求带联系方式，同样得统一附上。
 */

import { config } from "../../package.json";

/** Crossref / OpenAlex 的 polite pool 联系方式。 */
export const MAILTO = config.contactEmail;

/** 用户在设置里填的 Semantic Scholar key；没填就返回空串，调用方据此走匿名路径。 */
export function getSemanticScholarKey(): string {
  return String(Zotero.Prefs.get(`${config.addonRef}.semanticScholar.apiKey`) || "").trim();
}

/**
 * S2 的入门 key 当前按 1 RPS 发放。所有业务模块共用同一条队列，避免“补全信息”刚结束，
 * References 紧接着又发一枪而得到 429。只限制请求开始时间，慢请求不会把后续请求永久堵住。
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
  // 前一轮即使意外失败也不能让整条队列永久 rejected。
  semanticScholarGate = turn.catch(() => undefined);
  await turn;
}

/** 统一的 GET JSON。失败一律返回 undefined，让调用方走各自的兜底而不是炸掉整个面板。 */
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

/**
 * 打 Semantic Scholar 的严格版本：HTTP 失败会抛给调用方，References/Citations 才能把
 * “429 / 网络失败”和“请求成功但确实是空列表”区分开。
 */
export async function getSemanticScholarJSONStrict(url: string, tag?: string): Promise<any> {
  await waitForSemanticScholarTurn();
  const key = getSemanticScholarKey();
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
    ztoolkit.log(`[${tag || "semanticscholar"}] request failed`, url, error);
    throw error;
  }
}

/** 元数据搜索允许失败后继续走 Crossref，所以保留软失败版本。 */
export async function getSemanticScholarJSON(url: string, tag?: string): Promise<any | undefined> {
  try {
    return await getSemanticScholarJSONStrict(url, tag);
  } catch {
    return undefined;
  }
}

/** 剥掉 doi.org 前缀，统一成裸 DOI。 */
export function bareDOI(doi: string): string {
  return String(doi || "")
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .trim();
}

/** OpenAlex 摘要是倒排索引 {word: [positions]}，还原成正文。 */
export function unInvertAbstract(index?: Record<string, number[]>): string | undefined {
  if (!index) { return undefined; }
  const slots: string[] = [];
  for (const word in index) {
    for (const position of index[word]) { slots[position] = word; }
  }
  const text = slots.join(" ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** 没有 raw 引文串时，用结构化字段拼一条给列表显示。 */
export function composeText(info: Partial<ItemBaseInfo>): string {
  return [
    info.authors?.length ? info.authors.slice(0, 3).join(", ") : undefined,
    info.year,
    info.title,
    info.primaryVenue,
  ].filter(Boolean).join(". ");
}

/** 把 OpenAlex 的完整 URL 形式 ID（https://openalex.org/W123）剥成裸 ID。 */
export function bareOpenAlexID(id: string): string {
  return String(id || "").replace(/^https?:\/\/openalex\.org\//i, "");
}
