/**
 * What happened to papers in a library, and when, for Unizero Home's activity order
 * (docs/UNICONNECTION.md §5.4).
 *
 * - `notes`: citing paper's item key → latest change of its excerpt note
 *   (`unizero:excerpts`), which changes whenever a passage is attached or removed.
 * - `annotations`: annotation key → when the highlight was made. A passage dragged
 *   straight out of the PDF is highlighted at that moment; one attached from an
 *   existing highlight dates from the highlight. Zotero keeps no time per note
 *   paragraph, so this is the closest per-passage time there is.
 * - `highlights`: paper's item key → how many annotations its attachments hold, and
 *   when the newest was made.
 * - `userNotes`: paper's item key → latest change of its own child notes (excerpt
 *   notes not counted: they are `notes`).
 *
 * Three queries per library, so no note or annotation is loaded as an item. Trashed
 * items do not count. Read-only.
 */

import { EXCERPT_NOTE_TAG } from "./excerptNoteFormat";

export interface LibraryActivity {
  notes: Map<string, number>;
  annotations: Map<string, number>;
  highlights: Map<string, { count: number; time: number }>;
  userNotes: Map<string, number>;
}

const NOT_TRASHED = "NOT IN (SELECT itemID FROM deletedItems)";

const EXCERPT_NOTES_SQL = `
  SELECT P.key AS paperKey, MAX(I.dateModified) AS changed
  FROM itemNotes N
  JOIN items I ON I.itemID = N.itemID
  JOIN items P ON P.itemID = N.parentItemID
  JOIN itemTags IT ON IT.itemID = N.itemID
  JOIN tags T ON T.tagID = IT.tagID
  WHERE I.libraryID = ? AND T.name = ? AND N.itemID ${NOT_TRASHED}
  GROUP BY P.itemID`;

const USER_NOTES_SQL = `
  SELECT P.key AS paperKey, MAX(I.dateModified) AS changed
  FROM itemNotes N
  JOIN items I ON I.itemID = N.itemID
  JOIN items P ON P.itemID = N.parentItemID
  WHERE I.libraryID = ? AND N.itemID ${NOT_TRASHED}
    AND N.itemID NOT IN (
      SELECT IT.itemID FROM itemTags IT JOIN tags T ON T.tagID = IT.tagID WHERE T.name = ?)
  GROUP BY P.itemID`;

const ANNOTATIONS_SQL = `
  SELECT I.key AS annotationKey, I.dateAdded AS added, P.key AS paperKey
  FROM itemAnnotations AN
  JOIN items I ON I.itemID = AN.itemID
  LEFT JOIN itemAttachments AT ON AT.itemID = AN.parentItemID
  LEFT JOIN items P ON P.itemID = AT.parentItemID
  WHERE I.libraryID = ? AND AN.itemID ${NOT_TRASHED} AND AN.parentItemID ${NOT_TRASHED}`;

/** Zotero's UTC SQL timestamp (`2024-05-01 12:00:00`) as epoch milliseconds. */
export function sqlTime(value: unknown): number | undefined {
  const text = String(value || "");
  if (!text) { return; }
  const time = Date.parse(`${text.replace(" ", "T")}Z`);
  return Number.isFinite(time) ? time : undefined;
}

async function latestByPaper(sql: string, params: unknown[]): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  for (const row of (await Zotero.DB.queryAsync(sql, params) || []) as
    Array<{ paperKey: string; changed: string }>) {
    const time = sqlTime(row.changed);
    if (row.paperKey && time !== undefined) { times.set(row.paperKey, time); }
  }
  return times;
}

export async function libraryActivity(libraryID: number): Promise<LibraryActivity> {
  const notes = await latestByPaper(EXCERPT_NOTES_SQL, [libraryID, EXCERPT_NOTE_TAG]);
  const userNotes = await latestByPaper(USER_NOTES_SQL, [libraryID, EXCERPT_NOTE_TAG]);
  const annotations = new Map<string, number>();
  const highlights = new Map<string, { count: number; time: number }>();
  for (const row of (await Zotero.DB.queryAsync(ANNOTATIONS_SQL, [libraryID]) || []) as
    Array<{ annotationKey: string; added: string; paperKey?: string }>) {
    const time = sqlTime(row.added);
    if (!row.annotationKey || time === undefined) { continue; }
    annotations.set(row.annotationKey, time);
    if (!row.paperKey) { continue; }
    const known = highlights.get(row.paperKey);
    highlights.set(row.paperKey, { count: (known?.count || 0) + 1, time: Math.max(known?.time ?? time, time) });
  }
  return { notes, annotations, highlights, userNotes };
}
