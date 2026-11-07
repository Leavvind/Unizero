/**
 * Read adapter for Collection-scoped paper listings.
 *
 * Collection membership, bibliographic fields, and attachment state stay on this
 * side of the bridge, so callers never reach into Zotero globals directly.
 */

import type {
  LiteratureCandidate,
  LiteratureCollectionPaper,
  LiteratureCollectionScope,
} from "../modules/literatureRelations";
import { readItemPaperIdentifiers } from "../modules/itemIdentifiers";
import { artifactSource, hasKind } from "./artifactIdentity";

const MARKDOWN_TAGS = new Set(["unizero:markdown", "unizero:markdown-copy"]);

/** A collection's items, then those of every subcollection below it, each once. */
function itemsWithSubcollections(collection: Zotero.Collection): Zotero.Item[] {
  const seen = new Set<number>();
  const visited = new Set<number>();
  const items: Zotero.Item[] = [];
  const pending = [collection];
  while (pending.length) {
    const current = pending.shift() as Zotero.Collection;
    if (visited.has(current.id)) { continue; }
    visited.add(current.id);
    for (const item of current.getChildItems(false, false)) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
    pending.push(...current.getChildCollections(false));
  }
  return items;
}

/**
 * Match Zotero's normal Collection semantics: items directly filed in the
 * selected Collection. Selecting a subcollection opens that subcollection as its
 * own scope instead of silently flattening the tree. `includeSubcollections`
 * matches Zotero's "Show Items from Subcollections" view option instead.
 */
export async function literatureItemsInScope(
  scope: LiteratureCollectionScope,
  options: { includeSubcollections?: boolean } = {},
): Promise<Zotero.Item[]> {
  let items: Zotero.Item[];
  if (scope.collectionID) {
    const collection = Zotero.Collections.get(scope.collectionID) as
      Zotero.Collection | false;
    if (!collection || collection.libraryID !== scope.libraryID) { return []; }
    items = options.includeSubcollections
      ? itemsWithSubcollections(collection)
      : collection.getChildItems(false, false);
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

/**
 * The paper's Raw (the owned `raw` Markdown attachment), when conversion created
 * one. A paper with supplements has one Raw per PDF; the one converted from the
 * paper's own PDF wins.
 */
export function rawAttachment(item: Zotero.Item): Zotero.Item | undefined {
  return mainArtifact(item, "raw");
}

/** The paper's Raw Backup, chosen like `rawAttachment`. */
export function rawBackupAttachment(item: Zotero.Item): Zotero.Item | undefined {
  return mainArtifact(item, "raw-backup");
}

function mainArtifact(item: Zotero.Item, kind: "raw" | "raw-backup"): Zotero.Item | undefined {
  const owned = attachments(item).filter((attachment) => hasKind(attachment, kind));
  const pdf = pdfAttachment(item);
  return owned.find((attachment) => pdf && artifactSource(attachment) === pdf.key)
    ?? owned[0];
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
