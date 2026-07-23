/**
 * ZoMiner bridge.
 *
 * Reference extraction is delegated to ZoMiner: it converts the PDF to Markdown
 * with MinerU and, before `markdown-cleanup` strips the reference section, pulls
 * structured references out of content_list and attaches the result to the Zotero
 * item as an `application/json` attachment whose title starts with
 * "ZoMiner References".
 *
 * This module only reads that attachment. Its content is a pure extraction
 * artifact (raw citation + page + DOI/arXiv); resolving title, authors, venue,
 * year, and abstract happens on the add-on side (Crossref/OpenAlex/LLM).
 *
 * The attachment's JSON contract (`schema: "zominer.references/N"`) is still what
 * conversion writes, which makes this the **only** route by which extraction
 * results reach the add-on. The plan is for the conversion job to return
 * references directly; until then this read path must keep working. See
 * docs/LEGACY_SUPPORT.md.
 */

const REFS_ATTACHMENT_TITLE = "ZoMiner References";

/** Shape of a single reference inside the ZoMiner attachment. */
export interface ZoMinerReference {
  index: number;
  raw: string;
  page?: number;
  identifiers?: { doi?: string; arxiv?: string };
}

/** Locate the ZoMiner references JSON attachment under an item or its parent. */
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
 * Read and parse the ZoMiner references attachment into the ItemBaseInfo list the
 * sidebar uses. Returns null when there is no attachment — meaning this item has
 * not been through ZoMiner extraction — and leaves the fallback to the caller.
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

/** Map one raw ZoMiner citation to ItemBaseInfo; title and authors are resolved later. */
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
