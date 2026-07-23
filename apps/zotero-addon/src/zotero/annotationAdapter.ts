/**
 * Zotero 批注 → paper runtime 的适配层。
 *
 * 端口自 ZoMiner `modules/zotero-adapter.js` 的批注部分，行为保持一致。
 *
 * 当前只支持高亮和下划线，且只投递纯文本——这是 ZoMiner 的既有行为，先对齐再演进。
 * 规范化的批注模型（类型/颜色/标签/位置 + profile 渲染）见 docs/ROADMAP.md。
 */

import type { AnnotateRequest, AnnotationPayloadItem } from "../runtime-client/contracts";

/** runtime 目前只能把这两类批注定位回 Markdown 正文。 */
const SUPPORTED_TYPES = ["highlight", "underline"];

/**
 * 把选中项归一到"文献条目"层面。
 *
 * 批注注入的对象是条目而不是附件：一个条目下多个 PDF 的批注会合并注入到同一份
 * Markdown。选中附件时上溯到父条目，并按条目去重。
 */
export function regularParents(items: Zotero.Item[]): Zotero.Item[] {
  const parents: Zotero.Item[] = [];
  const seen = new Set<number>();

  for (const item of items) {
    const parent = item.isRegularItem()
      ? item
      : item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
    if (parent && parent.isRegularItem() && !seen.has(parent.id)) {
      seen.add(parent.id);
      parents.push(parent);
    }
  }

  return parents;
}

/**
 * 收集一个条目下所有可注入的批注。
 *
 * 按 sortIndex 排序，让注入顺序跟阅读顺序一致——runtime 侧是按顺序匹配正文的，
 * 乱序会显著降低匹配率。
 */
export function annotationPayload(parent: Zotero.Item): AnnotateRequest {
  const annotations: AnnotationPayloadItem[] = [];

  for (const id of parent.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (!attachment || attachment.attachmentContentType !== "application/pdf") {
      continue;
    }
    for (const annotation of attachment.getAnnotations()) {
      if (!SUPPORTED_TYPES.includes(annotation.annotationType)) { continue; }
      // 没有选中文本的批注（比如纯图片区域）无从在 Markdown 里定位。
      if (!annotation.annotationText) { continue; }
      annotations.push({
        key: annotation.key,
        attachment_key: attachment.key,
        text: annotation.annotationText,
        comment: annotation.annotationComment || "",
        page_label: annotation.annotationPageLabel || "",
        // Zotero 的 sortIndex 是 "00000|0000000|00000" 形式的字符串，但类型声明里
        // 允许 number。统一成字符串，下面的 localeCompare 才成立。
        sort_index: String(annotation.annotationSortIndex || ""),
      });
    }
  }

  annotations.sort((left, right) => left.sort_index.localeCompare(right.sort_index));

  const payload: AnnotateRequest = {
    item_key: parent.key,
    library_id: parent.libraryID || 1,
    annotations,
  };

  try {
    const key = (Zotero as any).BetterBibTeX?.KeyManager?.get(parent.id);
    if (key && key.citationKey) { payload.citekey = key.citationKey; }
  } catch (error) {
    // BBT 未安装或还没初始化完。
  }

  return payload;
}
