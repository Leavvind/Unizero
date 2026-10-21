/**
 * Keys that act on the current selection, the same in the note editor and the reader:
 * `Cmd+Option+B` / `R` / `P` highlight it blue / red / purple, and `Cmd+Option+\`
 * clears its formatting (note editor only). On Windows and Linux `Ctrl+Alt` takes the
 * place of `Cmd+Option`, as the platform's own shortcuts do. The keys are meant to be
 * bound to mouse buttons or gestures, and a mouse driver tells apps apart but not
 * Zotero's windows, so one key has to mean the same thing wherever the selection is.
 *
 * Bold and italic are left to the note editor's own `Cmd+B` / `Cmd+I`. The colors are
 * the reader's, which the note editor shares. Pure, so the key table can be tested
 * without a browser.
 */

import { config } from "../../package.json";

/** Master switch for the selection shortcuts, in notes and in the reader. */
export const EDIT_SHORTCUTS_PREF = `${config.addonRef}.editShortcuts`;

export type HighlightColor = "blue" | "red" | "purple";

/** The reader's annotation colors, without the alpha the note editor adds. */
export const HIGHLIGHT_COLORS: Readonly<Record<HighlightColor, string>> = {
  blue: "#2ea8e5",
  red: "#ff6666",
  purple: "#a28ae5",
};

export type EditAction = { type: "highlight"; color: HighlightColor } | { type: "clear" };

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
const ACTIONS: Readonly<Record<string, EditAction>> = {
  KeyB: { type: "highlight", color: "blue" },
  KeyR: { type: "highlight", color: "red" },
  KeyP: { type: "highlight", color: "purple" },
  Backslash: { type: "clear" },
};

/**
 * What a key press means, if it is one of these shortcuts; `isMac` picks Cmd over Ctrl.
 * AltGr is not Ctrl+Alt: on many Windows layouts it types a character, which must get
 * through. On macOS Option is not checked for it, since Cmd+Option types nothing.
 */
export function editAction(key: KeyLike, isMac: boolean): EditAction | undefined {
  const primary = isMac ? key.metaKey : key.ctrlKey;
  const other = isMac ? key.ctrlKey : key.metaKey;
  if (!primary || other || !key.altKey || key.shiftKey) { return undefined; }
  if (!isMac && key.getModifierState?.("AltGraph")) { return undefined; }
  return ACTIONS[key.code];
}
