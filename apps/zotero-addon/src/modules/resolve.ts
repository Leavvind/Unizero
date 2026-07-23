/**
 * 元数据解析层：raw 引文字符串 → 结构化元数据。
 *
 * ZoMiner 只负责从 PDF 抽出干净的 raw 引文串（见 zomReferences.ts），本模块负责把它
 * 对上真实文献，补出 DOI / 标题 / 作者 / 期刊 / 年份 / 摘要 / 被引数。
 *
 * 为什么必须有这一层：实测这批金融/会计论文的参考文献里**一条 DOI 都没有**（期刊传统是
 * “刊名+卷+页”不印 DOI），而侧栏的悬浮窗补全和 “+” 导入按钮都以 identifiers.DOI 为前提。
 * 所以没有这层，信息展示和入库全都做不了。
 *
 * 引擎顺序：
 *   1. Crossref `query.bibliographic` —— 专为“整条引文串”匹配设计，命中率最高，
 *      且 `is-referenced-by-count` 顺带给出被引数。
 *   2. OpenAlex —— 兜底匹配；同时是摘要的主要来源（Crossref 摘要覆盖率很低）。
 * LLM 兜底按既定架构预留，本轮不实现。
 */

/** 解析结果。字段命名对齐 ItemInfo，便于直接并入侧栏的数据结构。 */
export interface ResolvedInfo {
  identifiers: { DOI?: string; arXiv?: string };
  title?: string;
  authors?: string[];
  year?: string;
  primaryVenue?: string;
  abstract?: string;
  /** 被引次数，供悬浮窗显示 “Cited N times”。 */
  citations?: number;
  url?: string;
  /** 命中的引擎，用于在 UI 上标注来源。 */
  source?: string;
  /** 标题与 raw 串的匹配度 0~1，低于阈值的结果会被丢弃。 */
  score?: number;
  /**
   * 分数低于 MIN_SCORE 的猜测。这种结果只能拿来展示，绝不能进入导入路径——
   * 调用方必须据此拒绝写入 identifiers，否则 “+” 会把一篇错的论文导进文库。
   */
  lowConfidence?: boolean;
}

/** Crossref / OpenAlex 的 polite pool 都建议带联系方式，能显著降低被限流的概率。 */
import { MAILTO } from "./scholarlyHttp";
/** 标题匹配度低于此值视为误匹配，宁可不给也不给错的。 */
const MIN_SCORE = 0.55;

const memo = new Map<string, ResolvedInfo | null>();

/**
 * 可重试的传输失败：网络不通、429、5xx。
 *
 * 必须和“查通了但没有结果”严格区分开。以前两者都被压成 undefined，于是一次限流
 * 和“这条确实查无此文”在上层看起来一模一样，被当成解析完成写进缓存——重启后磁盘
 * 缓存又挡住重试，一次网络抖动就永久留疤。
 */
export class RetryableResolveError extends Error {}

async function getJSON(url: string): Promise<any | undefined> {
  try {
    // 404 是有效答案（“没有这条记录”），交给下面按空结果处理，不要当异常。
    const res = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      successCodes: [200, 404],
    });
    return res?.status === 200 ? res.response : undefined;
  } catch (error: any) {
    const status = error?.status ?? error?.xmlhttp?.status;
    ztoolkit.log("[resolve] request failed", url, status, error);
    // 没有状态码 = 网络层就没打通；429/5xx = 对方让我们过会儿再来。都属于可重试。
    if (!status || status === 429 || status >= 500) {
      throw new RetryableResolveError(`${url} failed (${status || "network error"})`);
    }
    // 其余 4xx 是请求本身的问题，重试也没用，按空结果处理。
    return undefined;
  }
}

/** 归一化成可比较的词序列：小写、去标点、去掉过短的虚词。 */
function tokens(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 2);
}

/**
 * 标题落在 raw 引文串里的比例。用“标题词有多少出现在 raw 中”而不是双向相似度，
 * 因为 raw 串里还含作者/期刊/卷页等额外信息，双向比较会被稀释。
 */
