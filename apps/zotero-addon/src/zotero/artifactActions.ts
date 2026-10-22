/**
 * Management of the user's own artifacts — Raw and Canvas — on request.
 *
 * Both are working copies, so nothing here erases one: a replaced or removed Raw
 * or Canvas goes to Zotero's trash, from where the user can restore it. Only
 * attachments carrying the matching `unizero:` tag are ever touched.
 */

import { artifactSource, markArtifact } from "./artifactIdentity";
import { canvasAttachment } from "./canvasAdapter";
import {
  pdfAttachment,
  rawAttachment,
  rawBackupAttachment,
} from "./literatureCollectionAdapter";

export type ManagedArtifact = "raw" | "canvas";

const RAW_TITLE = "Raw";
const RAW_BACKUP_TITLE = "Raw Backup";

/** The attachment `kind` names for the paper, as the bridge reports it. */
export function managedAttachment(
  item: Zotero.Item,
  kind: ManagedArtifact,
): Zotero.Item | undefined {
  return kind === "raw" ? rawAttachment(item) : canvasAttachment(item);
}

/**
 * Move the paper's Raw or Canvas to Zotero's trash. Returns the trashed
 * attachment, or undefined when the paper has none. The next conversion (Raw) or
 * Canvas open creates a fresh one.
 */
export async function trashManagedArtifact(
  item: Zotero.Item,
  kind: ManagedArtifact,
): Promise<Zotero.Item | undefined> {
  const attachment = managedAttachment(item, kind);
  if (!attachment) { return undefined; }
  await Zotero.Items.trashTx([attachment.id]);
  ztoolkit.log(`trashed ${kind} ${attachment.key} of ${item.libraryID}/${item.key}`);
  return attachment;
}

/**
 * Replace the paper's Raw with a copy of its Raw Backup — the latest conversion.
 *
 * The copy is imported before anything is trashed, so a failure leaves the
 * current Raw in place. Files beside the backup (its images) are copied too.
 * Throws when the paper has no Raw Backup or its file is not on this machine.
 */
export async function restoreRawFromBackup(item: Zotero.Item): Promise<Zotero.Item> {
  const backup = rawBackupAttachment(item);
  if (!backup) { throw new Error("This paper has no Raw Backup"); }
  const backupPath = await rawBackupFile(backup);
  if (!backupPath) { throw new Error("The Raw Backup file is not on this machine"); }

  const source = artifactSource(backup) ?? pdfAttachment(item)?.key ?? "";
  const current = rawAttachment(item);
  const title = current
    ? String(current.getField("title") || RAW_TITLE)
    : String(backup.getField("title") || RAW_BACKUP_TITLE)
      .replace(RAW_BACKUP_TITLE, RAW_TITLE);

  const raw = await Zotero.Attachments.importFromFile({
    file: backupPath,
    parentItemID: item.id,
    title,
    contentType: "text/markdown",
  });
  try {
    await markArtifact(raw, "raw", source);
    await copySiblings(backupPath, raw);
  } catch (error) {
    // Leave the current Raw as the only one rather than a half-made copy beside it.
    await Zotero.Items.trashTx([raw.id]);
    throw error;
  }

  if (current) {
    await Zotero.Items.trashTx([current.id]);
  }
  ztoolkit.log(`restored Raw of ${item.libraryID}/${item.key} from ${backup.key}`);
  return raw;
}

/** The Raw Backup's file, when it is on this machine. */
export async function rawBackupFile(backup: Zotero.Item): Promise<string | undefined> {
  const path = await backup.getFilePathAsync();
  return path && await IOUtils.exists(path) ? path : undefined;
}

/** Copy everything beside `file` (images, not Zotero's own index files). */
async function copySiblings(file: string, into: Zotero.Item): Promise<void> {
  const from = PathUtils.parent(file);
  const target = await into.getFilePathAsync();
  const to = target ? PathUtils.parent(target) : null;
  if (!from || !to) { return; }
  for (const child of await IOUtils.getChildren(from)) {
    const name = PathUtils.filename(child);
    if (child === file || name.startsWith(".zotero")) { continue; }
    await IOUtils.copy(child, PathUtils.join(to, name), { recursive: true });
  }
}
