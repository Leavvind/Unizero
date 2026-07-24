/**
 * Zotero mutation adapter for a paper discovered through References/Citations.
 *
 * Relation providers return language-neutral paper metadata. This adapter is the
 * only new code in the explorer flow that turns that derived record into a Zotero
 * item, and always targets the seed item's library rather than the globally
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

function validCollectionIDs(seed: Zotero.Item): number[] {
  return seed.getCollections().filter((collectionID) => {
    const collection = Zotero.Collections.get(collectionID) as Zotero.Collection | false;
    return Boolean(collection && collection.libraryID === seed.libraryID);
  });
}

async function translateByIdentifier(
  seed: Zotero.Item,
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
    libraryID: seed.libraryID,
    collections: validCollectionIDs(seed),
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
  seed: Zotero.Item,
  paper: DiscoveredPaper,
): Promise<Zotero.Item> {
  try {
    const translated = await translateByIdentifier(seed, paper);
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
  (item as any).libraryID = seed.libraryID;
  item.setField("title", paper.title || "Untitled");
  if (paper.year) { item.setField("date", paper.year); }
  if (paper.url) { item.setField("url", paper.url); }
  if (paper.identifiers.DOI) {
    try { item.setField("DOI", paper.identifiers.DOI); } catch { /* unsupported item type */ }
  }
  if (paper.abstract) { item.setField("abstractNote", paper.abstract); }
  if (paper.authors.length) { item.setCreators(creators(paper.authors)); }
  await item.saveTx();
  for (const collectionID of validCollectionIDs(seed)) {
    item.addToCollection(collectionID);
  }
  await item.saveTx();
  return item;
}
