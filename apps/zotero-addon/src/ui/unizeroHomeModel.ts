/**
 * Row model for Unizero Home's two columns (docs/UNICONNECTION.md §5.4).
 *
 * Pure: it turns the library's excerpt pairs (citing → cited, with the passages the
 * user attached) and the papers' activity times into each column's rows. Partners are
 * only these hand-made connections, never the providers' References lists.
 *
 * References (left): the papers the user has been working on, latest activity first
 * — a highlight made, a passage attached, a note edited, References loaded — each
 * with the papers it quoted. Citations (right): papers quoted by others, each with
 * who quoted it, most recently cited first.
 */

import { rowCredit, searchTokens, type PaperSummary } from "./literatureSidebarModel";

export type HomeColumn = "references" | "citations";
export type HomeSort = "default" | "count" | "dateAdded" | "year";
export type ActivityKind = "highlight" | "excerpt" | "note" | "references";

export interface HomePaper extends PaperSummary {
  /** Epoch ms the item was added to Zotero. */
  dateAdded?: number;
  venue?: string;
}

export interface HomeExcerpt {
  annotationKey: string;
  attachmentKey?: string;
  pageIndex?: number;
  pageLabel?: string;
  text: string;
}

/** UniConnection.excerptPairs, as Home reads it. */
export interface HomePair {
  citing: string;
  cited: string;
  missing: boolean;
  excerpts: HomeExcerpt[];
}

/** One paper on the other end of a row: what the row's paper quoted, or who quoted it. */
export interface HomePartner {
  scopedKey: string;
  /** Undefined when the paper is no longer in the library. */
  paper?: HomePaper;
  excerpts: HomeExcerpt[];
  /** Epoch ms of the newest passage between the two. */
  time?: number;
}

export interface HomeActivity {
  kind: ActivityKind;
  time: number;
}

export interface HomeRow {
  paper: HomePaper;
  scopedKey: string;
  partners: HomePartner[];
  /** Passages across all partners. */
  quotes: number;
  /** Annotations on the paper's own attachments (References column). */
  highlights: number;
  /** The newest event that put the row here (References column). */
  activity?: HomeActivity;
  /** Epoch ms the row sorts by by default: see homeColumns. */
  time?: number;
}

export interface HomeTimes {
  /** Citing paper's item key → its excerpt note's last change. */
  notes: ReadonlyMap<string, number>;
  /** Annotation key → when the highlight was made. */
  annotations: ReadonlyMap<string, number>;
  /** Paper's item key → its annotations: how many, and the newest. */
  highlights: ReadonlyMap<string, { count: number; time: number }>;
  /** Paper's item key → latest change of its own (non-excerpt) child notes. */
  userNotes: ReadonlyMap<string, number>;
  /** Scoped key → when the paper's References cache was saved. */
  references: ReadonlyMap<string, number>;
}

export interface HomeQuery {
  column: HomeColumn;
  sort: HomeSort;
  query: string;
}

function itemKeyOf(scopedKey: string): string {
  return scopedKey.slice(scopedKey.indexOf(":") + 1);
}

function latest(values: Array<number | undefined>): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length ? Math.max(...known) : undefined;
}

function newer(left?: number, right?: number): number {
  if (left === right) { return 0; }
  if (left === undefined) { return 1; }
  if (right === undefined) { return -1; }
  return right - left;
}

/**
 * A pair's newest passage. A passage whose highlight was deleted has no time; the
 * note's time is not borrowed for it, since that would date it to the note's latest
 * edit, which may concern another paper.
 */
function pairTime(pair: HomePair, times: HomeTimes): number | undefined {
  return latest(pair.excerpts.map((excerpt) => times.annotations.get(excerpt.annotationKey)));
}

/**
 * The newest of a paper's events, or undefined when nothing happened to it. The
 * excerpt note's time counts only while the paper still quotes something: a note
 * whose passages were all removed is no "Quoted" activity.
 */
function activityOf(scopedKey: string, pairs: HomePair[] | undefined, times: HomeTimes): HomeActivity | undefined {
  const itemKey = itemKeyOf(scopedKey);
  const quoted = pairs?.length
    ? times.notes.get(itemKey) ?? latest(pairs.map((pair) => pairTime(pair, times)))
    : undefined;
  const events: Array<[ActivityKind, number | undefined]> = [
    ["excerpt", quoted],
    ["highlight", times.highlights.get(itemKey)?.time],
    ["note", times.userNotes.get(itemKey)],
    ["references", times.references.get(scopedKey)],
  ];
  let best: HomeActivity | undefined;
  for (const [kind, time] of events) {
    if (time !== undefined && (!best || time > best.time)) { best = { kind, time }; }
  }
  return best;
}

