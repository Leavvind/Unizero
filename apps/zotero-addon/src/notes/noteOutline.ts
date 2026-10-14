/**
 * The outline of a note: its headings as a tree-shaped list, for the sidebar of a note
 * tab.
 *
 * Pure, like `noteLocation.ts`, and built on the same blocks, so an entry's
 * `occurrence` is the `n` a `?section=…&n=` link needs and its `index` is the block
 * to scroll to.
 */

import type { NoteBlock } from "./noteLocation";

export interface OutlineEntry {
  /** Index of the heading among the note's top-level blocks. */
  index: number;
  /** The heading level, 1–6. */
  level: number;
  /** Nesting depth: how many enclosing headings it has, whatever their levels skip. */
  depth: number;
  /** The heading as shown: whitespace collapsed. */
  text: string;
  /** Which heading with this text it is, 1-based; matches `blockIndexForLocation`. */
  occurrence: number;
}

/** Headings with text, in document order. An empty heading has nothing to show or link to. */
export function noteOutline(blocks: NoteBlock[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const seen = new Map<string, number>();
  const open: number[] = [];
  blocks.forEach((block, index) => {
    const match = /^h([1-6])$/i.exec(block.tag);
    const key = block.text.trim();
    if (!match || !key) { return; }
    const level = Number(match[1]);
    while (open.length && open[open.length - 1] >= level) { open.pop(); }
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    entries.push({ index, level, depth: open.length, text: key.replace(/\s+/g, " "), occurrence });
    open.push(level);
  });
  return entries;
}

/** Equal for two outlines that would render the same, so an unchanged one is not redrawn. */
export function outlineSignature(entries: OutlineEntry[]): string {
  return entries.map((entry) => `${entry.index}:${entry.level}:${entry.text}`).join("\n");
}

/**
 * The entry the reader is in: the last one whose top is at or above `threshold`.
 * `tops` is each entry's distance from the top of the viewport, in entry order;
 * returns undefined before the first heading.
 */
export function activeEntry(tops: number[], threshold: number): number | undefined {
  let active: number | undefined;
  for (let entry = 0; entry < tops.length; entry++) {
    if (tops[entry] <= threshold) { active = entry; } else { break; }
  }
  return active;
}
