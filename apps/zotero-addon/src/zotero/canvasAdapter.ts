/**
 * The paper's Canvas: an Obsidian `.canvas` file stored as an attachment of the
 * Zotero item, owned through the `unizero:canvas` tag.
 *
 * Like Raw, the file lives in Zotero's storage and travels with Zotero sync; it is
 * opened from Zotero or from Obsidian with the system's handler for `.canvas`.
 * UniZero only creates it, empty, when asked; after that it is the user's note and
 * nothing here overwrites, moves, or deletes it.
 */

import { hasKind, markArtifact } from "./artifactIdentity";
import { libraryAcceptsFiles } from "./libraryScope";

const CANVAS_ATTACHMENT_TITLE = "Canvas";
const EMPTY_CANVAS = JSON.stringify({ nodes: [], edges: [] });
/** Leaves room in Zotero's storage path for the directory and extension. */
const MAX_FILE_STEM = 120;

/** The paper's Canvas attachment, when one exists. The oldest wins. */
export function canvasAttachment(item: Zotero.Item): Zotero.Item | undefined {
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (attachment && hasKind(attachment, "canvas")) { return attachment; }
  }
  return undefined;
}

function canvasFileStem(item: Zotero.Item): string {
  let title = "";
  try {
    title = String(item.getField("title") || "");
  } catch {
    // An item type without a title reads as untitled.
  }
  // Characters no desktop filesystem accepts, and Windows' reserved device names.
  const stem = Array.from(
    title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim(),
  ).slice(0, MAX_FILE_STEM).join("").replace(/[. ]+$/, "");
  if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) {
    return `Paper ${item.libraryID}-${item.key}`;
  }
  return stem;
}

// Two Obsidian clicks in quick succession must not create two Canvases.
const pending = new Map<number, Promise<CanvasResult>>();

export interface CanvasResult {
  attachment: Zotero.Item;
  created: boolean;
}

/**
 * Return the paper's Canvas, creating an empty one first when it has none.
 * Throws when the item's library does not allow new files (`libraryAcceptsFiles`).
 */
export function ensureCanvasAttachment(item: Zotero.Item): Promise<CanvasResult> {
  const existing = canvasAttachment(item);
  if (existing) { return Promise.resolve({ attachment: existing, created: false }); }

  const running = pending.get(item.id);
  if (running) { return running; }
  const creation = createCanvas(item).finally(() => pending.delete(item.id));
  pending.set(item.id, creation);
  return creation;
}

async function createCanvas(item: Zotero.Item): Promise<CanvasResult> {
  if (!libraryAcceptsFiles(item.libraryID)) {
    throw new Error("This Zotero library does not allow new attachment files");
  }

  // A directory of its own, so the stored file keeps the paper's name.
  const temp = Zotero.getTempDirectory();
  temp.append(`unizero-canvas-${item.libraryID}-${item.key}-${Date.now()}`);
  const dir = temp.path;
  const path = PathUtils.join(dir, `${canvasFileStem(item)}.canvas`);
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  try {
    await Zotero.File.putContentsAsync(path, EMPTY_CANVAS);
    const attachment = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID: item.id,
      title: CANVAS_ATTACHMENT_TITLE,
    });
    await markArtifact(attachment, "canvas", String(item.key));
    ztoolkit.log(`created Canvas for ${item.libraryID}/${item.key}`);
    return { attachment, created: true };
  } finally {
    try {
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    } catch (error) {
      ztoolkit.log(`temp Canvas cleanup failed: ${error}`);
    }
  }
}
