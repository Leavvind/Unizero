/**
 * Zotero ↔ paper runtime 的转换适配层。
 *
 * 端口自 ZoMiner `modules/zotero-adapter.js`，行为保持一致。
 *
 * 按 AGENTS.md 的约定，adapter 是 add-on 里唯一直接改动 Zotero 条目的地方；功能模块
 * 只描述"要转换什么"，由这里决定怎么落到附件和标签上。
 *
 * 已知债务（Phase 4 处理，现在**刻意不动**）：产物依赖附件标题来识别和覆盖。标题被用户
 * 改过就会退化成重复附件。修它需要 libraryID + itemKey + kind + schema 的显式产物标识，
 * 属于跨 add-on/runtime 的契约变更，不能在行为对齐阶段顺手改。
 */

import type { ConvertRequest, ExtractedReference, JobResult } from "../runtime-client/contracts";
import { getConversionPref } from "../features/conversion/settings";

const GENERATED_TAG = "MD/generated";
const MD_ATTACHMENT_TITLE = "ZoMiner MD";
/** ZoMiner 更早版本用的标题，覆盖旧产物时仍需认得。 */
const LEGACY_ATTACHMENT_TITLE = "Academic MD";
const MD_COPY_ATTACHMENT_TITLE = "ZoMiner MD 副本";
const TABLES_ATTACHMENT_TITLE = "ZoMiner Tables";
const REFS_ATTACHMENT_TITLE = "ZoMiner References";
const REFS_SCHEMA = "zominer.references/1";

export interface ConversionTarget {
  /** 独立 PDF 附件没有父条目。 */
  parent: Zotero.Item | null;
  attachment: Zotero.Item;
  /** 附件在本机的绝对路径，runtime 靠它读文件。 */
  path: string;
  /** 非主 PDF（补充材料）。影响产物标题后缀。 */
  isSupplement: boolean;
}

function pdfAttachments(item: Zotero.Item): Zotero.Item[] {
  const pdfs: Zotero.Item[] = [];
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (attachment && attachment.attachmentContentType === "application/pdf") {
      pdfs.push(attachment);
    }
  }
  return pdfs;
}

/** 主 PDF = Zotero 认定的最佳附件；它不是 PDF 时退回第一个 PDF。 */
async function mainPdfId(
  item: Zotero.Item,
  pdfs: Zotero.Item[],
): Promise<number | null> {
  if (!pdfs.length) { return null; }
  const best = await item.getBestAttachment();
  if (best && best.attachmentContentType === "application/pdf") { return best.id; }
  return pdfs[0].id;
}

/**
 * 把用户选中的条目摊平成待转换的 PDF 列表。
 *
 * 选中父条目时会把它下面所有 PDF 都算上（含补充材料），选中附件时只算那一个。
 * 按 attachment.id 去重：同时选中父条目和它的附件是很常见的操作。
 */
export async function conversionTargets(
  items: Zotero.Item[],
): Promise<ConversionTarget[]> {
  const targets: ConversionTarget[] = [];
  const seen = new Set<number>();

  for (const item of items) {
    if (item.isRegularItem()) {
      const pdfs = pdfAttachments(item);
      const mainId = await mainPdfId(item, pdfs);
      for (const attachment of pdfs) {
        if (seen.has(attachment.id)) { continue; }
        seen.add(attachment.id);
        const path = await attachment.getFilePathAsync();
        if (!path) {
          // 附件记录在、文件不在（没同步下来或被移动过）。
          ztoolkit.log(`attachment file missing: ${attachment.key}`);
          continue;
        }
        targets.push({
          parent: item,
          attachment,
          path,
          isSupplement: attachment.id !== mainId,
        });
      }
    } else if (item.isAttachment()) {
      if (seen.has(item.id) || item.attachmentContentType !== "application/pdf") {
        continue;
      }
      seen.add(item.id);
      const parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
      const path = await item.getFilePathAsync();
      if (!path) {
        ztoolkit.log(`attachment file missing: ${item.key}`);
        continue;
      }
      let supplement = false;
      if (parent) {
        supplement = item.id !== await mainPdfId(parent, pdfAttachments(parent));
      }
      targets.push({ parent, attachment: item, path, isSupplement: supplement });
    }
  }

  return targets;
}

/** 把 Zotero 的元数据摊成 runtime 契约要的形状，供模板做 frontmatter 投影。 */
export function conversionPayload(
  target: ConversionTarget,
  templateId: string,
): ConvertRequest {
  const { parent, attachment } = target;
  const payload: ConvertRequest = {
    pdf_path: target.path,
    attachment_key: attachment.key,
    attachment_title: attachment.getField("title") || "",
    is_supplement: !!target.isSupplement,
    library_id: attachment.libraryID || 1,
    template: templateId || "paper-to-markdown",
  };

  if (!parent) {
    payload.title = attachment.getField("title") || "";
    return payload;
  }

  payload.item_key = parent.key;
  payload.title = parent.getField("title") || "";
  payload.doi = parent.getField("DOI") || "";
  payload.publication = parent.getField("publicationTitle") || "";
  const year = (parent.getField("date") || "").match(/\d{4}/);
  payload.year = year ? year[0] : "";
  payload.authors = parent.getCreators().map((creator) =>
    creator.firstName
      ? `${creator.firstName} ${creator.lastName}`
      : creator.lastName,
  );

  // Better BibTeX 是可选依赖：装了就用它的 citekey，没装就不带这个字段。
  try {
    const key = (Zotero as any).BetterBibTeX?.KeyManager?.get(parent.id);
    if (key && key.citationKey) { payload.citekey = key.citationKey; }
  } catch (error) {
    // BBT 未安装或还没初始化完。
  }

  return payload;
}

