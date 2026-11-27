/**
 * Annotation activity per paper, for Uniconnection's activity order
 * (docs/UNICONNECTION.md §4.1): paper's item key → how many annotations its
 * attachments hold, and when the newest was made. The other activity, mentions in
 * the paper's Raw or Canvas, comes from the paper-link index.
 *
 * One aggregate query per library, so no annotation is loaded as an item. Trashed
 * items do not count. Read-only.
 */

const NOT_TRASHED = "NOT IN (SELECT itemID FROM deletedItems)";

// Zotero's `YYYY-MM-DD HH:MM:SS` timestamps order correctly as text, so MAX is the newest.
const HIGHLIGHTS_SQL = `
  SELECT P.key AS paperKey, COUNT(*) AS count, MAX(I.dateAdded) AS added
  FROM itemAnnotations AN
  JOIN items I ON I.itemID = AN.itemID
  JOIN itemAttachments AT ON AT.itemID = AN.parentItemID
  JOIN items P ON P.itemID = AT.parentItemID
  WHERE I.libraryID = ? AND AN.itemID ${NOT_TRASHED} AND AN.parentItemID ${NOT_TRASHED}
  GROUP BY P.itemID`;

/** Zotero's UTC SQL timestamp (`2024-05-01 12:00:00`) as epoch milliseconds. */
export function sqlTime(value: unknown): number | undefined {
  const text = String(value || "");
  if (!text) { return; }
  const time = Date.parse(`${text.replace(" ", "T")}Z`);
  return Number.isFinite(time) ? time : undefined;
}

export async function paperHighlights(libraryID: number): Promise<Map<string, { count: number; time: number }>> {
  const highlights = new Map<string, { count: number; time: number }>();
  for (const row of (await Zotero.DB.queryAsync(HIGHLIGHTS_SQL, [libraryID]) || []) as
    Array<{ paperKey: string; count: number; added: string }>) {
    const time = sqlTime(row.added);
    if (row.paperKey && time !== undefined) {
      highlights.set(row.paperKey, { count: Number(row.count) || 0, time });
    }
  }
  return highlights;
}
