/**
 * Wire shapes for the localhost bridge.
 *
 * These types are the contract an external editor reads. They are deliberately
 * flatter and smaller than the internal `LiteratureSnapshot`: a consumer outside
 * this process must not have to understand per-source breakdowns, provider
 * pagination state, or the catalog's retention vocabulary in order to render a
 * paper. Adding a field is compatible; renaming or removing one is not, and the
 * `api` number in the ping payload is what a consumer checks before trusting any
 * of it.
 */

import {
  readItemPaperIdentifiers,
} from "../modules/itemIdentifiers";
import type { LiteratureCandidate, LiteratureSnapshot } from "../modules/literatureRelations";
import {
  markdownAttachment,
  pdfAttachment,
} from "../zotero/literatureCollectionAdapter";
import { libraryScope } from "../zotero/libraryScope";
import { readMarkdownLink } from "../zotero/markdownLinkRegistry";

/** Incremented only when an existing field changes meaning or disappears. */
export const BRIDGE_API_VERSION = 1;

export interface BridgePaperLinks {
  /** Always present: selects the item in Zotero's own window. */
  zoteroSelect: string;
  /** Present when the item has a PDF attachment. */
  zoteroPdf?: string;
  /** The user-editable Obsidian URL recorded at conversion time, when set. */
  markdown?: string;
  /** True when a Markdown attachment exists even though no URL was recorded. */
  hasMarkdownAttachment: boolean;
}

export interface BridgePaper {
  citekey: string;
  citekeyPinned: boolean;
  /** True when more than one library item derives this key. */
  ambiguous: boolean;
  libraryID: number;
  itemKey: string;
  title: string;
  authors: string[];
  year?: string;
  itemType: string;
  venue?: string;
  abstract?: string;
  doi?: string;
  arxiv?: string;
  semanticScholarPaperId?: string;
  citationCount?: number;
  links: BridgePaperLinks;
}

export interface BridgeRelatedPaper {
  title: string;
  authors: string[];
  year?: string;
  doi?: string;
  arxiv?: string;
  url?: string;
  venue?: string;
  citationCount?: number;
  isInfluential?: boolean;
  /** Catalog identity, once a snapshot has observed this result. */
  paperID?: string;
  inLibrary: boolean;
  /** Set when `inLibrary` — with `itemKey`, the durable address for notes. */
  libraryID?: number;
  /** Set when `inLibrary`, so the consumer can link straight into Zotero. */
  itemKey?: string;
  /** Convenience alias when the library item has one; not the note address. */
  citekey?: string;
}

export interface BridgeRelations {
  libraryID: number;
  itemKey: string;
  /** Convenience alias for display; notes address the item by libraryID/itemKey. */
  citekey: string;
  kind: "references" | "citations" | "relation";
  /**
   * False when nothing is cached for this paper and no fetch was requested.
   * The consumer shows a prompt rather than a "no results" list — opening a note
   * is not an instruction to call the providers.
   */
  loaded: boolean;
  source: string;
  total: number;
  count: number;
  hasMore: boolean;
  items: BridgeRelatedPaper[];
}

function stringField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field as Parameters<Zotero.Item["getField"]>[0]) || "");
  } catch {
    // Zotero throws for a field this item type does not define. An absent field
    // and an empty one are the same thing to a reader.
    return "";
  }
}

function yearOf(item: Zotero.Item): string | undefined {
  return stringField(item, "date").match(/\b(?:1[5-9]|20|21)\d{2}\b/)?.[0];
}

function venueOf(item: Zotero.Item): string | undefined {
  return stringField(item, "publicationTitle") ||
    stringField(item, "proceedingsTitle") ||
    stringField(item, "bookTitle") ||
    stringField(item, "repository") ||
    undefined;
}

export async function bridgePaperFromItem(
  item: Zotero.Item,
  citekey: string,
  options: { pinned: boolean; ambiguous: boolean },
): Promise<BridgePaper> {
  const scope = libraryScope(item.libraryID);
  const pdf = pdfAttachment(item);
  const markdownLink = await readMarkdownLink(item).catch(() => undefined);
  const identifiers = readItemPaperIdentifiers(item);

  return {
    citekey,
    citekeyPinned: options.pinned,
    ambiguous: options.ambiguous,
    libraryID: item.libraryID,
    itemKey: String(item.key),
    title: stringField(item, "title"),
    authors: item.getCreators()
      .map((creator) => [creator.firstName, creator.lastName]
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        .join(" "))
      .filter(Boolean),
    year: yearOf(item),
    itemType: Zotero.ItemTypes.getName(item.itemTypeID),
    venue: venueOf(item),
    abstract: stringField(item, "abstractNote") || undefined,
    doi: identifiers.doi,
    arxiv: identifiers.arxiv,
    semanticScholarPaperId: identifiers.semanticScholarPaperId,
    citationCount: identifiers.citations,
    links: {
      zoteroSelect: `zotero://select/${scope}/items/${item.key}`,
      zoteroPdf: pdf ? `zotero://open-pdf/${scope}/items/${pdf.key}` : undefined,
      markdown: markdownLink?.url,
      hasMarkdownAttachment: Boolean(markdownAttachment(item)),
    },
  };
}

function relatedFromCandidate(
  candidate: LiteratureCandidate,
  citekeyOf: (libraryID: number, itemID: number) => string | undefined,
): BridgeRelatedPaper {
  const identifiers = (candidate.identifiers || {}) as Record<string, string | undefined>;
  const membership = candidate.membership;
  const item = membership.inLibrary && membership.itemID
    ? Zotero.Items.get(membership.itemID)
    : undefined;

  return {
    title: candidate.title || candidate.text || "",
    authors: candidate.authors || [],
    year: candidate.year,
    doi: identifiers.DOI,
    arxiv: identifiers.arXiv,
    url: candidate.url,
    venue: candidate.primaryVenue,
    citationCount: candidate.citationCount,
    isInfluential: candidate.isInfluential,
    paperID: candidate.paperID,
    inLibrary: membership.inLibrary,
    libraryID: item ? item.libraryID : undefined,
    itemKey: item ? String(item.key) : undefined,
    citekey: item && membership.itemID
      ? citekeyOf(membership.libraryID, membership.itemID)
      : undefined,
  };
}

export function bridgeRelationsFromSnapshot(
  subject: { libraryID: number; itemKey: string; citekey: string },
  snapshot: LiteratureSnapshot,
  citekeyOf: (libraryID: number, itemID: number) => string | undefined,
): BridgeRelations {
  return {
    libraryID: subject.libraryID,
    itemKey: subject.itemKey,
    citekey: subject.citekey,
    kind: snapshot.kind,
    loaded: true,
    source: snapshot.source,
    total: snapshot.total,
    count: snapshot.loaded,
    hasMore: snapshot.hasMore,
    items: snapshot.items.map((candidate) => relatedFromCandidate(candidate, citekeyOf)),
  };
}

export function bridgeRelationsUnloaded(
  subject: { libraryID: number; itemKey: string; citekey: string },
  kind: BridgeRelations["kind"],
): BridgeRelations {
  return {
    libraryID: subject.libraryID,
    itemKey: subject.itemKey,
    citekey: subject.citekey,
    kind,
    loaded: false,
    source: "",
    total: 0,
    count: 0,
    hasMore: false,
    items: [],
  };
}
