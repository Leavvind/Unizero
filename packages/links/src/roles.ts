/**
 * Link roles (docs/UNICONNECTION.md §1) and the PDF anchors of an evidence
 * unit (§2). The role of a link follows from where it is written and what it points
 * at; it is never chosen when the link is inserted and never read from titles or
 * file names.
 */

import type { LinkTarget, PaperRef } from "./linkTarget";

/** A paper's own notes: the attachments UniZero tags `unizero:raw` or `unizero:canvas`. */
export type PaperNotePurpose = "raw" | "canvas";

/**
 * Where a link is written, as far as its role goes. A Zotero document carries its
 * owning paper and its `purpose`; anything else (a Vault note) is just a kind.
 */
export type LinkSourceKind =
  | { kind: "zotero"; libraryID: number; itemKey: string; purpose: string }
  | { kind: string; libraryID?: undefined; itemKey?: undefined; purpose?: undefined };

export function isPaperNotePurpose(purpose: unknown): purpose is PaperNotePurpose {
  return purpose === "raw" || purpose === "canvas";
}

export function samePaper(a: PaperRef, b: PaperRef): boolean {
  return a.libraryID === b.libraryID && a.itemKey === b.itemKey;
}

/**
 * Academic: written in paper A's Raw or Canvas and pointing at another paper B (any of
 * B's files counts as B). Everything else — Vault notes, other Markdown attachments, a
 * paper's links to itself — is an ordinary link.
 */
export function isPaperToPaper(source: LinkSourceKind, target: LinkTarget): boolean {
  return source.kind === "zotero" && isPaperNotePurpose(source.purpose) && target.kind === "paper"
    && source.libraryID !== undefined && source.itemKey !== undefined
    && !samePaper({ libraryID: source.libraryID, itemKey: source.itemKey }, target);
}

/** Only the annotation/page links Zotero writes; anything else stays out of the unit. */
export const PDF_ANCHOR = /^zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/[A-Za-z0-9]+(?:\?[^\s#]*)?$/;

export interface PdfAnchor {
  /** `undefined` for the user library ("library"); the group ID otherwise. */
  groupID?: number;
  /** The PDF attachment's key. */
  attachmentKey: string;
  /** 1-based position in the PDF (pageIndex + 1), not a printed page label. */
  page?: number;
  annotationKey?: string;
}

/**
 * A `zotero://open-pdf` link from a note, taken apart. The text is the user's, so it
 * must match Zotero's own shape exactly; anything else is rejected.
 */
export function parsePdfAnchor(url: string): PdfAnchor | undefined {
  if (!PDF_ANCHOR.test(url)) { return; }
  const match = /^zotero:\/\/open-pdf\/(?:library|groups\/(\d+))\/items\/([A-Za-z0-9]+)(?:\?([^\s#]*))?$/.exec(url);
  if (!match) { return; }
  const anchor: PdfAnchor = { attachmentKey: match[2] };
  if (match[1]) {
    const groupID = Number(match[1]);
    if (!Number.isSafeInteger(groupID) || groupID < 1) { return; }
    anchor.groupID = groupID;
  }
  for (const pair of (match[3] || "").split("&").filter(Boolean)) {
    const [name, value = ""] = pair.split("=");
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { return; }
    if (name === "page") {
      if (!/^[1-9]\d*$/.test(decoded) || !Number.isSafeInteger(Number(decoded))) { return; }
      anchor.page = Number(decoded);
    } else if (name === "annotation") {
      if (!/^[A-Za-z0-9]+$/.test(decoded)) { return; }
      anchor.annotationKey = decoded;
    }
  }
  return anchor;
}

/** Page of a Zotero PDF link, for labels only. */
export function pdfAnchorPage(url: string): number | undefined {
  return parsePdfAnchor(url)?.page;
}
