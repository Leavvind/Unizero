/**
 * Read adapter for the Collection-level Literature Explorer.
 *
 * The explorer is a view over Zotero's canonical items. Collection selection,
 * membership, bibliographic fields, and attachment state stay on this side of the
 * UI bridge so the XHTML window never reaches into Zotero globals directly.
 */

import type {
  LiteratureCollectionPaper,
  LiteratureCollectionScope,
} from "../modules/literatureRelations";

const MARKDOWN_TAGS = new Set(["unizero:markdown", "unizero:markdown-copy"]);

function libraryName(libraryID: number): string {
  const library = (Zotero.Libraries as any).get?.(libraryID);
  return String(library?.name || library?.libraryType || `Library ${libraryID}`);
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
  const collection = pane?.getSelectedCollection?.() as Zotero.Collection | undefined;
  if (collection && (!fallbackLibraryID || collection.libraryID === fallbackLibraryID)) {
    return {
      libraryID: collection.libraryID,
      collectionID: collection.id,
      name: collection.name || libraryName(collection.libraryID),
    };
  }

  const selectedLibraryID = Number(pane?.getSelectedLibraryID?.());
  const canUseSelectedLibrary = Number.isFinite(selectedLibraryID) &&
    selectedLibraryID > 0 &&
    (!fallbackLibraryID || selectedLibraryID === fallbackLibraryID);
  const libraryID = canUseSelectedLibrary
    ? selectedLibraryID
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
export function hasMarkdownAttachment(item: Zotero.Item): boolean {
  return attachments(item).some((attachment) => {
    if (attachment.attachmentContentType === "text/markdown") { return true; }
    if (attachment.getTags().some((tag) => MARKDOWN_TAGS.has(tag.tag))) { return true; }
    const title = String(attachment.getField("title") || "");
    return /\.md(?:\s|$)/i.test(title);
  });
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
