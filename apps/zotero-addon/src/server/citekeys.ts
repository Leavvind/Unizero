/**
 * Citation keys as an authoring alias for a Zotero item.
 *
 * A citekey is what a user types in another editor (`@danielShortLongHorizon2020`).
 * It is deliberately *not* an identity: Zotero item keys, DOIs, and the Paper
 * catalog own identity, and a citekey changes whenever the metadata it is derived
 * from changes. Two consequences shape this module:
 *
 * - A pinned `Citation Key:` line in Extra always wins. Better BibTeX and Zotero's
 *   own citation-key support both write that line, so honouring it keeps the
 *   add-on compatible with keys users already cite by, and gives them a way to
 *   make a key permanent.
 * - The derived fallback is best effort. It exists so that an unpinned item is
 *   still addressable, not so that anything can be stored under it. Callers that
 *   need durable state must persist `libraryID` + `itemKey`, never the citekey.
 *
 * Derived keys can collide. Resolution reports the collision rather than picking
 * a winner silently, because the honest answer to "which paper is `@smith2020`?"
 * is sometimes "more than one".
 */

import { getExtraValue } from "../modules/itemIdentifiers";

export const CITEKEY_ALIASES = ["Citation Key", "Citekey", "Citation-Key"] as const;

/**
 * The characters a citekey may contain here.
 *
 * Better BibTeX permits more than this, but the inline syntax consumers use
 * (`@key`, `@key.md`, `@key.pdf`) has to know where the key stops. Excluding `.`
 * is what makes the suffix unambiguous; excluding the rest keeps a key from
 * swallowing surrounding punctuation.
 */
const CITEKEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

const TITLE_WORD_COUNT = 4;

/**
 * Words dropped before the title segment is built.
 *
 * The list is short on purpose. It removes the function words that carry no
 * distinguishing information; it is not an attempt to reproduce any particular
 * BibTeX tool's stop-word table, and it must not grow into one, because every
 * addition silently changes every unpinned key.
 */
const STOP_WORDS = new Set([
  "a", "an", "the",
  "and", "or", "but", "nor",
  "as", "at", "by", "for", "from", "in", "into", "of", "on", "onto", "over",
  "to", "with", "within", "without",
  "is", "are", "was", "were", "be", "being", "been",
  "its", "their", "this", "that", "these", "those",
]);

export interface CitekeyLocation {
  libraryID: number;
  itemKey: string;
}

export interface CitekeyResolution extends CitekeyLocation {
  citekey: string;
  /** True when more than one item derives the same key. The first is returned. */
  ambiguous: boolean;
  /** Every location sharing the key, including the returned one. */
  candidates: CitekeyLocation[];
}

export function isValidCitekey(value: string): boolean {
  return CITEKEY_PATTERN.test(String(value || ""));
}

/**
 * The item a location names, or undefined once it is gone.
 *
 * The index can outlive a delete by as long as it takes the notifier to fire, so
 * every read through it has to tolerate a missing item rather than assume one.
 */
export function libraryItem(
  libraryID: number,
  itemKey: string,
): Zotero.Item | undefined {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey) as Zotero.Item | false;
  return item || undefined;
}

/** The pinned key, if the item carries one and it is usable as inline syntax. */
export function pinnedCitekey(item: Zotero.Item): string | undefined {
  const extra = String(item.getField("extra") || "");
  const pinned = getExtraValue(extra, CITEKEY_ALIASES);
  if (!pinned) { return; }
  // A pinned key using characters this syntax cannot express is still the user's
  // key elsewhere; it simply cannot be addressed here, so fall through to the
  // derived key rather than emitting something that will not round-trip.
  return isValidCitekey(pinned) ? pinned : undefined;
}

function firstAuthorSegment(item: Zotero.Item): string {
  const creators = item.getCreators();
  const primary = creators.find((creator) => {
    const type = Zotero.CreatorTypes.getName(creator.creatorTypeID);
    return type === "author";
  }) || creators[0];
  if (!primary) { return "anon"; }
  const surname = String(primary.lastName || primary.firstName || "").trim();
  return asciiWord(surname).toLowerCase() || "anon";
}

function titleSegment(item: Zotero.Item): string {
  const title = String(item.getField("title") || "");
  const words = title
    .split(/[^A-Za-z0-9À-ɏ]+/)
    .map((word) => asciiWord(word))
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word.toLowerCase()))
    .slice(0, TITLE_WORD_COUNT);
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

