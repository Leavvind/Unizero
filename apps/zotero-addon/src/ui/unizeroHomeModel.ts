/**
 * Row model for Uniconnection's two columns (docs/UNICONNECTION.md §4.1).
 *
 * Pure: it turns the paper-to-paper mentions written in papers' Raw and Canvas
 * (citing → cited, each with its evidence units) and the papers' annotation times
 * into each column's rows. Partners are only these written mentions, never the
 * providers' References lists.
 *
 * References (left): the papers being worked on, latest activity first — a mention
 * written in the paper's Raw or Canvas, an annotation made — each with the papers it
 * mentions. Citations (right): papers mentioned by others, each with who mentions it
 * — other papers, and Obsidian Vault notes — most recently mentioned first. A Vault
 * note is never a row of its own: it has no References.
 */

export type HomeColumn = "references" | "citations";
export type HomeSort = "default" | "count" | "dateAdded" | "year";
export type ActivityKind = "mention" | "highlight";

/** A library item as Uniconnection shows it. */
export interface PaperSummary {
  libraryID: number;
  itemKey: string;
  itemID: number;
  title: string;
  authors: string[];
  year?: string;
  type?: string;
}

export interface HomePaper extends PaperSummary {
  /** Epoch ms the item was added to Zotero. */
  dateAdded?: number;
  venue?: string;
}

/** An Obsidian Vault note that mentions papers, as the plugin reported it. */
export interface HomeNote {
  vaultID: string;
  vaultName: string;
  path: string;
  title: string;
  format: "md" | "canvas";
}

/** Where a mention is written: the citing paper's Raw or Canvas, or a Vault note. */
export type HomeMentionSource =
  | { purpose: "raw" | "canvas"; attachmentKey: string }
  | { purpose: "vault"; note: HomeNote };

/** One evidence unit in the citing paper's Raw or Canvas, or a Vault note, that mentions the cited paper. */
export type HomeMention = HomeMentionSource & {
  line: number;
  nodeId?: string;
  text: string;
  /** `zotero://open-pdf` links written in the same unit. */
  pdf: string[];
  /** Epoch ms the Raw, Canvas or note last changed. */
  time?: number;
};

/** All mentions of one paper in another's Raw and Canvas, or in one Vault note. */
export interface HomePair {
  /** The citing paper's scoped key, or the Vault note's `vault:…` key. */
  citing: string;
  cited: string;
  /** The cited paper is not (or no longer) in the library. */
  missing: boolean;
  mentions: HomeMention[];
  /** Set when the citing side is a Vault note rather than a paper. */
  note?: HomeNote;
}

/** One paper on the other end of a row: what the row's paper mentions, or who mentions it. */
export interface HomePartner {
  scopedKey: string;
  /** Undefined when the paper is not in the library, and for a Vault note. */
  paper?: HomePaper;
  /** The Vault note that mentions the row's paper (Citations only). */
  note?: HomeNote;
  mentions: HomeMention[];
  /** Epoch ms of the newest change to a note holding one of the mentions. */
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
  /** Mentions across all partners. */
  mentions: number;
  /** Annotations on the paper's own attachments (References column). */
  highlights: number;
  /** The newest event that put the row here (References column). */
  activity?: HomeActivity;
  /** Epoch ms the row sorts by by default: see homeColumns. */
  time?: number;
}

export interface HomeTimes {
  /** Paper's item key → its annotations: how many, and the newest. */
  highlights: ReadonlyMap<string, { count: number; time: number }>;
}

/**
 * The papers in scope, described only on demand: Uniconnection's rows are the few
 * papers with activity, so the rest of the library is never summarised.
 */
