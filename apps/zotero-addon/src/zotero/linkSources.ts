/** Read-only discovery of local, editable document attachments. No ownership adoption. */
import { artifactKind } from "./artifactIdentity";
import { rawAttachment } from "./literatureCollectionAdapter";
import { libraryScope } from "./libraryScope";

export interface LinkSource {
  libraryID: number; itemKey: string; attachmentKey: string;
  title: string; itemTitle: string; format: "md" | "canvas";
  purpose: "raw" | "canvas" | "user"; path?: string; available: boolean; version: string;
}
/**
 * `attachmentFilename` throws for a linked file whose stored path this OS cannot parse,
 * such as a Windows `D:\code\…` path in a library synced to a Mac. One such attachment must
 * not fail the whole library scan, so it reads as having no filename.
 */
export function safeAttachmentFilename(attachment: Zotero.Item): string {
  try { return String(attachment.attachmentFilename || ""); } catch { return ""; }
}
/** Shared eligibility for discovery, explicit resolution and attachment pickers. */
export function attachmentDocumentType(parent: Zotero.Item, attachment: Zotero.Item): Pick<LinkSource, "format" | "purpose"> | undefined {
  if (attachment.deleted || attachment.libraryID !== parent.libraryID || attachment.parentID !== parent.id) { return; }
  if (!attachment.isFileAttachment()) { return; }
  const kind = artifactKind(attachment);
  // Generated backups, old copies, summaries and reference exports are not sources.
  if (kind && kind !== "raw" && kind !== "canvas") { return; }
  const tags = attachment.getTags().map((tag) => tag.tag);
  if (!kind && tags.some((tag) => /^(?:unizero|zominer):/.test(tag))) { return; }
  const contentType = attachment.attachmentContentType;
  const filename = safeAttachmentFilename(attachment);
  const format = kind === "canvas" || /\.canvas$/i.test(filename) ? "canvas"
    : kind === "raw" || contentType === "text/markdown" || /\.md$/i.test(filename) ? "md" : undefined;
  if (!format) { return; }
  return { format, purpose: kind === "raw" || kind === "canvas" ? kind : "user" };
}

export async function attachmentLinkSource(parent: Zotero.Item, attachment: Zotero.Item): Promise<LinkSource | undefined> {
  const document = attachmentDocumentType(parent, attachment);
  if (!document) { return; }
  const filename = safeAttachmentFilename(attachment);
  // An unparseable path is an unavailable file on this machine, not a failed scan.
  const candidate = await attachment.getFilePathAsync().catch(() => undefined);
  const available = !!candidate && await IOUtils.exists(candidate).catch(() => false);
  return { libraryID: parent.libraryID, itemKey: String(parent.key), attachmentKey: String(attachment.key),
    title: String(attachment.getField("title") || filename), itemTitle: String(parent.getField("title") || parent.key),
    ...document, path: available ? candidate! : undefined,
    available, version: `${attachment.version}:${attachment.dateModified}` };
}

/** How many attachments have their file checked at once during a scan. */
const FILE_CHECK_BATCH = 32;

export function linkSourceLibraries(requested?: number[]): number[] {
  const libraries = Zotero.Libraries.getAll().filter((lib) => lib.libraryType !== "feed").map((lib) => lib.libraryID);
  if (requested?.some((id) => !libraries.includes(id))) { throw new Error("Unknown library in source scope"); }
  return requested?.length ? [...new Set(requested)].sort((a, b) => a - b) : libraries.sort((a, b) => a - b);
}
interface DocumentAttachment { parent: Zotero.Item; attachment: Zotero.Item }

/**
 * Per library, the attachments that were documents when the library was last walked.
 * The plugin asks for a fresh scan every minute, and walking every item and tag of a
 * library that often is the expensive part. Kept only while the observer below is
 * registered, which drops a library whenever one of its items changes. Files are
 * still checked on every scan: a file can appear or vanish without a Zotero event.
 */
