/**
 * Reading and moving around a note editor: which block a node belongs to, and
 * scrolling a note's tab to a location.
 *
 * Everything here works on the editor's DOM. The editor's root (`.primary-editor`)
 * has one direct child per top-level ProseMirror block, which the editor probe
 * confirmed against `view.state.doc.childCount`, so no ProseMirror internals are
 * needed. The same note can have several editor instances (the item pane keeps one
 * beside the tab), and only the tab's should be scrolled: it is the one with a
 * `_tabID`.
 */

import { blockIndexForLocation, type NoteBlock, type NoteLocation } from "../notes/noteLocation";

/** The editor's iframe window, or undefined once it is gone or a dead wrapper. */
export function liveWindow(editor: Zotero.EditorInstance): Window | undefined {
  try {
    const win = editor._iframeWindow;
    if (!win || (Components as any).utils.isDeadWrapper(win)) { return undefined; }
    return win;
  } catch {
    return undefined;
  }
}

export function editorRoot(win: Window): Element | null {
  return win.document.querySelector(".primary-editor");
}

/**
 * The editor core inside the iframe, reached through `wrappedJSObject`: a private
 * structure, so callers must expect it to be missing.
 */
export function editorCore(win: Window): any {
  try {
    return (win as any).wrappedJSObject?._currentEditorInstance?._editorCore;
  } catch {
    return undefined;
  }
}

export function readBlocks(root: Element): NoteBlock[] {
  return Array.from(root.children).map((child) => ({
    tag: child.tagName.toLowerCase(),
    text: child.textContent || "",
  }));
}

/** The index of the top-level block containing `node`, or undefined outside the root. */
export function blockIndexOf(root: Element, node: Node | null): number | undefined {
  let current: Node | null = node;
  while (current && current.parentNode !== root) { current = current.parentNode; }
  if (!current) { return undefined; }
  const index = Array.prototype.indexOf.call(root.children, current);
  return index >= 0 ? index : undefined;
}

/** The editor showing this note in a tab, if one is open and its window is alive. */
export function findTabEditor(noteID: number): Zotero.EditorInstance | undefined {
  return Zotero.Notes._editorInstances.find((editor) =>
    editor._item?.id === noteID && editor._tabID && liveWindow(editor));
}

/**
 * Scroll the note's tab to a location, waiting for the tab's editor to appear and
 * load. Returns false when the editor never shows up or nothing matches.
 */
export async function revealNoteLocation(
  noteID: number,
  location: NoteLocation,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const editor = findTabEditor(noteID);
    if (editor) {
      try { await editor._initPromise; } catch { /* a reinit can reject the old promise */ }
      const win = liveWindow(editor);
      const root = win && editorRoot(win);
      if (win && root && root.children.length) {
        if (!scrollToLocation(root, location)) { return false; }
        // The editor can restore its own scroll position or settle its layout after
        // loading; one later pass keeps the target in view.
        await Zotero.Promise.delay(400);
        if (liveWindow(editor) === win) { scrollToLocation(root, location); }
        return true;
      }
    }
    await Zotero.Promise.delay(100);
  }
  return false;
}

function scrollToLocation(root: Element, location: NoteLocation): boolean {
  const index = blockIndexForLocation(readBlocks(root), location);
  const target = index === undefined ? undefined : root.children[index];
  if (!target) { return false; }
  (target as HTMLElement).scrollIntoView(true);
  return true;
}
