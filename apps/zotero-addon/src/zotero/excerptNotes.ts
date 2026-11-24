/**
 * Write side of the excerpt notes: attach a citing paper's annotation to one of the
 * papers it cites, or take it off again.
 *
 * Every write lands in the citing paper's own excerpt note (a child note tagged
 * `unizero:excerpts`, created on first use); the cited paper is never touched.
 * Writes are surgical edits of that note (see excerptNoteFormat.ts), serialized so
 * two quick drops cannot overwrite each other, and re-indexed before they resolve so
 * the next read already sees them.
 */

import { uniConnection } from "../modules/uniConnection";
import { SerialQueue } from "../utils/serialQueue";
import {
  addExcerptToNote,
  EXCERPT_NOTE_TAG,
  newExcerptNote,
  removeExcerptFromNote,
  type SelectTarget,
} from "./excerptNoteFormat";
import { isExcerptNote } from "./excerptNoteSource";
import { libraryEditable, libraryScope } from "./libraryScope";

/** Zotero's automatic tag type, hideable in the tag selector. */
const AUTOMATIC_TAG = 1;

const writes = new SerialQueue();

/** A request the add-on refuses; the message is meant for the user. */
export class ExcerptError extends Error {}

/**
 * Every live excerpt note of the citing paper, oldest first. Normally one, but two
 * devices can each create one before they sync, and the index reads them all.
 */
export function excerptNotesOf(citing: Zotero.Item): Zotero.Item[] {
  return citing.getNotes()
    .map((id) => Zotero.Items.get(id) as Zotero.Item | false)
    .filter((note): note is Zotero.Item => Boolean(note) && !(note as Zotero.Item).deleted)
    .filter((note) => isExcerptNote(note))
    .sort((left, right) => left.id - right.id);
}

/** The citing paper's excerpt note, when it has one. The oldest wins. */
export function excerptNoteOf(citing: Zotero.Item): Zotero.Item | undefined {
  return excerptNotesOf(citing)[0];
}

function field(item: Zotero.Item, name: string): string {
  try {
    return String(item.getField(name as any) || "").trim();
  } catch {
    return "";
  }
}

function year(item: Zotero.Item): string {
  return field(item, "date").match(/\d{4}/)?.[0] || "";
}

/** `Dick-Nielsen (2014)`, or the title when the item has no creator. */
function sectionLabel(cited: Zotero.Item): string {
  const creator = field(cited, "firstCreator");
  const when = year(cited);
  if (creator) { return when ? `${creator} (${when})` : creator; }
  return field(cited, "title") || cited.key;
}

/** `Smith, 2020, p. 7`, as Zotero's own note citations read. */
function citationLabel(citing: Zotero.Item, pageLabel: string): string {
  return [field(citing, "firstCreator") || field(citing, "title"), year(citing),
    pageLabel ? `p. ${pageLabel}` : ""].filter(Boolean).join(", ");
}

function targetOf(cited: { libraryID: number; key: string }): SelectTarget {
  return { scope: libraryScope(cited.libraryID), itemKey: String(cited.key) };
}

/**
 * Refuse, with a message for the user, an attachment that cannot be written. Also
 * exported so a drop is checked before any highlight is created for it.
 */
export function assertWritable(citing: Zotero.Item, cited: Zotero.Item): void {
  if (!citing.isRegularItem() || citing.deleted) {
    throw new ExcerptError("Excerpts belong to a regular, non-trashed paper.");
  }
  if (!cited.isRegularItem() || cited.deleted) {
    throw new ExcerptError("The cited paper must be a regular item in the library. Add it to Zotero first.");
  }
  if (cited.libraryID !== citing.libraryID) {
    throw new ExcerptError("The cited paper must be in the same library as the citing paper.");
  }
  if (cited.id === citing.id) {
    throw new ExcerptError("A paper cannot quote itself as a reference.");
  }
  if (!libraryEditable(citing.libraryID)) {
    throw new ExcerptError("This library is read-only.");
  }
}

function parsePosition(annotation: Zotero.Item): unknown {
  try {
    return JSON.parse(String(annotation.annotationPosition || ""));
  } catch {
    return undefined;
  }
}

/**
 * Attach `annotation` (an annotation on one of `citing`'s PDFs) under `cited` in the
 * citing paper's excerpt note. `index` places it among that paper's excerpts
 * (default: last). Returns whether the note changed; an annotation already attached
 * there is left alone.
 */
export function addExcerpt(
  citing: Zotero.Item,
  cited: Zotero.Item,
  annotation: Zotero.Item,
  index?: number,
): Promise<boolean> {
  return writes.run(async () => {
    assertWritable(citing, cited);
    const attachment = annotation.isAnnotation?.() ? annotation.parentItem : undefined;
    if (!attachment || attachment.parentItemID !== citing.id) {
      throw new ExcerptError("Only annotations on the citing paper's own PDFs can be attached.");
    }
    const text = String(annotation.annotationText || "").trim();
    if (!text) {
      throw new ExcerptError("This annotation has no text to quote.");
    }
    const pageLabel = String(annotation.annotationPageLabel || "");

    const existing = excerptNoteOf(citing);
    const before = existing?.getNote() || newExcerptNote();
    const next = addExcerptToNote(before, targetOf(cited), sectionLabel(cited), {
      annotationKey: String(annotation.key),
      attachmentURI: Zotero.URI.getItemURI(attachment),
      citingItemURI: Zotero.URI.getItemURI(citing),
      text,
      pageLabel,
      position: parsePosition(annotation),
      color: annotation.annotationColor || undefined,
      citationLabel: citationLabel(citing, pageLabel),
    }, index);
    if (existing && next === before) { return false; }

    const note = existing || new Zotero.Item("note");
    if (!existing) {
      note.libraryID = citing.libraryID;
      note.parentID = citing.id;
      note.addTag(EXCERPT_NOTE_TAG, AUTOMATIC_TAG);
    }
    note.setNote(next);
    await note.saveTx();
    await uniConnection.ingestExcerptNote(note, false);
    return true;
  });
}

/**
 * Take one annotation out from under `cited`, in every excerpt note of the citing
 * paper (the index shows passages from all of them). Returns whether any note
 * changed; false means the passage was not found where it can be cut out.
 * `cited` is only an address, so passages under a paper since deleted can go too.
 */
export function removeExcerpt(
  citing: Zotero.Item,
  cited: { libraryID: number; key: string },
  annotationKey: string,
): Promise<boolean> {
  return writes.run(async () => {
    if (!libraryEditable(citing.libraryID)) {
      throw new ExcerptError("This library is read-only.");
    }
    let changed = false;
    for (const note of excerptNotesOf(citing)) {
      const before = note.getNote() || "";
      const next = removeExcerptFromNote(before, targetOf(cited), annotationKey);
      if (next === before) { continue; }
      note.setNote(next);
      await note.saveTx();
      await uniConnection.ingestExcerptNote(note, false);
      changed = true;
    }
    return changed;
  });
}
