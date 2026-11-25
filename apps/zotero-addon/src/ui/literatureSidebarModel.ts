/**
 * Row model for the item-pane References / Citations sidebar.
 *
 * Pure: it merges a provider snapshot with the user's excerpts (from UniConnection)
 * into the rows the sidebar draws, decides their order, and filters them for the
 * search box. The DOM and every Zotero call live in literatureSidebar.ts.
 *
 * Order, References: papers this one quotes (in the excerpt note's order) first,
 * then the provider list in its own order. Citations come from the library alone,
 * never a provider: papers quoting this one first, then the other library papers
 * whose cached References contain it, newest first. A paper appears once.
 */

import type { LiteratureCandidate } from "../modules/literatureRelations";
import type { ExcerptRecord } from "../zotero/excerptNoteFormat";

/** A library item as the sidebar shows it. */
export interface PaperSummary {
  libraryID: number;
  itemKey: string;
  itemID: number;
  title: string;
  authors: string[];
  year?: string;
  type?: string;
}

/** A group of passages keyed by the other paper, as UniConnection returns them. */
export interface ExcerptGroupInput {
  scopedKey: string;
  missing: boolean;
  excerpts: ExcerptRecord[];
}

export type RowGroup = "quoted" | "provider" | "library";

export interface SidebarRow {
  /** Stable across re-renders: the scoped item key when known, else the provider position. */
  id: string;
  group: RowGroup;
  /** 1-based position in the provider list, when the row came from it. */
  number?: number;
  candidate?: LiteratureCandidate;
  /** `${libraryID}:${itemKey}` of the library item this row is, when it is one. */
  scopedKey?: string;
  inLibrary: boolean;
  /** An excerpt target that is no longer a live item. */
  missing: boolean;
  title: string;
  authors: string[];
  year?: string;
  type?: string;
  excerpts: ExcerptRecord[];
}

export function scopedKeyOf(summary: { libraryID: number; itemKey: string }): string {
  return `${summary.libraryID}:${summary.itemKey}`;
}

function itemKeyOf(scopedKey: string): string {
  return scopedKey.slice(scopedKey.indexOf(":") + 1);
}

function candidateRow(
  candidate: LiteratureCandidate,
  position: number,
  scopedKey: string | undefined,
  group: RowGroup,
  excerpts: ExcerptRecord[] = [],
): SidebarRow {
  return {
    id: scopedKey || `provider:${position}`,
    group,
    number: candidate.sourceOrder !== undefined ? candidate.sourceOrder + 1 : position + 1,
    candidate,
    scopedKey,
    inLibrary: Boolean(candidate.membership?.inLibrary),
    missing: false,
    title: candidate.title || candidate.text || "",
    authors: candidate.authors || [],
    year: candidate.year,
    type: candidate.type,
    excerpts,
  };
}

function summaryRow(
  scopedKey: string,
  summary: PaperSummary | undefined,
  group: RowGroup,
  excerpts: ExcerptRecord[],
  missing: boolean,
): SidebarRow {
  return {
    id: scopedKey,
    group,
    scopedKey,
    inLibrary: Boolean(summary) && !missing,
    missing: missing || !summary,
    title: summary?.title || (missing || !summary ? `Missing item ${itemKeyOf(scopedKey)}` : ""),
    authors: summary?.authors || [],
    year: summary?.year,
    type: summary?.type,
    excerpts,
  };
}

/**
 * Merge the provider list with the excerpt groups.
 *
 * `keyOf` maps a candidate to its library item's scoped key (undefined when not in
 * the library); `summaryOf` describes a library item that has excerpts but no
 * provider row. The first candidate for a given item wins; later duplicates go.
 */
function mergeRows(
  candidates: LiteratureCandidate[],
  groups: ExcerptGroupInput[],
  keyOf: (candidate: LiteratureCandidate) => string | undefined,
  summaryOf: (scopedKey: string) => PaperSummary | undefined,
): SidebarRow[] {
  const byKey = new Map<string, { candidate: LiteratureCandidate; position: number }>();
  const provider: { candidate: LiteratureCandidate; position: number; key?: string }[] = [];
  candidates.forEach((candidate, position) => {
    const key = keyOf(candidate);
    if (key) {
      if (byKey.has(key)) { return; }
      byKey.set(key, { candidate, position });
    }
    provider.push({ candidate, position, key });
  });

  const quoted: SidebarRow[] = [];
  const quotedKeys = new Set<string>();
  for (const group of groups) {
    if (quotedKeys.has(group.scopedKey)) { continue; }
    quotedKeys.add(group.scopedKey);
    const match = byKey.get(group.scopedKey);
    quoted.push(match && !group.missing
      ? candidateRow(match.candidate, match.position, group.scopedKey, "quoted", group.excerpts)
      : summaryRow(group.scopedKey, summaryOf(group.scopedKey), "quoted", group.excerpts, group.missing));
  }

  const rest = provider
    .filter((entry) => !entry.key || !quotedKeys.has(entry.key))
    .map((entry) => candidateRow(entry.candidate, entry.position, entry.key, "provider"));
  return [...quoted, ...rest];
}

