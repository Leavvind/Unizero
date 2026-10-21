/**
 * Keys that turn the reader's selection into a highlight: `Cmd+Option+B` / `R` / `P`
 * highlight it blue / red / purple. On Windows and Linux `Ctrl+Alt` takes the place of
 * `Cmd+Option`, as the platform's own shortcuts do. The keys are meant to be bound to
 * mouse buttons or gestures. Pure, so the key table can be tested without a browser.
 */

import { config } from "../../package.json";

/** Master switch for the selection shortcuts. The key predates the reader-only scope. */
export const SELECTION_SHORTCUTS_PREF = `${config.addonRef}.editShortcuts`;

export type HighlightColor = "blue" | "red" | "purple";

/** The reader's annotation colors. */
export const HIGHLIGHT_COLORS: Readonly<Record<HighlightColor, string>> = {
  blue: "#2ea8e5",
  red: "#ff6666",
  purple: "#a28ae5",
};

export interface KeyLike {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** On Windows, AltGr reports Ctrl+Alt; this tells it apart. */
  getModifierState?(key: string): boolean;
}

/** Read by `code`, because Option changes `key` on macOS. */
const COLORS: Readonly<Record<string, HighlightColor>> = {
  KeyB: "blue",
  KeyR: "red",
  KeyP: "purple",
};

/**
 * The highlight color a key press asks for, if it is one of these shortcuts; `isMac`
 * picks Cmd over Ctrl. AltGr is not Ctrl+Alt: on many Windows layouts it types a
 * character, which must get through. On macOS Option is not checked for it, since
 * Cmd+Option types nothing.
 */
export function highlightKey(key: KeyLike, isMac: boolean): HighlightColor | undefined {
  const primary = isMac ? key.metaKey : key.ctrlKey;
  const other = isMac ? key.ctrlKey : key.metaKey;
  if (!primary || other || !key.altKey || key.shiftKey) { return undefined; }
  if (!isMac && key.getModifierState?.("AltGraph")) { return undefined; }
  return COLORS[key.code];
}
