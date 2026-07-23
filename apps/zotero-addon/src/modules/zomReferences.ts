/**
 * ZoMiner 桥接。
 *
 * 参考文献抽取已外包给 ZoMiner：它用 MinerU 把 PDF 转成 Markdown，在 `markdown-cleanup`
 * 删除参考文献段之前，从 content_list 抽取结构化参考文献，并把结果作为一个 `application/json`
 * 附件（标题以 “ZoMiner References” 开头）挂在 Zotero 条目下。
 *
 * 本模块只负责“读取那个附件”。它是纯抽取工件（raw 引文 + 页码 + DOI/arXiv）；
 * 标题/作者/期刊/年份/摘要等元数据解析由 add-on 侧完成（Crossref/OpenAlex/LLM）。
 *
 * 这是当前唯一的跨插件耦合点。附件的 JSON 契约（`schema: "zominer.references/N"`）是
 * UniZero Phase 4 要替换成直接投递的数据边界；在那之前这个读取路径必须保持可用，
 * 见 docs/MIGRATION.md。
 */

const REFS_ATTACHMENT_TITLE = "ZoMiner References";

/** ZoMiner 附件里单条参考文献的形状。 */
export interface ZoMinerReference {
  index: number;
  raw: string;
  page?: number;
  identifiers?: { doi?: string; arxiv?: string };
}

/** 在条目（或其父条目）下定位 ZoMiner 参考文献 JSON 附件。 */
export function findReferencesAttachment(item: Zotero.Item): Zotero.Item | null {
  if (!item) { return null; }
  const parent = (item.isAttachment?.() && item.parentItem) ? item.parentItem : item;
  for (const id of parent.getAttachments()) {
    const attachment = Zotero.Items.get(id) as Zotero.Item;
    if (!attachment) { continue; }
    const title = String(attachment.getField("title") || "");
    const contentType = (attachment as any).attachmentContentType;
    if (contentType === "application/json" && title.startsWith(REFS_ATTACHMENT_TITLE)) {
      return attachment;
    }
  }
  return null;
}

/**
 * 读取并解析 ZoMiner 参考文献附件，映射成侧栏使用的 ItemBaseInfo 列表。
 * 无附件时返回 null（表示该条目尚未经 ZoMiner 抽取），交给上层决定回退行为。
 */
export async function readZoMinerReferences(item: Zotero.Item): Promise<ItemBaseInfo[] | null> {
  const attachment = findReferencesAttachment(item);
  if (!attachment) { return null; }
  let path: string | false;
  try {
    path = await (attachment as any).getFilePathAsync();
  } catch (error) {
    ztoolkit.log("ZoMiner references: getFilePathAsync failed", error);
    return null;
  }
  if (!path) { return null; }
  let text: string;
  try {
    text = (await Zotero.File.getContentsAsync(path)) as string;
  } catch (error) {
    ztoolkit.log("ZoMiner references: read failed", error);
    return null;
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (error) {
    ztoolkit.log("ZoMiner references: parse failed", error);
    return null;
  }
  const references = Array.isArray(data?.references) ? data.references : [];
  return references
    .filter((reference: ZoMinerReference) => reference && reference.raw)
    .map((reference: ZoMinerReference) => zomRefToInfo(reference));
}

/** 把 ZoMiner 的一条 raw 引文映射成 ItemBaseInfo（标题/作者留待上层解析补全）。 */
function zomRefToInfo(reference: ZoMinerReference): ItemBaseInfo {
  const identifiers: ItemBaseInfo["identifiers"] = {};
  if (reference.identifiers?.doi) { identifiers.DOI = reference.identifiers.doi; }
  if (reference.identifiers?.arxiv) { identifiers.arXiv = reference.identifiers.arxiv; }
  return {
    identifiers,
    title: "",
    authors: [],
    text: reference.raw,
    number: reference.index,
    type: identifiers.arXiv ? "preprint" : "journalArticle",
    source: "ZoMiner",
  };
}
