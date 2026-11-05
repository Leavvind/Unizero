/** Read-only discovery of local, editable document attachments. No ownership adoption. */
import { artifactKind } from "./artifactIdentity";
import { rawAttachment } from "./literatureCollectionAdapter";
import { libraryScope } from "./libraryScope";

export interface LinkSource {
  libraryID: number; itemKey: string; attachmentKey: string;
  title: string; itemTitle: string; format: "md" | "canvas";
  purpose: "raw" | "canvas" | "user"; path?: string; available: boolean; version: string;
}
export async function attachmentLinkSource(parent: Zotero.Item, attachment: Zotero.Item): Promise<LinkSource | undefined> {
  if (attachment.deleted || attachment.libraryID !== parent.libraryID || attachment.parentID !== parent.id) { return; }
  if (!attachment.isFileAttachment()) { return; }
  const kind = artifactKind(attachment);
  // Generated backups, old copies, summaries and reference exports are not sources.
  if (kind && kind !== "raw" && kind !== "canvas") { return; }
  const tags = attachment.getTags().map((tag) => tag.tag);
  if (!kind && tags.some((tag) => /^(?:unizero|zominer):/.test(tag))) { return; }
  const contentType = attachment.attachmentContentType;
  const filename = String(attachment.attachmentFilename || "");
  const format = kind === "canvas" || /\.canvas$/i.test(filename) ? "canvas"
    : kind === "raw" || contentType === "text/markdown" || /\.md$/i.test(filename) ? "md" : undefined;
  if (!format) { return; }
  const candidate = await attachment.getFilePathAsync();
  const available = !!candidate && await IOUtils.exists(candidate);
  return { libraryID: parent.libraryID, itemKey: String(parent.key), attachmentKey: String(attachment.key),
    title: String(attachment.getField("title") || filename), itemTitle: String(parent.getField("title") || parent.key),
    format, purpose: kind === "raw" || kind === "canvas" ? kind : "user", path: available ? candidate! : undefined,
    available, version: `${attachment.version}:${attachment.dateModified}` };
}

/** How many attachments have their file checked at once during a scan. */
const FILE_CHECK_BATCH = 32;

export function linkSourceLibraries(requested?: number[]): number[] {
  const libraries = Zotero.Libraries.getAll().filter((lib) => lib.libraryType !== "feed").map((lib) => lib.libraryID);
  if (requested?.some((id) => !libraries.includes(id))) { throw new Error("Unknown library in source scope"); }
  return requested?.length ? [...new Set(requested)].sort((a, b) => a - b) : libraries.sort((a, b) => a - b);
}
export async function listLinkSources(libraryIDs: number[]): Promise<LinkSource[]> {
  const sources: LinkSource[] = [];
  for (const libraryID of libraryIDs) {
    const items = await Zotero.Items.getAll(libraryID, true, false);
    const pairs: { parent: Zotero.Item; id: number }[] = [];
    for (const parent of items) {
      if (!parent.isRegularItem() || parent.deleted) { continue; }
      for (const id of parent.getAttachments()) { pairs.push({ parent, id }); }
    }
    if (!pairs.length) { continue; }
    // One batched load per library instead of one await per attachment.
    const attachments = await Zotero.Items.getAsync(pairs.map((pair) => pair.id));
    // An unreadable record still fails the scan: a snapshot without it would
    // prune that source's links from the plugin's index.
    const missing = pairs.findIndex((_pair, index) => !attachments[index]);
    if (missing >= 0) { throw new Error(`Unreadable attachment ${pairs[missing].id}`); }
    // File checks run a bounded batch at a time rather than strictly in sequence.
    for (let start = 0; start < pairs.length; start += FILE_CHECK_BATCH) {
      const found = await Promise.all(pairs.slice(start, start + FILE_CHECK_BATCH)
        .map((pair, offset) => attachmentLinkSource(pair.parent, attachments[start + offset])));
      for (const source of found) { if (source) { sources.push(source); } }
    }
  }
  return sources.sort((a, b) => a.libraryID - b.libraryID || a.attachmentKey.localeCompare(b.attachmentKey));
}

/** Explicit attachments are constrained to their parent. Default Raw selection stays centralized. */
export async function paperDocument(parent: Zotero.Item, key?: string): Promise<LinkSource | undefined> {
  const attachment = key ? (await Zotero.Items.getAsync(parent.getAttachments()))
    .find((item) => item && item.libraryID === parent.libraryID && item.key === key) : rawAttachment(parent);
  if (!attachment) { return; }
  const source = await attachmentLinkSource(parent, attachment);
  return source?.format === "md" ? source : undefined;
}
export function pdfDocumentURL(attachment: Zotero.Item): string {
  return `zotero://open-pdf/${libraryScope(attachment.libraryID)}/items/${attachment.key}`;
}
