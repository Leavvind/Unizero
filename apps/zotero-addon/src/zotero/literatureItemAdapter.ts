/**
 * Zotero mutation adapter for a paper discovered through References/Citations.
 *
 * Relation providers return language-neutral paper metadata. This adapter is the
 * only new code in the explorer flow that turns that derived record into a Zotero
 * item, and always targets an explicit destination rather than the globally
 * selected library.
 */

export interface DiscoveredPaper {
  identifiers: {
    DOI?: string;
    arXiv?: string;
  };
  title: string;
  authors: string[];
  year?: string;
  type?: string;
  url?: string;
  abstract?: string;
}

/**
 * Where a discovered paper is filed.
 *
 * Taken from the seed item when the paper was found from one, and from Unizero
 * Home's current scope when the seed is a Board-pinned paper with no Zotero item
 * to inherit a library and collections from.
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

export function paperDestinationFromScope(
  libraryID: number,
  collectionID?: number,
): PaperDestination {
  return {
    libraryID,
    collectionIDs: collectionID
      ? collectionsInLibrary(libraryID, [collectionID])
      : [],
  };
}

async function translateByIdentifier(
  destination: PaperDestination,
  paper: DiscoveredPaper,
): Promise<Zotero.Item | undefined> {
  const identifiers: DiscoveredPaper["identifiers"] = {};
  if (paper.identifiers.DOI) { identifiers.DOI = paper.identifiers.DOI; }
  if (paper.identifiers.arXiv) { identifiers.arXiv = paper.identifiers.arXiv; }
  if (!Object.keys(identifiers).length) { return; }

  const translate = new Zotero.Translate.Search();
  translate.setIdentifier(identifiers);
  const translators = await translate.getTranslators();
  if (!translators?.length) { return; }
  translate.setTranslator(translators);
  return (await translate.translate({
    libraryID: destination.libraryID,
    collections: destination.collectionIDs,
    saveAttachments: true,
  }))[0];
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
    const translated = await translateByIdentifier(destination, paper);
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