function yearSegment(item: Zotero.Item): string {
  const date = String(item.getField("date") || "");
  return date.match(/\b(?:1[5-9]|20|21)\d{2}\b/)?.[0] || "";
}

/**
 * Strip everything the citekey syntax cannot carry.
 *
 * Diacritics are folded rather than dropped so that "Müller" stays "Muller"
 * instead of collapsing to "Mller".
 */
function asciiWord(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
}

/** Best-effort key for an item with no pinned one. May collide with another item. */
export function deriveCitekey(item: Zotero.Item): string {
  const key = `${firstAuthorSegment(item)}${titleSegment(item)}${yearSegment(item)}`;
  return isValidCitekey(key) ? key : `item${String(item.key || "").toLowerCase()}`;
}

/** The key this item is addressed by: pinned when present, derived otherwise. */
export function citekeyForItem(item: Zotero.Item): string {
  return pinnedCitekey(item) || deriveCitekey(item);
}

/**
 * Reverse index, rebuilt lazily.
 *
 * Zotero has no query for "the item whose derived key is X" — only pinned keys
 * live in a searchable field — so the index is the only way to resolve the
 * fallback form. It is cached per library and dropped wholesale when any regular
 * item changes, because a single title edit can change one key and un-collide
 * another.
 *
 * Each entry also carries the fields `@` completion ranks on, so a keystroke reads
 * the index instead of every item's fields again.
 */
interface IndexedItem extends CitekeyLocation {
  title: string;
  authors: string[];
  year?: string;
}

type LibraryIndex = Map<string, IndexedItem[]>;

const indexes = new Map<number, LibraryIndex>();
/** One build per library at a time; later callers await it. */
const building = new Map<number, Promise<LibraryIndex>>();
/**
 * Bumped by every invalidation. A build that started before one must not cache
 * its result: it may have read the item that just changed.
 */
let indexGeneration = 0;
let observerID: string | undefined;

async function buildLibraryIndex(libraryID: number): Promise<LibraryIndex> {
  const index: LibraryIndex = new Map();
  const items = await Zotero.Items.getAll(libraryID, true);
  for (const item of items) {
    if (!item.isRegularItem()) { continue; }
    const citekey = citekeyForItem(item);
    const entry: IndexedItem = {
      libraryID,
      itemKey: String(item.key),
      title: String(item.getField("title") || ""),
      authors: item.getCreators()
        .map((creator) => String(creator.lastName || creator.firstName || "").trim())
        .filter(Boolean),
      year: yearSegment(item) || undefined,
    };
    const entries = index.get(citekey);
    if (entries) {
      entries.push(entry);
    } else {
      index.set(citekey, [entry]);
    }
  }
  return index;
}

function libraryIndex(libraryID: number): Promise<LibraryIndex> {
  const cached = indexes.get(libraryID);
  if (cached) { return Promise.resolve(cached); }
  const inFlight = building.get(libraryID);
  if (inFlight) { return inFlight; }

  const generation = indexGeneration;
  const build = buildLibraryIndex(libraryID).then((index) => {
    if (generation === indexGeneration) { indexes.set(libraryID, index); }
    return index;
  }).finally(() => {
    if (building.get(libraryID) === build) { building.delete(libraryID); }
  });
  building.set(libraryID, build);
  return build;
}

/**
 * Libraries a citation may point into. Feeds are excluded: their items are RSS
 * entries Zotero prunes on its own, so a citation to one would not last.
 */
function searchedLibraries(preferred?: number): number[] {
  const all = Zotero.Libraries.getAll()
    .filter((library) => library.libraryType !== "feed")
    .map((library) => Number(library.libraryID))
    .filter((libraryID) => Number.isInteger(libraryID));
  if (preferred === undefined || !all.includes(preferred)) { return all; }
  // A caller that knows the scope should not be given a group-library homonym
  // just because that library happened to load first.
  return [preferred, ...all.filter((libraryID) => libraryID !== preferred)];
}

export async function resolveCitekey(
  citekey: string,
  preferredLibraryID?: number,
): Promise<CitekeyResolution | undefined> {
  if (!isValidCitekey(citekey)) { return; }
  for (const libraryID of searchedLibraries(preferredLibraryID)) {
    const index = await libraryIndex(libraryID);
    const candidates = index.get(citekey);
    if (candidates?.length) {
      return {
        libraryID: candidates[0].libraryID,
        itemKey: candidates[0].itemKey,
        citekey,
        ambiguous: candidates.length > 1,
        candidates: candidates.map(({ libraryID: id, itemKey }) => ({
          libraryID: id,
          itemKey,
        })),
      };
    }
  }
  return undefined;
}