/**
 * Both columns' rows for the papers in scope. `summaryOf` describes any library
 * paper (partners may lie outside the scope); undefined means it is gone.
 *
 * A References row is any paper in scope with activity (see activityOf), timed by
 * its newest event; a Citations row is any paper in scope another paper quotes, timed
 * by the newest passage quoting it.
 */
export function homeColumns(
  papers: HomePaper[],
  pairs: HomePair[],
  times: HomeTimes,
  summaryOf: (scopedKey: string) => HomePaper | undefined,
): Record<HomeColumn, HomeRow[]> {
  const inScope = new Map(papers.map((paper) => [`${paper.libraryID}:${paper.itemKey}`, paper]));
  const byCiting = new Map<string, HomePair[]>();
  const byCited = new Map<string, HomePair[]>();
  for (const pair of pairs) {
    byCiting.set(pair.citing, [...(byCiting.get(pair.citing) || []), pair]);
    if (!pair.missing) { byCited.set(pair.cited, [...(byCited.get(pair.cited) || []), pair]); }
  }
  const partner = (scopedKey: string, pair: HomePair): HomePartner => ({
    scopedKey,
    paper: inScope.get(scopedKey) || summaryOf(scopedKey),
    excerpts: pair.excerpts,
    time: pairTime(pair, times),
  });
  const row = (scopedKey: string, partners: HomePartner[], extra: Partial<HomeRow>): HomeRow => ({
    paper: inScope.get(scopedKey)!,
    scopedKey,
    // Most recent first; ties keep note order.
    partners: partners.map((each, order) => ({ each, order }))
      .sort((left, right) => newer(left.each.time, right.each.time) || left.order - right.order)
      .map(({ each }) => each),
    quotes: partners.reduce((sum, each) => sum + each.excerpts.length, 0),
    highlights: 0,
    ...extra,
  });

  const references: HomeRow[] = [];
  const citations: HomeRow[] = [];
  for (const scopedKey of inScope.keys()) {
    const quoting = byCiting.get(scopedKey);
    const activity = activityOf(scopedKey, quoting, times);
    if (activity || quoting) {
      references.push(row(scopedKey, (quoting || []).map((pair) => partner(pair.cited, pair)), {
        highlights: times.highlights.get(itemKeyOf(scopedKey))?.count || 0,
        activity,
        time: activity?.time,
      }));
    }
    const quotedBy = byCited.get(scopedKey);
    if (quotedBy) {
      const partners = quotedBy.map((pair) => partner(pair.citing, pair));
      citations.push(row(scopedKey, partners, { time: latest(partners.map((each) => each.time)) }));
    }
  }
  return { references, citations };
}

function credit(paper?: { authors: string[]; year?: string }): string {
  return paper ? rowCredit({ authors: paper.authors, year: paper.year } as any) : "";
}

function byTitle(left: HomeRow, right: HomeRow): number {
  return credit(left.paper).localeCompare(credit(right.paper))
    || left.paper.title.localeCompare(right.paper.title)
    || left.scopedKey.localeCompare(right.scopedKey);
}

const ORDER: Record<HomeSort, (left: HomeRow, right: HomeRow) => number> = {
  default: (left, right) => newer(left.time, right.time) || newer(left.paper.dateAdded, right.paper.dateAdded)
    || byTitle(left, right),
  count: (left, right) => right.partners.length - left.partners.length || right.quotes - left.quotes
    || newer(left.time, right.time) || byTitle(left, right),
  dateAdded: (left, right) => newer(left.paper.dateAdded, right.paper.dateAdded) || byTitle(left, right),
  year: (left, right) => (right.paper.year || "").localeCompare(left.paper.year || "") || byTitle(left, right),
};

function haystack(row: HomeRow): string {
  const paperText = (paper?: HomePaper) => paper
    ? [paper.title, paper.authors.join(" "), paper.year, paper.venue].filter(Boolean).join(" ")
    : "";
  return [
    paperText(row.paper),
    ...row.partners.map((each) => [paperText(each.paper), ...each.excerpts.map((excerpt) => excerpt.text)].join(" ")),
  ].join(" ").toLowerCase();
}

/** One column's rows, searched (paper, partners, passages) and ordered. */
export function columnRows(rows: HomeRow[], query: HomeQuery): HomeRow[] {
  const tokens = searchTokens(query.query);
  return rows
    .filter((row) => !tokens.length || tokens.every((token) => haystack(row).includes(token)))
    .sort(ORDER[query.sort]);
}
