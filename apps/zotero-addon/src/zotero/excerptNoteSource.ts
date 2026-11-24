/**
 * Read side of the excerpt notes: find them and hand their HTML to the derived
 * UniConnection index. Nothing here writes; the writer is `excerptNotes.ts`.
 */

import { EXCERPT_NOTE_TAG } from "./excerptNoteFormat";
import { libraryScope } from "./libraryScope";

/** What the index needs from one excerpt note. */
export interface ExcerptNoteRecord {
  noteID: number;
  libraryID: number;
  /** The note's own library as a `zotero://select` scope (`library` or `groups/<id>`). */
  scope: string;
  /** The citing paper: the note's parent item key. */
  citingKey: string;
  html: string;
}

export interface ExcerptNoteSource {
  notes(libraryID: number): Promise<ExcerptNoteRecord[]>;
}

export function isExcerptNote(item: Zotero.Item): boolean {
  return Boolean(
    item.isNote?.() &&
    item.getTags().some((tag) => tag.tag === EXCERPT_NOTE_TAG),
  );
}

/**
 * The record for a live excerpt note, or undefined when the item is not one: not a
 * note, untagged, trashed, or a standalone note with no citing paper.
 */
export function excerptNoteRecord(item: Zotero.Item): ExcerptNoteRecord | undefined {
  if (!isExcerptNote(item) || item.deleted) { return; }
  const parent = item.parentItem;
  if (!parent || !parent.isRegularItem?.()) { return; }
  return {
    noteID: item.id,
    libraryID: item.libraryID,
    scope: libraryScope(item.libraryID),
    citingKey: String(parent.key),
    html: item.getNote() || "",
  };
}

export const zoteroExcerptNoteSource: ExcerptNoteSource = {
  async notes(libraryID: number): Promise<ExcerptNoteRecord[]> {
    const search = new Zotero.Search({ libraryID });
    search.addCondition("itemType", "is", "note");
    search.addCondition("tag", "is", EXCERPT_NOTE_TAG);
    const ids = await search.search();
    const notes = await Zotero.Items.getAsync(ids) as Zotero.Item[];
    return notes
      .map((note) => excerptNoteRecord(note))
      .filter((record): record is ExcerptNoteRecord => Boolean(record));
  },
};
