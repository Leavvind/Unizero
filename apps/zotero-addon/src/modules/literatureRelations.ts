import { edgeIdentity } from "./edgeIdentity";
import { readItemPaperIdentifiers } from "./itemIdentifiers";
import type { RelationSourceKey } from "./mergeRelations";

export type LiteratureRelationKind = "references" | "citations";

/** One provider's contribution to a relation, as the explorer's source picker sees it. */
export interface LiteratureSourceView {
  key: RelationSourceKey;
  name: string;
  status: string;
  count: number;
  total: number;
  hasMore: boolean;
}

export interface LibraryMembership {
  inLibrary: boolean;
  libraryID: number;
  itemID?: number;
}

export interface LiteratureCandidate {
  identifiers: ItemBaseInfo["identifiers"];
  title: string;
  authors: string[];
  year?: string;
  type?: string;
  text?: string;
  url?: string;
  primaryVenue?: string;
  publicationLevel?: string;
  abstract?: string;
  citationCount?: number;
  influentialCitationCount?: number;
  isInfluential?: boolean;
  intents?: string[];
  contexts?: string[];
  sourceOrder?: number;
  source?: string;
  membership: LibraryMembership;
}

export interface LiteratureSnapshot {
  kind: LiteratureRelationKind;
  seed: {
    libraryID: number;
    itemKey: string;
    title: string;
  };
  source: string;
  total: number;
  loaded: number;
  hasMore: boolean;
  /** The merged, deduplicated list — what the "Combined" source shows. */
  items: LiteratureCandidate[];
  /** Per-source summary for the source picker; empty when no breakdown exists. */
  sources: LiteratureSourceView[];
  /** Each source's own candidate list, so switching sources needs no round trip. */
  bySource: Partial<Record<RelationSourceKey, LiteratureCandidate[]>>;
}

export interface LiteratureCollectionScope {
  libraryID: number;
  collectionID?: number;
  name: string;
}

export interface LiteratureLoadStatus {
  loaded: boolean;
  count: number;
  total: number;
}

export interface LiteratureCollectionPaper {
  libraryID: number;
  itemID: number;
  itemKey: string;
  title: string;
  creators: string[];
  year?: string;
  dateAdded: string;
  publicationTitle?: string;
  hasPDF: boolean;
  hasMarkdown: boolean;
  references: LiteratureLoadStatus;
  citations: LiteratureLoadStatus;
}

export interface LiteratureCollectionSnapshot {
  scope: LiteratureCollectionScope;
  items: LiteratureCollectionPaper[];
}

