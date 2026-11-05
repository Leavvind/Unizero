/**
 * Zotero's own identifier translators, as behind "Add Item by Identifier".
 *
 * A DOI or arXiv ID goes through the same translators Zotero uses when a user
 * pastes one, so imported papers and completed metadata carry the record
 * Zotero itself would have produced: split creator names, full dates, volume,
 * issue, pages, and type-specific venue fields.
 */

export interface PaperIdentifiers {
  DOI?: string;
  arXiv?: string;
}

/** Item JSON as a translator emits it; only the keys read here are typed. */
export interface TranslatedItem {
  itemType?: string;
  creators?: TranslatedCreator[];
  [field: string]: unknown;
}

interface TranslatedCreator {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

/**
 * Fields a lookup never fills on an existing item. Identifiers belong to the
 * caller's conflict rules, `extra` holds UniZero's own keys, and the catalog
 * and access date describe a retrieval that did not create this item.
 */
const NEVER_FILLED = new Set([
  "itemType", "creators", "tags", "notes", "attachments", "seeAlso", "relations",
  "collections", "extra", "DOI", "accessDate", "libraryCatalog",
]);

function cleanIdentifiers(identifiers: PaperIdentifiers): PaperIdentifiers | undefined {
  const clean: PaperIdentifiers = {};
  if (identifiers.DOI) { clean.DOI = identifiers.DOI; }
  if (identifiers.arXiv) { clean.arXiv = identifiers.arXiv; }
  return Object.keys(clean).length ? clean : undefined;
}

async function identifierSearch(identifiers: PaperIdentifiers): Promise<any | undefined> {
  const clean = cleanIdentifiers(identifiers);
  if (!clean) { return; }
  const translate = new Zotero.Translate.Search();
  translate.setIdentifier(clean);
  const translators = await translate.getTranslators();
  if (!translators?.length) { return; }
  translate.setTranslator(translators);
  return translate;
}

/** Translate and save a new item, exactly as "Add Item by Identifier" does. */
export async function saveByIdentifier(
  identifiers: PaperIdentifiers,
  options: { libraryID: number; collections: number[] },
): Promise<Zotero.Item | undefined> {
  const translate = await identifierSearch(identifiers);
  if (!translate) { return; }
  return (await translate.translate({ ...options, saveAttachments: true }))[0];
}

/** Translate without saving: the record Zotero would create, as item JSON. */
export async function lookupByIdentifier(
  identifiers: PaperIdentifiers,
): Promise<TranslatedItem | undefined> {
  const translate = await identifierSearch(identifiers);
  if (!translate) { return; }
  const items = await translate.translate({ libraryID: false, saveAttachments: false });
  return Array.isArray(items) && items[0] && typeof items[0] === "object"
    ? items[0] as TranslatedItem
    : undefined;
}

/**
 * The field on `item` that holds a translated field.
 *
 * The translator names fields for its own item type; a conference paper's
 * `proceedingsTitle` is a journal article's `publicationTitle`. Both are base
 * mapped to one field, which is how the value finds its place on an item of
 * another type. A field with no counterpart is left out rather than forcing
 * the item's type to change.
 */
function targetField(item: Zotero.Item, sourceType: number | false, field: string): string | undefined {
  const fields = (Zotero as any).ItemFields;
  const fieldID = fields.getID(field);
  if (!fieldID) { return; }
  if (fields.isValidForType(fieldID, item.itemTypeID)) { return field; }
  if (!sourceType) { return; }
  const baseID = fields.getBaseIDFromTypeAndField(sourceType, fieldID) || fieldID;
  const mappedID = fields.getFieldIDFromTypeAndBase(item.itemTypeID, baseID);
  return mappedID ? fields.getName(mappedID) : undefined;
}

function readField(item: Zotero.Item, field: string): string {
  try { return String(item.getField(field as any) || "").trim(); } catch { return ""; }
}

/** The bibliographic core a translator record supplies, named as on a journal article. */
const CORE_FIELDS = ["title", "date", "publicationTitle", "volume", "issue", "pages"];

/**
 * Whether a lookup could fill anything that matters. A field the item's type does
 * not have is not missing, so a complete conference paper (which has no `issue`)
 * does not cost a lookup on every run.
 */
export function lacksCoreFields(item: Zotero.Item): boolean {
  if (!item.getCreators().length) { return true; }
  const journal = Zotero.ItemTypes.getID("journalArticle" as any);
  return CORE_FIELDS.some((field) => {
    try {
      const target = targetField(item, journal, field);
      return !!target && !readField(item, target);
    } catch { return false; }
  });
}

function toCreator(item: Zotero.Item, creator: TranslatedCreator) {
  const creatorTypes = Zotero.CreatorTypes;
  let typeID = creator.creatorType ? creatorTypes.getID(creator.creatorType as any) : false;
  if (!typeID || !creatorTypes.isValidForItemType(typeID, item.itemTypeID)) {
    typeID = creatorTypes.getPrimaryIDForType(item.itemTypeID);
  }
  const creatorType = typeID ? creatorTypes.getName(typeID) : "author";
  if (creator.name || !creator.firstName) {
    const lastName = String(creator.name || creator.lastName || "").trim();
    return lastName ? { creatorType, lastName, fieldMode: 1 } : undefined;
  }
  const lastName = String(creator.lastName || "").trim();
  return lastName
    ? { creatorType, firstName: String(creator.firstName).trim(), lastName }
    : undefined;
}

/**
 * Fill the fields `item` is missing from a translated record, without saving.
 *
 * Like every completion, this only fills: a field that has a value keeps it,
 * and creators are written only when the item has none. Returns the names of
 * the fields it set.
 */
export function fillMissingFromTranslated(item: Zotero.Item, translated: TranslatedItem): string[] {
  const filled: string[] = [];
  const sourceType = translated.itemType
    ? Zotero.ItemTypes.getID(translated.itemType as any)
    : false;

  for (const [field, value] of Object.entries(translated)) {
    if (NEVER_FILLED.has(field) || typeof value !== "string" || !value.trim()) { continue; }
    // Every step stays inside the guard: translators emit fields their own type
    // lacks, and the base-field mapping throws on those. One bad field must not
    // abandon fields already set, which the caller would then never save.
    try {
      const target = targetField(item, sourceType, field);
      if (!target || readField(item, target)) { continue; }
      item.setField(target as any, value.trim());
      filled.push(target);
    } catch (error) {
      ztoolkit.log(`[identifier-translation] could not fill ${field}: ${error}`);
    }
  }

  if (!item.getCreators().length && Array.isArray(translated.creators)) {
    try {
      const creators = translated.creators
        .map((creator) => toCreator(item, creator))
        .filter(Boolean);
      if (creators.length) {
        item.setCreators(creators as any);
        filled.push("creators");
      }
    } catch (error) {
      ztoolkit.log(`[identifier-translation] could not fill creators: ${error}`);
    }
  }
  return filled;
}
