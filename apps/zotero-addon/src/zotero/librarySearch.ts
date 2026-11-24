/**
 * Read-only quick search over one library's regular items, for the sidebar's
 * unified search box. Matches Zotero's own "Title, Creator, Year" mode.
 */

export interface LibraryHit {
  libraryID: number;
  itemKey: string;
  itemID: number;
  title: string;
  authors: string[];
  year?: string;
  type?: string;
}

function field(item: Zotero.Item, name: string): string {
  try {
    return String(item.getField(name as any) || "").trim();
  } catch {
    return "";
  }
}

/** A library item as a search hit (also used for rows that only have excerpts). */
export function libraryHit(item: Zotero.Item): LibraryHit {
  return {
    libraryID: item.libraryID,
    itemKey: String(item.key),
    itemID: item.id,
    title: field(item, "title"),
    authors: item.getCreators()
      .map((creator) => [creator.firstName, creator.lastName]
        .map((part) => String(part || "").trim()).filter(Boolean).join(" "))
      .filter(Boolean),
    year: field(item, "date").match(/\d{4}/)?.[0],
    type: Zotero.ItemTypes.getName(item.itemTypeID),
  };
}

export async function searchLibrary(
  libraryID: number,
  query: string,
  limit = 8,
): Promise<LibraryHit[]> {
  const text = query.trim();
  if (!text) { return []; }
  const search = new Zotero.Search({ libraryID });
  search.addCondition("quicksearch-titleCreatorYear", "contains", text);
  const ids = await search.search();
  const items = await Zotero.Items.getAsync(ids.slice(0, limit * 4)) as Zotero.Item[];
  return items
    .filter((item) => item.isRegularItem() && !item.deleted)
    .slice(0, limit)
    .map(libraryHit);
}
