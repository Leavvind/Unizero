/**
 * Zotero ↔ paper runtime 的转换适配层。
 *
 * 端口自 ZoMiner `modules/zotero-adapter.js`，行为保持一致。
 *
 * 按 AGENTS.md 的约定，adapter 是 add-on 里唯一直接改动 Zotero 条目的地方；功能模块
 * 只描述"要转换什么"，由这里决定怎么落到附件和标签上。
 *
 * 产物的识别与覆盖已经不再依赖附件标题，见 artifactIdentity.ts。这里的标题常量只剩两个
 * 用途：新建产物时的显示名，以及认领迁移前旧产物时的判据。
 */

import type { ConvertRequest, ExtractedReference, JobResult } from "../runtime-client/contracts";
import {
  adoptArtifact, findArtifacts, isArtifact, markArtifact,
  type ArtifactKind,
} from "./artifactIdentity";
import { libraryScope } from "./libraryScope";

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
    library_scope: libraryScope(attachment.libraryID || 1),
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
 * 一次产物登记所需的上下文。
 *
 * `source` 和 `wasConverted` 都是为了产物标识：前者区分同一条目下由不同 PDF 生成的
 * 同类产物，后者是认领旧产物时唯一的额外证据。
 */
interface ArtifactContext {
  parent: Zotero.Item;
  /** 源 PDF 附件的 key。 */
  source: string;
  /** 本次转换**之前**这个条目就带着 GENERATED_TAG。 */
  wasConverted: boolean;
  /** 多 PDF 时加在产物标题后的来源后缀。 */
  suffix: string;
}

/**
 * 找出迁移前生成、尚未打标签的旧产物。
 *
 * 只在条目此前就被转换过时才认——否则一个恰好叫 "ZoMiner MD" 的附件就是用户自己的
 * 文件，绝不能碰。这是"同名即删除"那条数据丢失路径被堵住的地方。
 */
function legacyArtifacts(
  context: ArtifactContext,
  titles: string[],
  shape: (attachment: Zotero.Item) => boolean,
): Zotero.Item[] {
  if (!context.wasConverted) { return []; }
  const found: Zotero.Item[] = [];
  for (const id of context.parent.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (!attachment || isArtifact(attachment) || !shape(attachment)) { continue; }
    if (titles.includes(attachment.getField("title"))) { found.push(attachment); }
  }
  return found;
}

/**
 * 链接式附件：Zotero 里只存路径，正文留在用户的 Markdown 库里。
 *
 * 这是"活文档"——用户会继续编辑它，所以绝不能覆盖内容，只维护链接。链接已经指向同一个
 * 文件就什么都不做；指向别处的同一份产物是上一次输出路径的残留，删掉重建。
 */
