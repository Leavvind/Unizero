/**
 * Adapter from Zotero annotations to the paper runtime.
 *
 * Ported from the annotation half of ZoMiner's `modules/zotero-adapter.js`, with
 * identical behaviour.
 *
 * Only highlights and underlines are supported today, and only their plain text
 * is delivered — that is ZoMiner's existing behaviour, matched first and evolved
 * later. The normalised annotation model (type/colour/tag/position + profile
 * rendering) is in docs/ROADMAP.md.
 */

import type { AnnotateRequest, AnnotationPayloadItem } from "../runtime-client/contracts";
import { libraryScope } from "./libraryScope";

export interface PreparedAnnotateRequest extends AnnotateRequest {
  item_key: string;
  library_id: number;
  annotations: AnnotationPayloadItem[];
}

/** The only two annotation types the runtime can currently locate in the Markdown body. */
const SUPPORTED_TYPES = ["highlight", "underline"];

/**
 * Normalise the selection to the level of bibliographic items.
 *
 * Annotations are injected per item, not per attachment: annotations from several
 * PDFs under one item are merged into the same Markdown. A selected attachment
 * resolves up to its parent, and the result is deduplicated by item.
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
 * Collect every injectable annotation under one item.
 *
 * Sorted by sortIndex so the injection order matches reading order — the runtime
 * matches the body sequentially, and an out-of-order list markedly lowers the
 * match rate.
 */
export function annotationPayload(parent: Zotero.Item): PreparedAnnotateRequest {
  const annotations: AnnotationPayloadItem[] = [];

  for (const id of parent.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (!attachment || attachment.attachmentContentType !== "application/pdf") {
      continue;
    }
    for (const annotation of attachment.getAnnotations()) {
      if (!SUPPORTED_TYPES.includes(annotation.annotationType)) { continue; }
      // An annotation with no selected text (an image region, say) cannot be
      // located in the Markdown.
      if (!annotation.annotationText) { continue; }
      annotations.push({
        key: annotation.key,
        attachment_key: attachment.key,
        text: annotation.annotationText,
        comment: annotation.annotationComment || "",
        page_label: annotation.annotationPageLabel || "",
        // Zotero's sortIndex is a string of the form "00000|0000000|00000", but
        // the type declaration also allows number. Normalise to string so the
        // localeCompare below holds.
        sort_index: String(annotation.annotationSortIndex || ""),
      });
    }
  }

  annotations.sort((left, right) =>
    String(left.sort_index || "").localeCompare(String(right.sort_index || "")),
  );

  const payload: PreparedAnnotateRequest = {
    item_key: parent.key,
    library_id: parent.libraryID || 1,
    library_scope: libraryScope(parent.libraryID || 1),
    annotations,
  };

  try {
    const key = (Zotero as any).BetterBibTeX?.KeyManager?.get(parent.id);
    if (key && key.citationKey) { payload.citekey = key.citationKey; }
  } catch (error) {
    // BBT is not installed, or has not finished initialising.
  }

  return payload;
}
