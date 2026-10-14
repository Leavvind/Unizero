/**
 * Keys and colors of the note editor's annotation tools, shared in spirit with the PDF
 * reader: `Alt+1` picks the highlight tool, then `1`–`4` pick a color and selecting text
 * applies it; `Alt+2` picks the eraser, which clears the colors of what is selected.
 *
 * The reader numbers eight colors; four are enough for notes, and they keep the
 * reader's order for those four (yellow, red, green, blue) so the same digit means the
 * same color in both places. Pure, so the key table can be tested without a browser.
 */

export type ToolName = "highlight" | "erase";

export interface ToolColor {
  name: string;
  /** The editor's own highlight color, with its 50% alpha suffix. */
  value: string;
}

export const TOOL_COLORS: readonly ToolColor[] = [
  { name: "Yellow", value: "#ffd40080" },
  { name: "Red", value: "#ff666680" },
  { name: "Green", value: "#5fb23680" },
  { name: "Blue", value: "#2ea8e580" },
];

export type ToolAction =
  | { type: "tool"; tool: ToolName }
  | { type: "color"; index: number }
  | { type: "exit" };

export interface KeyLike {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * What a key press means. `active` is the tool that is on, if any: only then are bare
 * keys taken, so typing is untouched otherwise. Digits pick a color for the highlight
 * tool only; the eraser leaves them to the editor.
 */
export function toolAction(key: KeyLike, active: ToolName | undefined): ToolAction | undefined {
  if (key.ctrlKey || key.metaKey || key.shiftKey) { return undefined; }
  const digit = /^Digit(\d)$/.exec(key.code)?.[1];
  if (key.altKey) {
    if (digit === "1") { return { type: "tool", tool: "highlight" }; }
    if (digit === "2") { return { type: "tool", tool: "erase" }; }
    return undefined;
  }
  if (!active) { return undefined; }
  if (key.code === "Escape") { return { type: "exit" }; }
  if (active === "highlight" && digit !== undefined) {
    const index = Number(digit) - 1;
    if (index >= 0 && index < TOOL_COLORS.length) { return { type: "color", index }; }
  }
  return undefined;
}
