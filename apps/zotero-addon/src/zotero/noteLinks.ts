/**
 * `zotero://note/...` links: build them, and open the note they name.
 *
 * The URL shape is Better Notes' (`zotero://note/u/<key>/` for the user library,
 * `zotero://note/<groupID>/<key>/` for a group), so links it wrote into notes keep
 * working once it is gone. Better Notes wrote the libraryID for a group but read
 * back a groupID; this module uses the groupID both ways.
 *
 * Zotero has no public hook for a new `zotero://` path, so the handler is installed
 * the way Better Notes does it: through the protocol handler's private
 * `_extensions` table. Query parameters (`line`, `section`) are accepted and
 * ignored — scrolling needs the note editor's internals.
 */

const EXTENSION_KEY = "zotero://note";

export interface NoteLinkTarget {
  libraryID: number;
  key: string;
}

export function noteLink(note: Zotero.Item): string | undefined {
  const library = Zotero.Libraries.get(note.libraryID);
  if (!library) { return undefined; }
  if (library.libraryType === "user") { return `zotero://note/u/${note.key}/`; }
  if (library.libraryType === "group") {
    const groupID = Zotero.Groups.getGroupIDFromLibraryID(note.libraryID);
    return groupID ? `zotero://note/${groupID}/${note.key}/` : undefined;
  }
  return undefined;
}

/** The library and key a note link names, or undefined for any other URL. */
export function parseNoteLink(link: string): NoteLinkTarget | undefined {
  const match = /^zotero:\/\/note\/(u|\d+)\/([A-Z0-9]{8})\/?(?:[?#].*)?$/i.exec(link);
  if (!match) { return undefined; }
  const libraryID = match[1] === "u"
    ? Zotero.Libraries.userLibraryID
    : Zotero.Groups.getLibraryIDFromGroupID(Number(match[1]));
  if (!libraryID) { return undefined; }
  return { libraryID, key: match[2].toUpperCase() };
}

/** Open the linked note in a tab. Returns false when the link names no note. */
export async function openNoteLink(link: string): Promise<boolean> {
  const target = parseNoteLink(link);
  if (!target) { return false; }
  const note = Zotero.Items.getByLibraryAndKey(target.libraryID, target.key) as Zotero.Item | false;
  if (!note || !note.isNote()) { return false; }
  const win = Zotero.getMainWindow() as any;
  if (!win?.ZoteroPane) { return false; }
  await win.ZoteroPane.openNote(note.id, { openInWindow: false });
  return true;
}

function protocolExtensions(): Record<string, unknown> | undefined {
  try {
    return (Services.io.getProtocolHandler("zotero") as any).wrappedJSObject?._extensions;
  } catch (error) {
    Zotero.logError(error as Error);
    return undefined;
  }
}

interface ProtocolExtension {
  noContent: boolean;
  doAction(uri: { spec: string }): void;
  newChannel(uri: { spec: string }): void;
}

let installed: ProtocolExtension | undefined;
let previous: unknown;

/** Install the handler. Idempotent; the protocol table is process-wide. */
export function registerNoteLinkHandler(): void {
  const extensions = protocolExtensions();
  if (!extensions || (installed && extensions[EXTENSION_KEY] === installed)) { return; }
  previous = extensions[EXTENSION_KEY];
  installed = {
    noContent: true,
    doAction(uri: { spec: string }) {
      openNoteLink(uri.spec).then((opened) => {
        if (!opened) { Zotero.debug(`UniZero: no note for ${uri.spec}`); }
      }, (error) => Zotero.logError(error as Error));
    },
    newChannel(uri: { spec: string }) {
      this.doAction(uri);
    },
  };
  extensions[EXTENSION_KEY] = installed;
}

/** Remove the handler, putting back whatever it replaced. */
export function unregisterNoteLinkHandler(): void {
  const extensions = protocolExtensions();
  if (extensions && installed && extensions[EXTENSION_KEY] === installed) {
    if (previous) {
      extensions[EXTENSION_KEY] = previous;
    } else {
      delete extensions[EXTENSION_KEY];
    }
  }
  installed = undefined;
  previous = undefined;
}
