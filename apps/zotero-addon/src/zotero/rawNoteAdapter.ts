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
 *
 * A document too long for one note to sync is split into consecutive runs of
 * top-level sections, one note per run. Each part opens with a `Part i/n` line,
 * which is both its title in Zotero and how a later Replace finds the old parts.
 */

import { findOwnedNotes, tagOwnedNote } from "./artifactIdentity";
import type { ZoteroLibraryScope } from "./libraryScope";
import { noteLink } from "./noteLinks";
import { markdownToNoteHtml } from "../notes/markdownToNote";
import {
  firstHeading, splitAtHeadings, splitAtParagraphs,
} from "../notes/splitMarkdown";

/** Schema version of the note-editor document the wrapper div declares. */
const NOTE_SCHEMA_VERSION = 9;

/**
 * Note HTML length, in characters, past which the note is split.
 *
 * Zotero's sync limit counts the characters of the note HTML, markup included, not
 * its bytes: notes failed to sync somewhere between 470,000 and 500,000 characters
 * (2026-10-14). Kept below that so markup the user adds while reading still fits.
 */
export const NOTE_MAX_CHARS = 450_000;

/**
 * Target size of one part once a note is split. Lower than the maximum so each
 * part has room for the user's own markup, and so the editor stays responsive.
 */
export const NOTE_PART_CHARS = 350_000;

const PART_MARKER = /^\s*<div[^>]*>\s*<p>Part (\d+)\/(\d+)\b/;

export type RawNoteExisting = "skip" | "replace";
export type RawNoteOutcome = "created" | "replaced" | "kept";

export interface RawNoteResult {
  outcome: RawNoteOutcome;
  /** Notes the Raw text now spans; 0 when an existing note was kept. */
  parts: number;
  /** Characters of note HTML across all parts; 0 when an existing note was kept. */
  chars: number;
  /** A part is still past NOTE_MAX_CHARS (one indivisible block) and may not sync. */
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

/** Part number from a note's leading `Part i/n` line; 0 for an unsplit note. */
export function partNumber(html: string): number {
  const match = PART_MARKER.exec(html || "");
  return match ? Number(match[1]) : 0;
}

/**
 * The paper's Raw note, in reading order: the parts of a split note, or else the
 * first owned note. Other owned notes are left out — they may hold edits of their
 * own and are never overwritten.
 */
export function rawNotes(parent: Zotero.Item): Zotero.Item[] {
  const owned = findOwnedNotes(parent, "raw-note");
  const parts = owned
    .map((note) => ({ note, part: partNumber(note.getNote()) }))
    .filter((entry) => entry.part > 0)
    .sort((a, b) => a.part - b.part)
    .map((entry) => entry.note);
  return parts.length ? parts : owned.slice(0, 1);
}

interface Unit { markdown: string; chars: number }

/**
 * Cut Markdown into units that each render within `budget`, cutting as coarsely
 * as possible: top-level headings first, then each deeper level, then paragraphs.
 * A unit that still does not fit (a single giant paragraph or table) is kept whole.
 */
async function units(
  markdown: string,
  budget: number,
  measure: (markdown: string) => Promise<number>,
  level = 1,
): Promise<Unit[]> {
  const chars = await measure(markdown);
  if (chars <= budget) { return [{ markdown, chars }]; }

  for (let depth = level; depth <= 6; depth++) {
    const pieces = splitAtHeadings(markdown, depth);
    if (pieces.length > 1) {
      const nested = await Promise.all(
        pieces.map((piece) => units(piece, budget, measure, depth + 1)),
      );
      return nested.flat();
    }
  }
  const paragraphs = splitAtParagraphs(markdown);
  if (paragraphs.length < 2) { return [{ markdown, chars }]; }
  return Promise.all(paragraphs.map(async (piece) => ({
    markdown: piece, chars: await measure(piece),
  })));
}

/** Group consecutive units greedily so each group stays within `budget`. */
function pack(list: Unit[], budget: number): string[] {
  const groups: string[][] = [];
  let size = 0;
  for (const unit of list) {
    if (!groups.length || size + unit.chars > budget) {
      groups.push([]);
      size = 0;
    }
    groups[groups.length - 1].push(unit.markdown);
    size += unit.chars;
  }
  return groups.map((group) => group.join("\n\n"));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render the Markdown as one note, or as several when one would not sync. */
export async function renderRawNote(
  markdown: string,
  converter: MarkdownConverter,
): Promise<string[]> {
  const whole = await converter.md2html(markdown);
  if (whole.length <= NOTE_MAX_CHARS) { return [wrapNoteHtml(whole)]; }

  const measure = async (piece: string) => (await converter.md2html(piece)).length;
  const groups = pack(await units(markdown, NOTE_PART_CHARS, measure), NOTE_PART_CHARS);
  if (groups.length < 2) { return [wrapNoteHtml(whole)]; }

  const width = String(groups.length).length;
  return Promise.all(groups.map(async (group, index) => {
    const number = String(index + 1).padStart(width, "0");
    const heading = firstHeading(group);
    const marker = `<p>Part ${number}/${groups.length}` +
      (heading ? ` · ${escapeHtml(heading)}` : "") + "</p>";
    return wrapNoteHtml(marker + await converter.md2html(group));
  }));
}

/**
 * Create, replace, or keep the Raw note under `parent`.
 *
 * With `skip` and an existing note, nothing is converted at all: the user's edits
 * are the reason to keep it, and rendering the Markdown again would only spend the
 * time to throw the result away.
 *
 * Replace reuses the existing notes in order and creates any extra parts. Old parts
 * no longer needed go to the trash, not away, and only when they carry the part
 * line: a note without it may be the user's and is left alone.
 */
export async function publishRawNote(
  parent: Zotero.Item,
  markdown: string,
  existing: RawNoteExisting,
  converter: MarkdownConverter = { md2html: markdownToNoteHtml },
): Promise<RawNoteResult> {
  const current = rawNotes(parent);
  if (current.length && existing === "skip") {
    return { outcome: "kept", parts: 0, chars: 0, oversize: false };
  }

  const htmls = await renderRawNote(markdown, converter);
  for (const [index, html] of htmls.entries()) {
    let note = current[index];
    if (!note) {
      note = new Zotero.Item("note");
      note.libraryID = parent.libraryID;
      note.parentID = parent.id;
      tagOwnedNote(note, "raw-note");
    }
    note.setNote(html);
    await note.saveTx();
  }
  for (const stale of current.slice(htmls.length)) {
    if (partNumber(stale.getNote()) > 0) {
      stale.deleted = true;
      await stale.saveTx();
    }
  }

  return {
    outcome: current.length ? "replaced" : "created",
    parts: htmls.length,
    chars: htmls.reduce((total, html) => total + html.length, 0),
    oversize: htmls.some((html) => html.length > NOTE_MAX_CHARS),
  };
}