export interface HomeScope {
  keys: Iterable<string>;
  paper(scopedKey: string): HomePaper;
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

/** A pair's newest mention, dated by the note that holds it. */
function pairTime(pair: HomePair): number | undefined {
  return latest(pair.mentions.map((mention) => mention.time));
}

/** The newest of a paper's events, or undefined when nothing happened to it. */
function activityOf(scopedKey: string, pairs: HomePair[] | undefined, times: HomeTimes): HomeActivity | undefined {
  const events: Array<[ActivityKind, number | undefined]> = [
    ["mention", latest((pairs || []).map(pairTime))],
    ["highlight", times.highlights.get(itemKeyOf(scopedKey))?.time],
  ];
  let best: HomeActivity | undefined;
  for (const [kind, time] of events) {
    if (time !== undefined && (!best || time > best.time)) { best = { kind, time }; }
  }
  return best;
}

/**
 * Both columns' rows for the papers in scope. `summaryOf` describes any library
 * paper (partners may lie outside the scope, even in another library); undefined
 * means it is not in Zotero.
 *
 * A References row is any paper in scope with activity (see activityOf), timed by
 * its newest event; a Citations row is any paper in scope another paper mentions,
 * timed by the newest note mentioning it.
 */
export function homeColumns(
  papers: HomePaper[] | HomeScope,
  pairs: HomePair[],
  times: HomeTimes,
  summaryOf: (scopedKey: string) => HomePaper | undefined,
): Record<HomeColumn, HomeRow[]> {
  const inScope = scopeOf(papers);
  const byCiting = new Map<string, HomePair[]>();
  const byCited = new Map<string, HomePair[]>();
  const add = (groups: Map<string, HomePair[]>, key: string, pair: HomePair) => {
    const list = groups.get(key);
    if (list) { list.push(pair); } else { groups.set(key, [pair]); }
  };
  for (const pair of pairs) {
    add(byCiting, pair.citing, pair);
    if (!pair.missing) { add(byCited, pair.cited, pair); }
  }
  const partner = (scopedKey: string, pair: HomePair): HomePartner => {
    const note = pair.note && scopedKey === pair.citing ? pair.note : undefined;
    return {
      scopedKey,
      paper: note ? undefined : inScope.get(scopedKey) || summaryOf(scopedKey),
      ...(note ? { note } : {}),
      mentions: pair.mentions,
      time: pairTime(pair),
    };
  };
  const row = (scopedKey: string, partners: HomePartner[], extra: Partial<HomeRow>): HomeRow => ({
    paper: inScope.get(scopedKey)!,
    scopedKey,
    // Most recent first; ties keep the given order.
    partners: partners.map((each, order) => ({ each, order }))
      .sort((left, right) => newer(left.each.time, right.each.time) || left.order - right.order)
      .map(({ each }) => each),
    mentions: partners.reduce((sum, each) => sum + each.mentions.length, 0),
    highlights: 0,
    ...extra,
  });

  const references: HomeRow[] = [];
  const citations: HomeRow[] = [];
  for (const scopedKey of inScope.keys()) {
    const mentioning = byCiting.get(scopedKey);
    const activity = activityOf(scopedKey, mentioning, times);
    if (activity || mentioning) {
      references.push(row(scopedKey, (mentioning || []).map((pair) => partner(pair.cited, pair)), {
        highlights: times.highlights.get(itemKeyOf(scopedKey))?.count || 0,
        activity,
        time: activity?.time,
      }));
    }
    const mentionedBy = byCited.get(scopedKey);
    if (mentionedBy) {
      const partners = mentionedBy.map((pair) => partner(pair.citing, pair));
      citations.push(row(scopedKey, partners, { time: latest(partners.map((each) => each.time)) }));
    }
  }
  return { references, citations };
}

/** Scope as a lookup that summarises each paper at most once, and only when asked. */
function scopeOf(papers: HomePaper[] | HomeScope): {
  keys(): Iterable<string>;
  get(scopedKey: string): HomePaper | undefined;
} {
  if (Array.isArray(papers)) {
    const byKey = new Map(papers.map((paper) => [`${paper.libraryID}:${paper.itemKey}`, paper]));
    return { keys: () => byKey.keys(), get: (scopedKey) => byKey.get(scopedKey) };
  }
  const keys = new Set(papers.keys);
  const described = new Map<string, HomePaper>();
  return {
    keys: () => keys,
    get: (scopedKey) => {
      if (!keys.has(scopedKey)) { return; }
      let paper = described.get(scopedKey);
      if (!paper) {
        paper = papers.paper(scopedKey);
        described.set(scopedKey, paper);
      }
      return paper;
    },
  };
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

/** A paper's one-line credit: `Smith et al. (2014)`. */
export function paperCredit(paper?: { authors: string[]; year?: string }): string {
  if (!paper) { return ""; }
  const authors = shortAuthors(paper.authors);
  if (authors && paper.year) { return `${authors} (${paper.year})`; }
  return authors || paper.year || "";
}

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

function byTitle(left: HomeRow, right: HomeRow): number {
  return paperCredit(left.paper).localeCompare(paperCredit(right.paper))
    || left.paper.title.localeCompare(right.paper.title)
    || left.scopedKey.localeCompare(right.scopedKey);
}

const ORDER: Record<HomeSort, (left: HomeRow, right: HomeRow) => number> = {
  default: (left, right) => newer(left.time, right.time) || newer(left.paper.dateAdded, right.paper.dateAdded)
    || byTitle(left, right),
  count: (left, right) => right.partners.length - left.partners.length || right.mentions - left.mentions
    || newer(left.time, right.time) || byTitle(left, right),
  dateAdded: (left, right) => newer(left.paper.dateAdded, right.paper.dateAdded) || byTitle(left, right),
  year: (left, right) => (right.paper.year || "").localeCompare(left.paper.year || "") || byTitle(left, right),
};

/** Rows are rebuilt on every load, so a row's search text can be kept for its lifetime. */
const haystacks = new WeakMap<HomeRow, string>();

function haystack(row: HomeRow): string {
  const known = haystacks.get(row);
  if (known !== undefined) { return known; }
  const text = searchText(row);
  haystacks.set(row, text);
  return text;
}

function searchText(row: HomeRow): string {
  const paperText = (paper?: HomePaper) => paper
    ? [paper.title, paper.authors.join(" "), paper.year, paper.venue].filter(Boolean).join(" ")
    : "";
  return [
    paperText(row.paper),
    ...row.partners.map((each) => [paperText(each.paper), each.note ? `${each.note.title} ${each.note.path}` : "",
      ...each.mentions.map((mention) => mention.text)].join(" ")),
  ].join(" ").toLowerCase();
}

/** One column's rows, searched (paper, partners, mention text) and ordered. */
export function columnRows(rows: HomeRow[], query: HomeQuery): HomeRow[] {
  const tokens = searchTokens(query.query);
  return rows
    .filter((row) => !tokens.length || tokens.every((token) => haystack(row).includes(token)))
    .sort(ORDER[query.sort]);
}
