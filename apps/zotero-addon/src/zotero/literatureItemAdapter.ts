/**
 * Zotero mutation adapter for a paper discovered through References/Citations.
 *
 * Relation providers return language-neutral paper metadata. This adapter is the
 * only new code in the explorer flow that turns that derived record into a Zotero
 * item, and always targets an explicit destination rather than the globally
 * selected library.
 */

import { type PaperIdentifiers, saveByIdentifier } from "./identifierTranslation";

export interface DiscoveredPaper {
  identifiers: PaperIdentifiers;
  title: string;
  authors: string[];
  year?: string;
  type?: string;
  url?: string;
  abstract?: string;
}

/**
 * Where a discovered paper is filed: the library and collections of the seed
 * item it was found from.
 */
export interface PaperDestination {
  libraryID: number;
  collectionIDs: number[];
}

function collectionsInLibrary(
  libraryID: number,
  collectionIDs: number[],
): number[] {
  return collectionIDs.filter((collectionID) => {
    const collection = Zotero.Collections.get(collectionID) as Zotero.Collection | false;
    return Boolean(collection && collection.libraryID === libraryID);
  });
}

export function paperDestinationFromItem(seed: Zotero.Item): PaperDestination {
  return {
    libraryID: seed.libraryID,
    collectionIDs: collectionsInLibrary(seed.libraryID, seed.getCollections()),
  };
}

function creators(authors: string[]) {
  return authors.map((name) => {
    const parts = String(name).trim().split(/\s+/);
    return {
      firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : "",
      lastName: parts[parts.length - 1] || String(name),
      creatorType: "author" as const,
    };
  });
}

export async function createDiscoveredPaper(
  destination: PaperDestination,
  paper: DiscoveredPaper,
): Promise<Zotero.Item> {
  try {
    const translated = await saveByIdentifier(paper.identifiers, {
      libraryID: destination.libraryID,
      collections: destination.collectionIDs,
    });
    if (translated) { return translated; }
  } catch (error) {
    ztoolkit.log("identifier import failed; falling back to provider metadata", error);
  }

  let itemType = "journalArticle";
  if (paper.type) {
    try {
      if (Zotero.ItemTypes.getID(paper.type as any)) { itemType = paper.type; }
    } catch { /* provider type is not a Zotero item type */ }
  }
  const item = new Zotero.Item(itemType as any);
  (item as any).libraryID = destination.libraryID;
  item.setField("title", paper.title || "Untitled");
  if (paper.year) { item.setField("date", paper.year); }
  if (paper.url) { item.setField("url", paper.url); }
  if (paper.identifiers.DOI) {
    try { item.setField("DOI", paper.identifiers.DOI); } catch { /* unsupported item type */ }
  }
  if (paper.abstract) { item.setField("abstractNote", paper.abstract); }
  if (paper.authors.length) { item.setCreators(creators(paper.authors)); }
  await item.saveTx();
  for (const collectionID of destination.collectionIDs) {
    item.addToCollection(collectionID);
  }
  await item.saveTx();
  return item;
}
