/**
 * The paper's Raw note: converted Markdown kept as an editable Zotero child note.
 *
 * The Markdown is rendered by `notes/markdownToNote`, a port of Better Notes'
 * converter, so the note matches what Better Notes would have produced. The runtime
 * only leaves the Markdown on disk; creating the note is a Zotero mutation and
 * therefore lives here.
 *
 * The note is the user's working copy — they mark it up and reflow it — so an
 * existing one is kept unless the template says otherwise.
 */

import { findOwnedNotes, tagOwnedNote } from "./artifactIdentity";
import type { ZoteroLibraryScope } from "./libraryScope";
import { noteLink } from "./noteLinks";
import { markdownToNoteHtml } from "../notes/markdownToNote";

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

/**
 * The bridge's links to a Raw note: `rawNote` selects it in Zotero; `rawNoteOpen`
 * opens it in a note tab through this add-on's `zotero://note` handler. Neither
 * is present without a note.
 */
export function rawNoteLinks(
  note: Zotero.Item | undefined,
  scope: ZoteroLibraryScope,
): { rawNote?: string; rawNoteOpen?: string } {
  if (!note) { return {}; }
  return {
    rawNote: `zotero://select/${scope}/items/${note.key}`,
    rawNoteOpen: noteLink(note),
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
  converter: MarkdownConverter = { md2html: markdownToNoteHtml },
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
