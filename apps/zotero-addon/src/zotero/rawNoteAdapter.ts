/**
 * The paper's Raw note: converted Markdown kept as an editable Zotero child note.
 *
 * Rendering is Better Notes' job (`Zotero.BetterNotes.api.convert.md2html`), so this
 * add-on carries no Markdown parser and the note reads exactly as one imported by
 * hand. The runtime only leaves the Markdown on disk; creating the note is a Zotero
 * mutation and therefore lives here.
 *
 * The note is the user's working copy — they mark it up and reflow it — so an
 * existing one is kept unless the template says otherwise.
 */

import { findOwnedNotes, tagOwnedNote } from "./artifactIdentity";
import type { ZoteroLibraryScope } from "./libraryScope";

/** Schema version of the note-editor document the wrapper div declares. */
const NOTE_SCHEMA_VERSION = 9;

/**
 * Size past which a Raw note is likely to stop syncing.
 *
 * Measured on a Chinese book: an 800 KB note synced and an 860 KB one did not.
 * This is 75% of the working size, leaving room for the markup that varies per
 * paper. The note is still created above it, with a warning, so the content is not
 * lost; splitting a long book across notes is not implemented.
 */
export const NOTE_SOFT_LIMIT_BYTES = 600 * 1024;

export type RawNoteExisting = "skip" | "replace";
export type RawNoteOutcome = "created" | "replaced" | "kept";

export interface RawNoteResult {
  outcome: RawNoteOutcome;
  /** UTF-8 size of the note HTML; 0 when an existing note was kept. */
  bytes: number;
  /** The note is past NOTE_SOFT_LIMIT_BYTES and may not sync. */
  oversize: boolean;
}

export interface MarkdownConverter {
  md2html(markdown: string): Promise<string>;
}

/** Thrown when the Raw note cannot be produced; the message is shown to the user. */
export class RawNoteUnavailableError extends Error {}

/**
 * Better Notes' public API, present only while the plugin is running. Its global
 * can outlive a disable or precede startup, so the API object is the signal.
 */
function betterNotesApi(): any {
  return (Zotero as any).BetterNotes?.api;
}

/** Better Notes' converter, or a clear failure when it is not installed. */
export function betterNotesConverter(): MarkdownConverter {
  const convert = betterNotesApi()?.convert;
  if (typeof convert?.md2html !== "function") {
    throw new RawNoteUnavailableError(
      "The Raw note needs the Better Notes plugin, and it is not available. " +
      "Install or enable Better Notes in Zotero, then convert again.",
    );
  }
  return { md2html: (markdown) => convert.md2html(markdown) };
}

/**
 * Better Notes' own link to a note, which opens it in the note editor.
 *
 * Mirrors Better Notes' `getNoteLink`: `u` for the user library, otherwise the
 * library's `libraryID` (not the group ID). Absent when Better Notes is not
 * running, since nothing else handles `zotero://note`.
 */
export function betterNotesNoteLink(note: Zotero.Item): string | undefined {
  if (!betterNotesApi()) { return undefined; }
  const library = Zotero.Libraries.get(note.libraryID);
  if (!library) { return undefined; }
  if (library.libraryType === "user") { return `zotero://note/u/${note.key}/`; }
  if (library.libraryType === "group") { return `zotero://note/${note.libraryID}/${note.key}/`; }
  return undefined;
}

/**
 * The bridge's links to a Raw note: `rawNote` selects it in Zotero and always
 * works; `rawNoteOpen` opens it in Better Notes' editor when that is running.
 * Neither is present without a note.
 */
export function rawNoteLinks(
  note: Zotero.Item | undefined,
  scope: ZoteroLibraryScope,
): { rawNote?: string; rawNoteOpen?: string } {
  if (!note) { return {}; }
  return {
    rawNote: `zotero://select/${scope}/items/${note.key}`,
    rawNoteOpen: betterNotesNoteLink(note),
  };
}

export function wrapNoteHtml(html: string): string {
  return `<div data-schema-version="${NOTE_SCHEMA_VERSION}">${html}</div>`;
}

export function noteBytes(html: string): number {
  return new TextEncoder().encode(html).length;
}

/**
 * Create, replace, or keep the Raw note under `parent`.
 *
 * With `skip` and an existing note, nothing is converted at all: the user's edits
 * are the reason to keep it, and rendering the Markdown again would only spend the
 * time to throw the result away.
 */
export async function publishRawNote(
  parent: Zotero.Item,
  markdown: string,
  existing: RawNoteExisting,
  converter: MarkdownConverter = betterNotesConverter(),
): Promise<RawNoteResult> {
  const owned = findOwnedNotes(parent, "raw-note");
  if (owned.length && existing === "skip") {
    return { outcome: "kept", bytes: 0, oversize: false };
  }

  const html = wrapNoteHtml(await converter.md2html(markdown));
  const bytes = noteBytes(html);
  const oversize = bytes > NOTE_SOFT_LIMIT_BYTES;

  if (owned.length) {
    // Only the first is touched: any other owned note may hold edits of its own.
    owned[0].setNote(html);
    await owned[0].saveTx();
    return { outcome: "replaced", bytes, oversize };
  }

  const note = new Zotero.Item("note");
  note.libraryID = parent.libraryID;
  note.parentID = parent.id;
  note.setNote(html);
  tagOwnedNote(note, "raw-note");
  await note.saveTx();
  return { outcome: "created", bytes, oversize };
}
