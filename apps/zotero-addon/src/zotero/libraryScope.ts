/**
 * Stable Zotero identities used across caches and the paper-runtime boundary.
 *
 * Item keys are unique only inside one Zotero library. Any persisted or cross-process
 * identity therefore needs the numeric libraryID as well as the item key.
 */

export type ZoteroLibraryScope = "library" | `groups/${number}`;

export interface LibraryScopedItem {
  key: string;
  libraryID?: number;
}

export function effectiveLibraryID(item: LibraryScopedItem): number {
  return Number(item.libraryID || Zotero.Libraries.userLibraryID || 1);
}

export function libraryItemIdentity(item: LibraryScopedItem): string {
  return `${effectiveLibraryID(item)}:${item.key}`;
}

/**
 * Zotero deep links use a groupID, not Zotero's internal libraryID.
 */
export function libraryScope(libraryID: number): ZoteroLibraryScope {
  const library = Zotero.Libraries.get(libraryID);
  if (library && library.libraryType === "group") {
    return `groups/${library.libraryTypeID}`;
  }
  return "library";
}

interface LibraryPermissions {
  editable?: boolean;
  filesEditable?: boolean;
}

function libraryPermissions(libraryID: number): LibraryPermissions | undefined {
  return (Zotero.Libraries as any).get?.(libraryID) || undefined;
}

/** Whether items in the library may be changed or trashed (group permissions). */
export function libraryEditable(libraryID: number): boolean {
  return Boolean(libraryPermissions(libraryID)?.editable);
}

/** Whether the library accepts new stored files (group permissions). */
export function libraryAcceptsFiles(libraryID: number): boolean {
  const library = libraryPermissions(libraryID);
  return Boolean(library?.editable && library.filesEditable);
}