function normalTitle(value: unknown): string {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

interface LibraryMembershipIndex {
  byIdentity: Map<string, Zotero.Item>;
  byTitle: Map<string, Zotero.Item>;
}

/**
 * A full library scan and index rebuild is the expensive part of membership
 * resolution, and the explorer resolves membership repeatedly within one session
 * (snapshot plus section marking for a view, then again as the user clicks through
 * papers). The index is memoised per library for a short window so those bursts
 * reuse one scan, while the TTL still lets outside edits surface on their own.
 * Our own imports call {@link invalidateLibraryMembership} so a freshly added
 * paper is never reported as absent.
 */
const MEMBERSHIP_INDEX_TTL_MS = 10_000;
const membershipIndexCache = new Map<
  number,
  { builtAt: number; index: LibraryMembershipIndex }
>();

export function invalidateLibraryMembership(libraryID?: number): void {
  if (libraryID === undefined) {
    membershipIndexCache.clear();
  } else {
    membershipIndexCache.delete(libraryID);
  }
}

async function libraryMembershipIndex(
  libraryID: number,
): Promise<LibraryMembershipIndex> {
  const cached = membershipIndexCache.get(libraryID);
  if (cached && Date.now() - cached.builtAt < MEMBERSHIP_INDEX_TTL_MS) {
    return cached.index;
  }
  const items = (await Zotero.Items.getAll(libraryID))
    .filter((item: Zotero.Item) => item.isRegularItem?.());
  const byIdentity = new Map<string, Zotero.Item>();
  const byTitle = new Map<string, Zotero.Item>();

  for (const item of items) {
    const identifiers = readItemPaperIdentifiers(item);
    if (identifiers.doi) {
      byIdentity.set(`doi:${identifiers.doi.toLowerCase()}`, item);
    }
    if (identifiers.semanticScholarPaperId) {
      byIdentity.set(`s2:${identifiers.semanticScholarPaperId.toLowerCase()}`, item);
    }
    const title = normalTitle(item.getField("title"));
    if (title.length >= 12 && !byTitle.has(title)) {
      byTitle.set(title, item);
    }
  }

  const index = { byIdentity, byTitle };
  membershipIndexCache.set(libraryID, { builtAt: Date.now(), index });
  return index;
}

/**
 * Resolve membership in the seed paper's library in one pass.
 *
 * Membership is deliberately derived from Zotero rather than provider caches:
 * those are long lived, while users can add or remove a paper at any moment.
 * Keeping the two states separate prevents a stale API shard from claiming that an
 * item is still absent after the user has imported it. The underlying library
 * index is memoised — see {@link libraryMembershipIndex}.
 */
export async function resolveLibraryMembership(
  libraryID: number,
  entries: ItemBaseInfo[],
): Promise<Map<ItemBaseInfo, Zotero.Item | undefined>> {
  const result = new Map<ItemBaseInfo, Zotero.Item | undefined>();
  const { byIdentity, byTitle } = await libraryMembershipIndex(libraryID);

  for (const entry of entries) {
    const identity = edgeIdentity(entry);
    const title = normalTitle(entry.title || entry.text);
    const match = (identity && byIdentity.get(identity)) ||
      (title.length >= 12 ? byTitle.get(title) : undefined);
    if (match) { entry._item = match; }
    result.set(entry, match);
  }
  return result;
}

export function toLiteratureCandidate(
  entry: ItemBaseInfo,
  libraryID: number,
  item?: Zotero.Item,
): LiteratureCandidate {
  return {
    identifiers: { ...(entry.identifiers || {}) },
    title: String(entry.title || entry.text || ""),
    authors: Array.isArray(entry.authors) ? [...entry.authors] : [],
    year: entry.year ? String(entry.year) : undefined,
    type: entry.type,
    text: entry.text,
    url: entry.url,
    primaryVenue: entry.primaryVenue,
    publicationLevel: entry.publicationLevel,
    abstract: entry.abstract,
    citationCount: typeof entry.citations === "number" ? entry.citations : undefined,
    influentialCitationCount: typeof entry.influentialCitationCount === "number"
      ? entry.influentialCitationCount
      : undefined,
    isInfluential: typeof entry.isInfluential === "boolean" ? entry.isInfluential : undefined,
    intents: Array.isArray(entry.intents) ? [...entry.intents] : undefined,
    contexts: Array.isArray(entry.contexts) ? [...entry.contexts] : undefined,
    sourceOrder: typeof entry.number === "number" ? entry.number : undefined,
    source: entry.source || entry.producedBy,
    membership: {
      inLibrary: Boolean(item),
      libraryID,
      itemID: item?.id,
    },
  };
}

/**
 * The narrow section needs a stable, explainable preview rather than a second
 * ranking model. Influential edges lead; global citation count breaks ties; the
 * source order is the final deterministic fallback.
 */
export function previewEntries(entries: ItemBaseInfo[], limit = 5): ItemBaseInfo[] {
  return [...entries]
    .sort((left, right) => {
      const influential = Number(Boolean(right.isInfluential)) - Number(Boolean(left.isInfluential));
      if (influential) { return influential; }
      const influentialCount = Number(right.influentialCitationCount || 0) -
        Number(left.influentialCitationCount || 0);
      if (influentialCount) { return influentialCount; }
      const citations = Number(right.citations || 0) - Number(left.citations || 0);
      if (citations) { return citations; }
      return Number(left.number || Number.MAX_SAFE_INTEGER) -
        Number(right.number || Number.MAX_SAFE_INTEGER);
    })
    .slice(0, limit);
}
