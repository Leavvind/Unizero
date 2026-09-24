/**
 * Read adapter for Collection-level Unizero Home.
 *
 * The explorer is a view over Zotero's canonical items. Collection selection,
 * membership, bibliographic fields, and attachment state stay on this side of the
 * UI bridge so the XHTML window never reaches into Zotero globals directly.
 */

import type {
  LiteratureCandidate,
  LiteratureCollectionPaper,
  LiteratureCollectionScope,
} from "../modules/literatureRelations";
import { readItemPaperIdentifiers } from "../modules/itemIdentifiers";

const MARKDOWN_TAGS = new Set(["unizero:markdown", "unizero:markdown-copy"]);

function libraryName(libraryID: number): string {
  const library = (Zotero.Libraries as any).get?.(libraryID);
  return String(library?.name || library?.libraryType || `Library ${libraryID}`);
}

/**
 * Collections selected in the left pane.
 *
 * Zotero 10 made the singular getters throw (multi-row collection selection).
 * Prefer the plural APIs and keep a Zotero 8/9 fallback. Home is still one
 * Collection at a time, so callers take the first matching row.
 */
function selectedCollections(pane: any): Zotero.Collection[] {
  if (typeof pane?.getSelectedCollections === "function") {
    const collections = pane.getSelectedCollections() as Zotero.Collection[] | undefined;
    return Array.isArray(collections) ? collections.filter(Boolean) : [];
  }
  const collection = pane?.getSelectedCollection?.() as Zotero.Collection | undefined;
  return collection ? [collection] : [];
}

function selectedLibraryIDs(pane: any): number[] {
  if (typeof pane?.getSelectedLibraryIDs === "function") {
    const ids = pane.getSelectedLibraryIDs() as unknown;
    return Array.isArray(ids)
      ? ids.map(Number).filter((id) => Number.isFinite(id) && id > 0)
      : [];
  }
  const id = Number(pane?.getSelectedLibraryID?.());
  return Number.isFinite(id) && id > 0 ? [id] : [];
}

function matchingCollection(
  collections: Zotero.Collection[],
  fallbackLibraryID?: number,
): Zotero.Collection | undefined {
  if (fallbackLibraryID) {
    return collections.find((collection) => collection.libraryID === fallbackLibraryID);
  }
  return collections[0];
}

/**
 * Resolve the scope at command time. A context-menu command should follow the
 * Collection selected when the menu opens, not the Collection that happened to
 * be selected when the add-on registered.
 */
export function selectedLiteratureScope(
  mainWindow: Window,
  fallbackLibraryID?: number,
): LiteratureCollectionScope {
  const pane = (mainWindow as any).ZoteroPane;
  const collection = matchingCollection(selectedCollections(pane), fallbackLibraryID);
  if (collection) {
    return {
      libraryID: collection.libraryID,
      collectionID: collection.id,
      collectionKey: String((collection as any).key || ""),
      name: collection.name || libraryName(collection.libraryID),
    };
  }

  const libraryIDs = selectedLibraryIDs(pane);
  const selectedLibraryID = fallbackLibraryID
    ? libraryIDs.find((id) => id === fallbackLibraryID)
    : libraryIDs[0];
  const canUseSelectedLibrary = Number.isFinite(selectedLibraryID) &&
    (selectedLibraryID as number) > 0;
  const libraryID = canUseSelectedLibrary
    ? selectedLibraryID as number
    : Number(fallbackLibraryID || Zotero.Libraries.userLibraryID || 1);
  return { libraryID, name: libraryName(libraryID) };
}

/**
 * Match Zotero's normal Collection semantics: items directly filed in the
 * selected Collection. Selecting a subcollection opens that subcollection as its
 * own scope instead of silently flattening the tree.
 */
export async function literatureItemsInScope(
  scope: LiteratureCollectionScope,
): Promise<Zotero.Item[]> {
  let items: Zotero.Item[];
  if (scope.collectionID) {
    const collection = Zotero.Collections.get(scope.collectionID) as
      Zotero.Collection | false;
    if (!collection || collection.libraryID !== scope.libraryID) { return []; }
    items = collection.getChildItems(false, false);
  } else {
    items = await Zotero.Items.getAll(scope.libraryID, true, false);
  }
  return items.filter((item) => item.isRegularItem?.() && !item.deleted);
}

