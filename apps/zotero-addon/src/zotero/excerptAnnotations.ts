/**
 * Annotations as excerpt sources: what a drop onto the sidebar carries, turning a
 * plain PDF text selection into a highlight so it has a key to point back to, and
 * opening an excerpt in the reader.
 *
 * Zotero's reader puts `zotero/annotation` (a JSON array) on the drag both when an
 * annotation is dragged out of its sidebar and when selected text is dragged out of
 * the page. The first carries the saved annotation's key; the second describes a
 * highlight that does not exist yet. The exact shape of the second is a host detail
 * this module reads leniently — see the manual checks in docs/UNICONNECTION.md.
 */

import { ExcerptError } from "./excerptNotes";
import { libraryEditable } from "./libraryScope";

export const ANNOTATION_DRAG_TYPE = "zotero/annotation";
/** Tag on highlights UniZero created from a dropped text selection. */
export const EXCERPT_HIGHLIGHT_TAG = "unizero:excerpt";
const DEFAULT_HIGHLIGHT_COLOR = "#ffd400";

export interface DroppedAnnotation {
  /** The saved annotation's key; absent for a text selection. */
  key?: string;
  attachmentItemID?: number;
  type?: string;
  text: string;
  color?: string;
  pageLabel?: string;
  sortIndex?: string;
  position?: any;
}

/** Read the reader's drag payload. Unusable entries are dropped, never guessed at. */
export function parseAnnotationDrop(raw: string): DroppedAnnotation[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  return list.flatMap((entry: any) => {
    if (!entry || typeof entry !== "object") { return []; }
    const key = typeof entry.id === "string" && /^[A-Z0-9]{8}$/.test(entry.id)
      ? entry.id
      : typeof entry.key === "string" && /^[A-Z0-9]{8}$/.test(entry.key) ? entry.key : undefined;
    const attachmentItemID = Number(entry.attachmentItemID);
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!key && !text) { return []; }
    return [{
      key,
      attachmentItemID: Number.isInteger(attachmentItemID) && attachmentItemID > 0
        ? attachmentItemID
        : undefined,
      type: typeof entry.type === "string" ? entry.type : undefined,
      text,
      color: typeof entry.color === "string" ? entry.color : undefined,
      pageLabel: entry.pageLabel === undefined ? undefined : String(entry.pageLabel),
      sortIndex: typeof entry.sortIndex === "string" ? entry.sortIndex : undefined,
      position: entry.position && typeof entry.position === "object" ? entry.position : undefined,
    }];
  });
}

/** Zotero's PDF sort index: page, character offset, top. Page alone keeps order by page. */
function fallbackSortIndex(position: any): string {
  const page = Math.max(0, Number(position?.pageIndex) || 0);
  return `${String(page).padStart(5, "0")}|000000|00000`;
}

/**
 * The annotation items a drop stands for, creating highlights for text selections.
 * Every annotation must sit on one of `citing`'s own PDFs and carry text to quote.
 *
 * The whole drop is checked before anything is created, and highlights created
 * here are erased again if a later one fails, so a refused drop leaves the PDF as
 * it was.
 */
export async function annotationsFromDrop(
  dropped: DroppedAnnotation[],
  citing: Zotero.Item,
): Promise<Zotero.Item[]> {
  if (!dropped.length) {
    throw new ExcerptError("Drop a highlight from this paper's PDF, or text selected in it.");
  }
  const plan: ({ saved: Zotero.Item } | { attachment: Zotero.Item; entry: DroppedAnnotation })[] = [];
  for (const entry of dropped) {
    const attachment = entry.attachmentItemID
      ? Zotero.Items.get(entry.attachmentItemID) as Zotero.Item | false
      : false;
    if (!attachment || attachment.parentItemID !== citing.id) {
      throw new ExcerptError("Only passages from this paper's own PDFs can be attached here.");
    }
    if (entry.key) {
      const saved = Zotero.Items.getByLibraryAndKey(attachment.libraryID, entry.key) as Zotero.Item | false;
      if (saved && saved.isAnnotation?.() && saved.parentItemID === attachment.id) {
        if (!String(saved.annotationText || "").trim()) {
          throw new ExcerptError("This annotation has no text to quote.");
        }
        plan.push({ saved });
        continue;
      }
    }
    if (!entry.text || !entry.position) {
      throw new ExcerptError("This annotation is not saved yet; try again in a moment.");
    }
    if (!libraryEditable(attachment.libraryID)) {
      throw new ExcerptError("This library is read-only.");
    }
    plan.push({ attachment, entry });
  }

  const annotations: Zotero.Item[] = [];
  const created: Zotero.Item[] = [];
  try {
    for (const step of plan) {
      if ("saved" in step) {
        annotations.push(step.saved);
        continue;
      }
      const { attachment, entry } = step;
      const highlight = await Zotero.Annotations.saveFromJSON(attachment, {
        key: Zotero.DataObjectUtilities.generateKey(),
        type: "highlight",
        text: entry.text,
        comment: "",
        color: entry.color || DEFAULT_HIGHLIGHT_COLOR,
        pageLabel: entry.pageLabel || "",
        sortIndex: entry.sortIndex || fallbackSortIndex(entry.position),
        position: entry.position,
        tags: [{ name: EXCERPT_HIGHLIGHT_TAG }],
      } as any) as Zotero.Item;
      created.push(highlight);
      annotations.push(highlight);
    }
  } catch (error) {
    await eraseCreated(created);
    throw error;
  }
  return annotations;
}

/** Undo highlights a failed drop created. Best effort: the original error matters more. */
export async function eraseCreated(created: Zotero.Item[]): Promise<void> {
  for (const highlight of created) {
    try {
      await highlight.eraseTx();
    } catch (error) {
      ztoolkit.log("[excerpts] could not erase a highlight from a failed drop", error);
    }
  }
}

/** Open the excerpt's PDF at its annotation, or at its page when the annotation is gone. */
export async function openExcerpt(
  libraryID: number,
  excerpt: { annotationKey: string; attachmentKey?: string; pageIndex?: number },
): Promise<boolean> {
  if (!excerpt.attachmentKey) { return false; }
  const attachment = Zotero.Items.getByLibraryAndKey(libraryID, excerpt.attachmentKey) as Zotero.Item | false;
  if (!attachment || attachment.deleted) { return false; }
  const annotation = Zotero.Items.getByLibraryAndKey(libraryID, excerpt.annotationKey) as Zotero.Item | false;
  const location = annotation && !annotation.deleted
    ? { annotationID: excerpt.annotationKey }
    : excerpt.pageIndex !== undefined ? { pageIndex: excerpt.pageIndex } : undefined;
  await Zotero.Reader.open(attachment.id, location as any);
  return true;
}
