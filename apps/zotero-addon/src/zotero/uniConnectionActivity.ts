/**
 * What happened to papers in a library, and when, for Unizero Home's activity order
 * (docs/UNICONNECTION.md §5.4).
 *
 * - `notes`: citing paper's item key → latest change of its excerpt note
 *   (`unizero:excerpts`), which changes whenever a passage is attached or removed.
 * - `annotations`: annotation key → when the highlight was made, for the keys asked
 *   for (the passages' highlights; a library holds far more annotations than
 *   passages). A passage dragged straight out of the PDF is highlighted at that
 *   moment; one attached from an existing highlight dates from the highlight. Zotero
 *   keeps no time per note paragraph, so this is the closest per-passage time there is.
 * - `highlights`: paper's item key → how many annotations its attachments hold, and
 *   when the newest was made.
 * - `userNotes`: paper's item key → latest change of its own child notes (excerpt
 *   notes not counted: they are `notes`).
 *
 * A few aggregate queries per library, so no note or annotation is loaded as an item.
 * Trashed items do not count. Read-only.
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

// Zotero's `YYYY-MM-DD HH:MM:SS` timestamps order correctly as text, so MAX is the newest.
const HIGHLIGHTS_SQL = `
  SELECT P.key AS paperKey, COUNT(*) AS count, MAX(I.dateAdded) AS added
  FROM itemAnnotations AN
  JOIN items I ON I.itemID = AN.itemID
  JOIN itemAttachments AT ON AT.itemID = AN.parentItemID
  JOIN items P ON P.itemID = AT.parentItemID
  WHERE I.libraryID = ? AND AN.itemID ${NOT_TRASHED} AND AN.parentItemID ${NOT_TRASHED}
  GROUP BY P.itemID`;

const annotationTimesSQL = (count: number) => `
  SELECT I.key AS annotationKey, I.dateAdded AS added
  FROM itemAnnotations AN
  JOIN items I ON I.itemID = AN.itemID
  WHERE I.libraryID = ? AND AN.itemID ${NOT_TRASHED} AND AN.parentItemID ${NOT_TRASHED}
    AND I.key IN (${new Array(count).fill("?").join(", ")})`;

/** Well under SQLite's bound-parameter limit. */
const KEYS_PER_QUERY = 500;

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

export async function libraryActivity(
  libraryID: number,
  annotationKeys: Iterable<string>,
): Promise<LibraryActivity> {
  const notes = await latestByPaper(EXCERPT_NOTES_SQL, [libraryID, EXCERPT_NOTE_TAG]);
  const userNotes = await latestByPaper(USER_NOTES_SQL, [libraryID, EXCERPT_NOTE_TAG]);
  const highlights = new Map<string, { count: number; time: number }>();
  for (const row of (await Zotero.DB.queryAsync(HIGHLIGHTS_SQL, [libraryID]) || []) as
    Array<{ paperKey: string; count: number; added: string }>) {
    const time = sqlTime(row.added);
    if (row.paperKey && time !== undefined) {
      highlights.set(row.paperKey, { count: Number(row.count) || 0, time });
    }
  }
  const annotations = new Map<string, number>();
  const keys = [...new Set(annotationKeys)].filter(Boolean);
  for (let offset = 0; offset < keys.length; offset += KEYS_PER_QUERY) {
    const chunk = keys.slice(offset, offset + KEYS_PER_QUERY);
    for (const row of (await Zotero.DB.queryAsync(annotationTimesSQL(chunk.length), [libraryID, ...chunk]) || []) as
      Array<{ annotationKey: string; added: string }>) {
      const time = sqlTime(row.added);
      if (row.annotationKey && time !== undefined) { annotations.set(row.annotationKey, time); }
    }
  }
  return { notes, annotations, highlights, userNotes };
}