/** References: papers this one quotes first, then the provider list. */
export function referenceRows(
  candidates: LiteratureCandidate[],
  excerptsFrom: ExcerptGroupInput[],
  keyOf: (candidate: LiteratureCandidate) => string | undefined,
  summaryOf: (scopedKey: string) => PaperSummary | undefined,
): SidebarRow[] {
  return mergeRows(candidates, excerptsFrom, keyOf, summaryOf);
}

/**
 * Citations from the library alone: papers quoting this one (note order), then the
 * other `citing` papers (UniConnection.relationsOf), newest first. A citing paper
 * that is no longer a live item (`summaryOf` undefined) is left out.
 */
export function citationRows(
  excerptsAbout: ExcerptGroupInput[],
  citing: string[],
  summaryOf: (scopedKey: string) => PaperSummary | undefined,
): SidebarRow[] {
  const quoted = mergeRows([], excerptsAbout, () => undefined, summaryOf);
  const listed = new Set(quoted.map((row) => row.scopedKey));
  const others: SidebarRow[] = [];
  for (const key of citing) {
    if (listed.has(key)) { continue; }
    listed.add(key);
    const summary = summaryOf(key);
    if (summary) { others.push(summaryRow(key, summary, "library", [], false)); }
  }
  others.sort((left, right) =>
    (right.year || "").localeCompare(left.year || "")
    || rowCredit(left).localeCompare(rowCredit(right))
    || left.title.localeCompare(right.title));
  return [...quoted, ...others];
}

/**
 * Provider Citations (UniConnection full only) not already listed from the library,
 * in the provider's order. A candidate whose library item is already a row goes.
 */
export function providerCitationRows(
  candidates: LiteratureCandidate[],
  listed: SidebarRow[],
  keyOf: (candidate: LiteratureCandidate) => string | undefined,
): SidebarRow[] {
  const known = new Set(listed.map((row) => row.scopedKey).filter(Boolean));
  const rows: SidebarRow[] = [];
  candidates.forEach((candidate, position) => {
    const key = keyOf(candidate);
    if (key) {
      if (known.has(key)) { return; }
      known.add(key);
    }
    rows.push(candidateRow(candidate, position, key, "provider"));
  });
  return rows;
}

/** Library search hits not already listed (and not the paper itself), as rows. */
export function libraryRows(
  hits: PaperSummary[],
  listed: SidebarRow[],
  selfKey: string,
): SidebarRow[] {
  const known = new Set(listed.map((row) => row.scopedKey).filter(Boolean));
  known.add(selfKey);
  const rows: SidebarRow[] = [];
  for (const hit of hits) {
    const key = scopedKeyOf(hit);
    if (known.has(key)) { continue; }
    known.add(key);
    rows.push(summaryRow(key, hit, "library", [], false));
  }
  return rows;
}

/** Words that join author names (`Ball and Brown`, `Ball & Brown`, `Ball et al.`). */
const CONNECTORS = new Set(["and", "&", "et", "al", "al.", "和", "与", "及"]);

/**
 * Search words of a query. Name connectors are dropped, since they are only
 * display glue and never appear in a row's own text; a query made of nothing
 * else (`al`) is kept as typed.
 */
export function searchTokens(query: string): string[] {
  const tokens = query.toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
  const words = tokens.filter((token) => !CONNECTORS.has(token));
  return words.length ? words : tokens;
}

function haystack(row: SidebarRow): string {
  return [
    row.title,
    row.candidate?.text,
    row.authors.join(" "),
    row.year,
    row.candidate?.primaryVenue,
    ...row.excerpts.map((excerpt) => excerpt.text),
  ].filter(Boolean).join(" ").toLowerCase();
}

/** Rows containing every token of the query, in their existing order. */
export function filterRows(rows: SidebarRow[], query: string): SidebarRow[] {
  const tokens = searchTokens(query);
  if (!tokens.length) { return rows; }
  return rows.filter((row) => {
    const text = haystack(row);
    return tokens.every((token) => text.includes(token));
  });
}

/** `Smith`, `Smith & Lee`, `Smith et al.` from full author names. */
export function shortAuthors(authors: string[]): string {
  const surname = (name: string) => name.trim().split(/\s+/).pop() || "";
  const names = authors.filter((name) => name.trim());
  if (!names.length) { return ""; }
  if (names.length === 1) { return surname(names[0]); }
  if (names.length === 2) { return `${surname(names[0])} & ${surname(names[1])}`; }
  return `${surname(names[0])} et al.`;
}

/** The row's one-line credit: `Smith et al. (2014)`. */
export function rowCredit(row: SidebarRow): string {
  const authors = shortAuthors(row.authors);
  if (authors && row.year) { return `${authors} (${row.year})`; }
  return authors || row.year || "";
}