export interface CitekeySuggestion extends CitekeyLocation {
  citekey: string;
  title: string;
  authors: string[];
  year?: string;
}

/**
 * Free-text matches for an editor's `@` completion.
 *
 * The query is **not** restricted to citekeys. Users type what they remember —
 * author, title words, year, or a fragment of the key — and every token in a
 * multi-word query must hit somewhere. Ranking stays crude because the caller
 * shows a short list and the user is still typing:
 *
 *   0  citekey prefix
 *   1  citekey substring
 *   2  author (last or first name) prefix / substring
 *   3  year or title substring
 *
 * Multi-word examples that should work: `richardson accounting`,
 * `why nations fail`, `acemoglu 2012`.
 */
export async function suggestCitekeys(
  query: string,
  limit: number,
  preferredLibraryID?: number,
): Promise<CitekeySuggestion[]> {
  const needle = String(query || "").trim().toLowerCase();
  const scored: { rank: number; suggestion: CitekeySuggestion }[] = [];

  for (const libraryID of searchedLibraries(preferredLibraryID)) {
    const index = await libraryIndex(libraryID);
    for (const [citekey, entries] of index) {
      for (const { libraryID: id, itemKey, title, authors, year } of entries) {
        const rank = rankSuggestion(needle, citekey, title, authors, year);
        if (rank < 0) { continue; }
        scored.push({
          rank,
          suggestion: { libraryID: id, itemKey, citekey, title, authors, year },
        });
      }
    }
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.suggestion.citekey.localeCompare(b.suggestion.citekey))
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.suggestion);
}

function rankSuggestion(
  needle: string,
  citekey: string,
  title: string,
  authors: string[],
  year?: string,
): number {
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (!tokens.length) { return 4; }

  const key = citekey.toLowerCase();
  const titleL = title.toLowerCase();
  const authorNames = authors.map((author) => author.toLowerCase());
  const yearL = (year || "").toLowerCase();

  // Every token must match at least one field; the best (lowest) single-token
  // rank is what we sort by, so a citekey-prefix hit still floats to the top
  // even when the query also carries a year or a title word.
  let best = 99;
  for (const token of tokens) {
    const tokenRank = rankToken(token, key, titleL, authorNames, yearL);
    if (tokenRank < 0) { return -1; }
    if (tokenRank < best) { best = tokenRank; }
  }
  return best;
}

function rankToken(
  token: string,
  key: string,
  titleL: string,
  authorNames: string[],
  yearL: string,
): number {
  if (key.startsWith(token)) { return 0; }
  if (key.includes(token)) { return 1; }

  for (const name of authorNames) {
    if (name.startsWith(token) || name.includes(token)) { return 2; }
  }

  if (yearL && yearL.includes(token)) { return 3; }
  if (titleL.includes(token)) { return 3; }
  return -1;
}

export function invalidateCitekeyIndex(libraryID?: number): void {
  indexGeneration += 1;
  if (libraryID === undefined) {
    indexes.clear();
    return;
  }
  indexes.delete(libraryID);
}

/**
 * Notes, attachments, and annotations derive no key, so their churn — a
 * conversion adding its Raw attachments, say — keeps the index.
 * An item that can no longer be read is treated as relevant.
 */
function touchesRegularItem(id: number | string): boolean {
  const item = Zotero.Items.get(Number(id)) as Zotero.Item | false;
  return !item || item.isRegularItem();
}

/**
 * Drop the index whenever a regular item changes.
 *
 * Registered once per process, alongside the bridge that depends on it. Beyond
 * skipping child items, the observer deliberately ignores which items changed: a derived key depends on
 * title, creators, and date, and a collision depends on every other item, so
 * there is no cheap incremental update that stays correct.
 */
export function registerCitekeyInvalidation(): void {
  if (observerID) { return; }
  observerID = Zotero.Notifier.registerObserver(
    {
      notify(event: string, _type: string, ids: (number | string)[], _extraData: unknown) {
        if (event !== "delete" && !ids.some(touchesRegularItem)) { return; }
        invalidateCitekeyIndex();
      },
    },
    ["item"],
    "unizero-citekeys",
  );
}

export function unregisterCitekeyInvalidation(): void {
  if (!observerID) { return; }
  Zotero.Notifier.unregisterObserver(observerID);
  observerID = undefined;
  invalidateCitekeyIndex();
}