async function attachMarkdown(
  context: ArtifactContext,
  path: string,
): Promise<void> {
  const title = MD_ATTACHMENT_TITLE + context.suffix;
  const legacyTitle = LEGACY_ATTACHMENT_TITLE + context.suffix;
  // Windows 上同一路径可能以 / 或 \ 出现，比较前统一。
  const normalize = (value: string) => String(value || "").replace(/\//g, "\\");

  const candidates = [
    ...findArtifacts(context.parent, "markdown", context.source, title),
    ...legacyArtifacts(context, [title, legacyTitle],
      (attachment) => !!attachment.isLinkedFileAttachment?.()),
  ];

  let current: Zotero.Item | null = null;
  const stale: Zotero.Item[] = [];
  for (const attachment of candidates) {
    const existingPath = await attachment.getFilePathAsync();
    if (!current && existingPath && normalize(existingPath) === normalize(path)) {
      current = attachment;
      continue;
    }
    stale.push(attachment);
  }

  // 指向旧路径的同类产物一律清掉。旧实现只删到第一个路径命中为止，会在输出目录变过的
  // 条目上留下永远清不掉的残链。
  for (const attachment of stale) { await attachment.eraseTx(); }

  if (current) {
    // 可能是刚认出来的旧产物，补上标签和记录，下次就不必再靠标题。
    if (!isArtifact(current)) {
      await adoptArtifact(current, "markdown", context.source);
    }
    return;
  }

  const created = await Zotero.Attachments.linkFromFile({
    file: path,
    parentItemID: context.parent.id,
    title,
    contentType: "text/markdown",
  });
  await markArtifact(created, "markdown", context.source);
  ztoolkit.log(`linked MD attachment: ${path}`);
}

/**
 * 单向快照：把文件复制进 Zotero storage（随 Zotero 同步）。
 * Zotero 里的这份视为只读 —— 每次重新转换都会覆盖刷新。
 */
async function attachImportedCopy(
  context: ArtifactContext,
  kind: ArtifactKind,
  path: string,
  title: string,
  contentType: string,
): Promise<void> {
  const imported = (attachment: Zotero.Item) =>
    !!attachment.isImportedAttachment?.();

  const candidates = [
    ...findArtifacts(context.parent, kind, context.source, title),
    ...legacyArtifacts(context, [title], imported),
  ];
  for (const attachment of candidates) { await attachment.eraseTx(); }

  const created = await Zotero.Attachments.importFromFile({
    file: path,
    parentItemID: context.parent.id,
    title,
    contentType,
  });
  await markArtifact(created, kind, context.source);
  ztoolkit.log(`imported attachment '${title}': ${path}`);
}

/**
 * 把抽取到的参考文献写成 JSON 附件（application/json），供 relations 功能离线读取。
 *
 * 内容是纯抽取工件（raw 引文 + 页码 + DOI/arXiv）；元数据解析由 add-on 的 provider
 * 侧完成，不回写这里。读取端见 src/modules/zomReferences.ts。
 *
 * 计划是让转换 job 直接投递这些数据（见 docs/ROADMAP.md），届时这个附件降级为兼容产物。
 */
async function attachReferences(
  context: ArtifactContext,
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
  // 文件名带上源附件 key：同一条目的多个 PDF 并发转换时不能互相踩临时文件。
  temp.append(
    `unizero-references-${context.parent.libraryID}-` +
    `${context.parent.key}-${context.source}.json`,
  );
  const path = temp.path;

  await Zotero.File.putContentsAsync(path, payload);
  try {
    await attachImportedCopy(
      context, "references", path, title, "application/json",
    );
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
  options: { mdSnapshot: boolean },
): Promise<void> {
  const parent = target.parent;
  if (!parent) { return; }

  // 必须在 addTag 之前读：加完标签再问就永远是 true，这条证据也就没了。认领旧产物时
  // 它是"这份同名附件确实是我们生成的"的唯一佐证。
  const wasConverted = parent.hasTag(GENERATED_TAG);
  parent.addTag(GENERATED_TAG);
  await parent.saveTx();

  const outcome = result || {};
  const context: ArtifactContext = {
    parent,
    source: target.attachment.key,
    wasConverted,
    suffix: target.isSupplement
      ? ` — ${target.attachment.getField("title") || target.attachment.key}`
      : "",
  };

  if (outcome.md_path) {
    await attachMarkdown(context, outcome.md_path);
    if (options.mdSnapshot) {
      try {
        await attachImportedCopy(
          context, "markdown-copy", outcome.md_path,
          MD_COPY_ATTACHMENT_TITLE + context.suffix, "text/markdown",
        );
      } catch (error) {
        ztoolkit.log(`md snapshot attach failed: ${error}`);
      }
    }
  }

  if (outcome.tables_html_path) {
    try {
      await attachImportedCopy(
        context, "tables", outcome.tables_html_path,
        TABLES_ATTACHMENT_TITLE + context.suffix, "text/html",
      );
    } catch (error) {
      ztoolkit.log(`tables attach failed: ${error}`);
    }
  }

  if (Array.isArray(outcome.references) && outcome.references.length) {
    try {
      await attachReferences(
        context, outcome.references, REFS_ATTACHMENT_TITLE + context.suffix,
      );
    } catch (error) {
      ztoolkit.log(`references attach failed: ${error}`);
    }
  }
}