const documentAttachments = new Map<number, DocumentAttachment[]>();
const libraryGenerations = new Map<number, number>();
let generation = 0;
let observerID: string | undefined;

async function libraryDocuments(libraryID: number): Promise<DocumentAttachment[]> {
  const cached = documentAttachments.get(libraryID);
  if (cached) { return cached; }
  const started = generation, libraryStarted = libraryGenerations.get(libraryID);
  const items = await Zotero.Items.getAll(libraryID, true, false);
  const pairs: { parent: Zotero.Item; id: number }[] = [];
  for (const parent of items) {
    if (!parent.isRegularItem() || parent.deleted) { continue; }
    for (const id of parent.getAttachments()) { pairs.push({ parent, id }); }
  }
  // One batched load per library instead of one await per attachment.
  const attachments = pairs.length ? await Zotero.Items.getAsync(pairs.map((pair) => pair.id)) : [];
  // An unreadable record still fails the scan: a snapshot without it would
  // prune that source's links from the plugin's index.
  const missing = pairs.findIndex((_pair, index) => !attachments[index]);
  if (missing >= 0) { throw new Error(`Unreadable attachment ${pairs[missing].id}`); }
  const documents = pairs.map((pair, index) => ({ parent: pair.parent, attachment: attachments[index] }))
    .filter((pair) => attachmentDocumentType(pair.parent, pair.attachment));
  // A walk that an item change overtook is still this scan's answer, but not the next one's.
  if (observerID && started === generation && libraryStarted === libraryGenerations.get(libraryID)) {
    documentAttachments.set(libraryID, documents);
  }
  return documents;
}

export async function listLinkSources(libraryIDs: number[]): Promise<LinkSource[]> {
  const sources: LinkSource[] = [];
  for (const libraryID of libraryIDs) {
    const documents = await libraryDocuments(libraryID);
    // File checks run a bounded batch at a time rather than strictly in sequence.
    for (let start = 0; start < documents.length; start += FILE_CHECK_BATCH) {
      const found = await Promise.all(documents.slice(start, start + FILE_CHECK_BATCH)
        .map((pair) => attachmentLinkSource(pair.parent, pair.attachment)));
      for (const source of found) { if (source) { sources.push(source); } }
    }
  }
  return sources.sort((a, b) => a.libraryID - b.libraryID || a.attachmentKey.localeCompare(b.attachmentKey));
}

export function invalidateLinkSources(libraryID?: number): void {
  if (libraryID === undefined) {
    generation += 1;
    libraryGenerations.clear();
    documentAttachments.clear();
    return;
  }
  libraryGenerations.set(libraryID, (libraryGenerations.get(libraryID) || 0) + 1);
  documentAttachments.delete(libraryID);
}

/**
 * Any item event may add, remove, retag, trash or reparent a document attachment, so
 * it drops its library. An event that names no library (a tag event, or a deleted
 * item without one in `extraData`) drops them all.
 */
export function registerLinkSourceInvalidation(): void {
  if (observerID) { return; }
  observerID = Zotero.Notifier.registerObserver(
    {
      notify(_event: string, type: string, ids: (number | string)[], extraData: unknown) {
        if (type !== "item") { invalidateLinkSources(); return; }
        const libraries = new Set<number>();
        for (const id of ids) {
          const item = Zotero.Items.get(Number(id)) as Zotero.Item | false;
          const extra = (extraData as Record<string, { libraryID?: number }> | undefined)?.[String(id)];
          const libraryID = Number(item ? item.libraryID : extra?.libraryID);
          if (!Number.isInteger(libraryID) || libraryID <= 0) { invalidateLinkSources(); return; }
          libraries.add(libraryID);
        }
        for (const libraryID of libraries) { invalidateLinkSources(libraryID); }
      },
    },
    ["item", "item-tag"],
    "unizero-link-sources",
  );
}

export function unregisterLinkSourceInvalidation(): void {
  if (!observerID) { return; }
  Zotero.Notifier.unregisterObserver(observerID);
  observerID = undefined;
  invalidateLinkSources();
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