function matchScore(raw: string, title?: string): number {
  if (!title) { return 0; }
  const titleTokens = tokens(title);
  if (!titleTokens.length) { return 0; }
  const rawSet = new Set(tokens(raw));
  const hit = titleTokens.filter((word) => rawSet.has(word)).length;
  return hit / titleTokens.length;
}

/** Crossref 摘要是 JATS XML 片段，去掉标签取纯文本。 */
function stripJats(abstract?: string): string | undefined {
  if (!abstract) { return undefined; }
  const text = abstract.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** OpenAlex 摘要是倒排索引 {word: [positions]}，需要还原成正文。 */
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
  // OpenAlex 的 doi 是完整 URL，统一剥成裸 DOI。
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

/** 已知 DOI：直接取权威记录，并用 OpenAlex 补摘要/被引数。 */
async function byDOI(doi: string): Promise<ResolvedInfo | null> {
  const crossref = fromCrossref(
    await getJSON(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`)
      .then((r) => r?.message),
  );
  const openalex = fromOpenAlex(
    await getJSON(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${MAILTO}`),
  );
  if (!crossref && !openalex) { return null; }
  // 以 Crossref 为主体（书目字段更规范），用 OpenAlex 填补它缺的摘要和被引数。
  const merged: ResolvedInfo = { ...(openalex || {}), ...(crossref || {}) } as ResolvedInfo;
  merged.abstract = crossref?.abstract || openalex?.abstract;
  merged.citations = crossref?.citations ?? openalex?.citations;
  merged.identifiers = { DOI: doi };
  merged.score = 1;
  merged.source = crossref && openalex ? "Crossref+OpenAlex" : (crossref ? "Crossref" : "OpenAlex");
  return merged;
}

/** 未知 DOI：拿整条 raw 引文串去匹配。 */
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
    // 命中且够像：再用 OpenAlex 补摘要（Crossref 摘要覆盖率很低）。
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

  // Crossref 没命中或匹配度不足，换 OpenAlex 再试一次。
  const openalex = fromOpenAlex(
    await getJSON(
      `https://api.openalex.org/works?search=${query}&per-page=1&mailto=${MAILTO}`,
    ).then((r) => r?.results?.[0]),
  );
  if (openalex) {
    openalex.score = matchScore(raw, openalex.title);
    if (openalex.score >= MIN_SCORE) { return openalex; }
  }

  // 两边都不够像：返回分数较高的那个，但打上 lowConfidence。上层只能拿它做展示，
  // 不得据此写入 identifiers——否则 MIN_SCORE 这道闸门形同虚设。
  const best = [crossref, openalex].filter(Boolean).sort(
    (a, b) => (b!.score || 0) - (a!.score || 0),
  )[0];
  return best && (best.score || 0) > 0
    ? { ...best, source: `${best.source}?`, lowConfidence: true }
    : null;
}

/** 解析单条引文：有 DOI 走权威查询，没有就用 raw 串匹配。结果做内存缓存。 */
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
    // 传输失败不缓存，也不冒充“查无此文”——原样抛给上层，由它决定这一轮不算完成。
    if (error instanceof RetryableResolveError) { throw error; }
  }
  memo.set(key, result);
  return result;
}

/**
 * 批量解析。用固定并发的工作池而不是 Promise.all，避免一次性打出上百个请求被限流
 * （Crossref/OpenAlex 对突发流量都会 429）。每解析完一条就回调，让 UI 能逐条更新，
 * 而不是等全部结束才刷新。
 */
export async function resolveMany(
  items: { raw: string; identifiers?: { DOI?: string; arXiv?: string } }[],
  onResolved: (index: number, info: ResolvedInfo | null) => void,
  concurrency: number = 4,
): Promise<{ failed: number }> {
  let cursor = 0;
  // 传输失败的条数。只要不为 0，这批就不算解析完成，缓存不能标 resolved。
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
