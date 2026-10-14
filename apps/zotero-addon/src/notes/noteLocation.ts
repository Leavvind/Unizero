/**
 * A position inside a note, as carried by a `zotero://note` link's query.
 *
 * `line` and `section` are Better Notes' parameters and keep their meaning, so links
 * it wrote still work: `line` is the index of a top-level block of the note editor
 * (0-based), `section` is a heading's text. A heading text is not unique in a Raw
 * note (split notes and multi-volume books repeat "Introduction"), so UniZero adds
 * `n`: which occurrence of that text, 1-based, absent meaning the first.
 *
 * Pure: it works on a list of blocks read from the editor's DOM, so it can be tested
 * without Zotero.
 */

export interface NoteLocation {
  line?: number;
  section?: string;
  /** Which heading with this text; 1-based. Only meaningful with `section`. */
  occurrence?: number;
}

/** A top-level block of the note editor: its tag (`h2`, `p`, …) and its text. */
export interface NoteBlock {
  tag: string;
  text: string;
}

export function isEmptyLocation(location: NoteLocation): boolean {
  return location.line === undefined && location.section === undefined;
}

/** Read `line`, `section` and `n` from a link's query; anything malformed is dropped. */
export function parseNoteLocation(link: string): NoteLocation {
  const queryStart = link.indexOf("?");
  if (queryStart < 0) { return {}; }
  const query = link.slice(queryStart + 1).split("#")[0];
  const params = new URLSearchParams(query);
  const location: NoteLocation = {};
  const section = params.get("section")?.trim();
  if (section) {
    location.section = section;
    const occurrence = toIndex(params.get("n"));
    if (occurrence !== undefined && occurrence >= 1) { location.occurrence = occurrence; }
  }
  const line = toIndex(params.get("line"));
  if (line !== undefined) { location.line = line; }
  return location;
}

/** The query string for a location, with its leading `?`, or "" for none. */
export function formatNoteLocation(location: NoteLocation): string {
  const parts: string[] = [];
  if (location.section) {
    parts.push(`section=${encodeURIComponent(location.section)}`);
    if (location.occurrence !== undefined && location.occurrence > 1) {
      parts.push(`n=${location.occurrence}`);
    }
  } else if (location.line !== undefined) {
    parts.push(`line=${location.line}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * The index of the block a location names, or undefined when nothing matches.
 * A section wins over a line, as it is the one that survives edits; a line is
 * clamped to the last block, like Better Notes does.
 */
export function blockIndexForLocation(blocks: NoteBlock[], location: NoteLocation): number | undefined {
  if (!blocks.length) { return undefined; }
  if (location.section) {
    const wanted = location.section.trim();
    let seen = 0;
    for (let index = 0; index < blocks.length; index++) {
      if (isHeading(blocks[index]) && blocks[index].text.trim() === wanted) {
        seen += 1;
        if (seen === (location.occurrence ?? 1)) { return index; }
      }
    }
    // A section that is not there falls back to the line, if the link carries one.
    if (location.line === undefined) { return undefined; }
  }
  if (location.line === undefined) { return undefined; }
  return Math.min(location.line, blocks.length - 1);
}

/** The section a block belongs to: the nearest heading at or above it. */
export function sectionAtBlock(blocks: NoteBlock[], index: number): { section: string; occurrence: number } | undefined {
  for (let start = Math.min(index, blocks.length - 1); start >= 0; start--) {
    if (!isHeading(blocks[start])) { continue; }
    const section = blocks[start].text.trim();
    let occurrence = 0;
    for (let previous = 0; previous <= start; previous++) {
      if (isHeading(blocks[previous]) && blocks[previous].text.trim() === section) { occurrence += 1; }
    }
    return { section, occurrence };
  }
  return undefined;
}

function isHeading(block: NoteBlock): boolean {
  return /^h[1-6]$/i.test(block.tag);
}

function toIndex(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) { return undefined; }
  return Number(value);
}
