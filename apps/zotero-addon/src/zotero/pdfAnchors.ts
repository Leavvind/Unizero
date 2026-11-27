/**
 * Open a `zotero://open-pdf` link written next to a mention in a Raw or Canvas
 * (docs/UNICONNECTION.md §2). The link is user text: it must match Zotero's
 * own shape exactly (parsePdfAnchor), and it opens only a PDF attachment of the
 * library it names. Read-only.
 */

import { parsePdfAnchor } from "@unizero/links";

export async function openPdfAnchor(url: string): Promise<boolean> {
  const anchor = parsePdfAnchor(url);
  if (!anchor) { return false; }
  const libraryID = anchor.groupID === undefined
    ? Zotero.Libraries.userLibraryID
    : (Zotero.Groups as any).getLibraryIDFromGroupID(anchor.groupID) as number | false;
  if (!libraryID) { return false; }
  const attachment = Zotero.Items.getByLibraryAndKey(libraryID, anchor.attachmentKey) as Zotero.Item | false;
  if (!attachment || attachment.deleted || !attachment.isPDFAttachment()) { return false; }
  const annotation = anchor.annotationKey
    ? Zotero.Items.getByLibraryAndKey(libraryID, anchor.annotationKey) as Zotero.Item | false
    : false;
  // `page` is pageIndex + 1, as Zotero writes it; a deleted annotation falls back to it.
  const location = annotation && !annotation.deleted
    ? { annotationID: anchor.annotationKey }
    : anchor.page !== undefined ? { pageIndex: anchor.page - 1 } : undefined;
  await Zotero.Reader.open(attachment.id, location as any);
  return true;
}