/**
 * 链接式附件：Zotero 里只存路径，正文留在用户的 Markdown 库里。
 *
 * 这是"活文档"——用户会继续编辑它，所以绝不能覆盖内容，只维护链接。路径已经指向
 * 同一个文件就直接返回；同标题的旧链接先删再建，避免堆积。
 */
async function attachMarkdown(
  parent: Zotero.Item,
  path: string,
  title: string,
): Promise<void> {
  const legacyTitle = title.replace(MD_ATTACHMENT_TITLE, LEGACY_ATTACHMENT_TITLE);
  // Windows 上同一路径可能以 / 或 \ 出现，比较前统一。
  const normalize = (value: string) => String(value || "").replace(/\//g, "\\");

  for (const id of parent.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (!attachment?.isLinkedFileAttachment?.()) { continue; }
    const existingPath = await attachment.getFilePathAsync();
    if (existingPath && normalize(existingPath) === normalize(path)) { return; }
    const existingTitle = attachment.getField("title");
    if (existingTitle === title || existingTitle === legacyTitle) {
      await attachment.eraseTx();
    }
  }

  await Zotero.Attachments.linkFromFile({
    file: path,
    parentItemID: parent.id,
    title,
    contentType: "text/markdown",
  });
  ztoolkit.log(`linked MD attachment: ${path}`);
}

/**
 * 单向快照：把文件复制进 Zotero storage（随 Zotero 同步），同名旧副本先删。
 * Zotero 里的这份视为只读 —— 每次重新转换都会覆盖刷新。
 */
async function attachImportedCopy(
  parent: Zotero.Item,
  path: string,
  title: string,
  contentType: string,
): Promise<void> {
  for (const id of parent.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (attachment?.isImportedAttachment?.() &&
        attachment.getField("title") === title) {
      await attachment.eraseTx();
    }
  }
  await Zotero.Attachments.importFromFile({
    file: path,
    parentItemID: parent.id,
    title,
    contentType,
  });
  ztoolkit.log(`imported attachment '${title}': ${path}`);
}

/**
 * 把抽取到的参考文献写成 JSON 附件（application/json），供 relations 功能离线读取。
 *
 * 内容是纯抽取工件（raw 引文 + 页码 + DOI/arXiv）；元数据解析由 add-on 的 provider
 * 侧完成，不回写这里。读取端见 src/modules/zomReferences.ts。
 *
 * Phase 4 会让转换 job 直接投递这些数据，届时这个附件降级为兼容产物。
 */
async function attachReferences(
  parent: Zotero.Item,
  references: ExtractedReference[],
  title: string,
): Promise<void> {
  const payload = JSON.stringify({
    schema: REFS_SCHEMA,
    generated_at: new Date().toISOString(),
    count: references.length,
    references,
  }, null, 2);

  const temp = Zotero.getTempDirectory();
  temp.append(`unizero-references-${parent.key}.json`);
  const path = temp.path;

  await Zotero.File.putContentsAsync(path, payload);
  try {
    await attachImportedCopy(parent, path, title, "application/json");
  } finally {
    // 临时文件必须清掉，哪怕导入失败——它带着完整的参考文献内容。
    try {
      await IOUtils.remove(path, { ignoreAbsent: true });
    } catch (error) {
      ztoolkit.log(`temp reference file cleanup failed: ${error}`);
    }
  }
}

/**
 * 转换完成后登记产物。
 *
 * 每类产物都各自 try/catch：表格导出失败不该让已经转换好的 Markdown 也挂不上去。
 */
export async function markConverted(
  target: ConversionTarget,
  result: JobResult | undefined,
): Promise<void> {
  const parent = target.parent;
  if (!parent) { return; }

  parent.addTag(GENERATED_TAG);
  await parent.saveTx();

  const outcome = result || {};
  const suffix = target.isSupplement
    ? ` — ${target.attachment.getField("title") || target.attachment.key}`
    : "";

  if (outcome.md_path) {
    await attachMarkdown(parent, outcome.md_path, MD_ATTACHMENT_TITLE + suffix);
    if (getConversionPref("mdSnapshot")) {
      try {
        await attachImportedCopy(
          parent, outcome.md_path,
          MD_COPY_ATTACHMENT_TITLE + suffix, "text/markdown",
        );
      } catch (error) {
        ztoolkit.log(`md snapshot attach failed: ${error}`);
      }
    }
  }

  if (outcome.tables_html_path) {
    try {
      await attachImportedCopy(
        parent, outcome.tables_html_path,
        TABLES_ATTACHMENT_TITLE + suffix, "text/html",
      );
    } catch (error) {
      ztoolkit.log(`tables attach failed: ${error}`);
    }
  }

  if (Array.isArray(outcome.references) && outcome.references.length) {
    try {
      await attachReferences(
        parent, outcome.references, REFS_ATTACHMENT_TITLE + suffix,
      );
    } catch (error) {
      ztoolkit.log(`references attach failed: ${error}`);
    }
  }
}