function attachments(item: Zotero.Item): Zotero.Item[] {
  return item.getAttachments()
    .map((id) => Zotero.Items.get(id))
    .filter((attachment): attachment is Zotero.Item => Boolean(attachment));
}

export function hasPdfAttachment(item: Zotero.Item): boolean {
  return attachments(item).some(
    (attachment) => attachment.attachmentContentType === "application/pdf",
  );
}

/**
 * "Converted" is intentionally answered by the resulting attachment, not by a
 * parent tag: the attachment is the usable artifact, while an old parent tag can
 * survive a manually removed output.
 */
export function markdownAttachment(item: Zotero.Item): Zotero.Item | undefined {
  return attachments(item).find((attachment) => {
    if (attachment.attachmentContentType === "text/markdown") { return true; }
    if (attachment.getTags().some((tag) => MARKDOWN_TAGS.has(tag.tag))) { return true; }
    const title = String(attachment.getField("title") || "");
    return /\.md(?:\s|$)/i.test(title);
  });
}

export function hasMarkdownAttachment(item: Zotero.Item): boolean {
  return Boolean(markdownAttachment(item));
}

export function pdfAttachment(item: Zotero.Item): Zotero.Item | undefined {
  return attachments(item).find(
    (attachment) => attachment.attachmentContentType === "application/pdf",
  );
}

export function literaturePaperMetadata(
  item: Zotero.Item,
): Omit<LiteratureCollectionPaper, "references" | "citations"> {
  const date = String(item.getField("date") || "");
  const year = date.match(/\b(?:1[5-9]|20|21)\d{2}\b/)?.[0];
  const creators = item.getCreators()
    .map((creator) => {
      const firstName = String(creator.firstName || "").trim();
      const lastName = String(creator.lastName || "").trim();
      return [firstName, lastName].filter(Boolean).join(" ");
    })
    .filter(Boolean);

  return {
    libraryID: item.libraryID,
    itemID: item.id,
    itemKey: item.key,
    title: String(item.getField("title") || ""),
    creators,
    year,
    dateAdded: String(item.dateAdded || ""),
    publicationTitle: String(item.getField("publicationTitle") || "") || undefined,
    hasPDF: hasPdfAttachment(item),
    hasMarkdown: hasMarkdownAttachment(item),
  };
}

function itemField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field as any) || "");
  } catch {
    return "";
  }
}

/**
 * Project one canonical Zotero item into the explorer's row shape.
 *
 * Relation candidates are never provider discoveries: membership is therefore
 * always true and the numeric item ID is retained so both the title and status
 * control can select the real item in Zotero.
 */
export function literatureCandidateFromItem(
  item: Zotero.Item,
): LiteratureCandidate {
  const identifiers = readItemPaperIdentifiers(item);
  const date = itemField(item, "date");
  const year = date.match(/\b(?:1[5-9]|20|21)\d{2}\b/)?.[0];
  const authors = item.getCreators()
    .map((creator) => {
      const firstName = String(creator.firstName || "").trim();
      const lastName = String(creator.lastName || "").trim();
      return [firstName, lastName].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  let type = "";
  try {
    type = Zotero.ItemTypes.getName(
      Number(item.getField("itemTypeID" as any)),
    ) || "";
  } catch { /* item type is presentation-only metadata */ }

  return {
    identifiers: {
      DOI: identifiers.doi,
      arXiv: identifiers.arxiv,
      paperID: identifiers.semanticScholarPaperId,
    },
    title: itemField(item, "title"),
    authors,
    year,
    type: type || undefined,
    text: itemField(item, "title"),
    url: itemField(item, "url") || undefined,
    primaryVenue: itemField(item, "publicationTitle") || undefined,
    abstract: itemField(item, "abstractNote") || undefined,
    citationCount: identifiers.citations,
    source: "UniConnection",
    membership: {
      inLibrary: true,
      libraryID: item.libraryID,
      itemID: item.id,
    },
  };
}
