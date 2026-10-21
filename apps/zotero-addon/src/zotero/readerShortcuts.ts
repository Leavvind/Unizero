/**
 * Selection shortcuts in the reader (keys in `readerShortcutKeys.ts`): the highlight
 * keys turn the selected text into a highlight annotation of their color.
 *
 * The reader already makes a highlight from the selection on `Ctrl+Option+1` (on every
 * platform), in the highlight tool's current color, for PDF, EPUB and snapshots alike.
 * Rather than rebuild annotation positions, a shortcut sets that color for the moment
 * it takes to send the view a `Ctrl+Option+1`, then puts it back: the tool the user
 * picked is not changed. The tool table and the views are private reader structures,
 * so every reach into them is guarded.
 *
 * The internal reader is reached through `wrappedJSObject`, so the view windows it
 * hands out have their Xrays waived. Page code may not call into privileged code, so
 * a listener added through such a window is never called, and an event built from one
 * cannot read its options: every window is unwaived before it is used.
 *
 * There is no public hook for a view appearing, and views come and go (split view,
 * reloads). Selecting text is what the shortcuts need anyway, and it raises the public
 * `renderTextSelectionPopup` event, so that is where the listeners are attached.
 */

import { config } from "../../package.json";
import { HIGHLIGHT_COLORS, SELECTION_SHORTCUTS_PREF, highlightKey } from "./readerShortcutKeys";

/** Every window a listener sits on, with what takes it off. */
const attached = new Map<Window, () => void>();
let registered = false;
/** What the last selection and the last shortcut did, for the probe. */
let lastSelection = "";
let lastShortcut = "";

export function registerReaderShortcuts(): void {
  if (registered) { return; }
  Zotero.Reader.registerEventListener("renderTextSelectionPopup", onSelectionPopup, config.addonID);
  addon.api.readerShortcutProbe = probeReaderShortcuts;
  registered = true;
}

export function unregisterReaderShortcuts(): void {
  delete addon.api.readerShortcutProbe;
  if (registered) {
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", onSelectionPopup);
    registered = false;
  }
  for (const dispose of [...attached.values()]) { dispose(); }
  attached.clear();
}

function onSelectionPopup(event: { reader: _ZoteroTypes.ReaderInstance }): void {
  if (!Zotero.Prefs.get(SELECTION_SHORTCUTS_PREF)) { return; }
  const reader = event.reader as any;
  try {
    // Keys reach the view that has the selection, or the reader's own UI when the popup has focus.
    const windows = [reader._iframeWindow, ...views(reader).map((view) => view._iframeWindow)];
    let count = 0;
    for (const win of windows) {
      const xray = unwaived(win);
      if (xray) { attach(xray, reader); count += 1; }
    }
    lastSelection = `attached to ${count} window(s), ${attached.size} in all`;
  } catch (error) {
    lastSelection = `not attached: ${error}`;
    Zotero.debug(`UniZero: reader shortcuts ${lastSelection}`);
  }
}

function attach(win: Window, reader: any): void {
  if (attached.has(win)) { return; }
  const onKeyDown = (event: KeyboardEvent) => {
    // The switch is read per key, so turning it off takes effect in windows already attached.
    if (event.isComposing || !Zotero.Prefs.get(SELECTION_SHORTCUTS_PREF)) { return; }
    // Text fields in the reader's own UI (annotation comments, search) keep their keys.
    if (isTextField(event.target)) { return; }
    const color = highlightKey(event, Zotero.isMac);
    if (!color) { return; }
    event.preventDefault();
    event.stopPropagation();
    // A held key repeats; one press makes one annotation.
    if (event.repeat) { return; }
    highlightSelection(reader, win, HIGHLIGHT_COLORS[color]);
  };
  const dispose = () => {
    try { win.removeEventListener("keydown", onKeyDown, true); } catch { /* the window is gone */ }
    try { win.removeEventListener("unload", dispose); } catch { /* the window is gone */ }
    attached.delete(win);
  };
  win.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("unload", dispose);
  attached.set(win, dispose);
}

function isTextField(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || /^(input|textarea|select)$/i.test(element.tagName ?? ""));
}

/**
 * Let the reader highlight its selection, in `color` this once. A key pressed in a view
 * goes to that view, which holds the selection; one pressed in the reader's own UI goes
 * to the view last used.
 */
function highlightSelection(reader: any, from: Window, color: string): void {
  try {
    const internal = reader._internalReader;
    const view = views(reader).find((candidate) => unwaived(candidate._iframeWindow) === from)
      ?? (internal._lastViewPrimary === false ? internal._secondaryView : internal._primaryView);
    const tool = internal._tools?.highlight;
    const win: any = unwaived(view?._iframeWindow);
    const target = win?.document?.body;
    if (!tool || !win || !target) {
      lastShortcut = `skipped: tool ${!!tool}, view window ${!!win}, body ${!!target}`;
      return;
    }
    const previous = tool.color;
    tool.color = color;
    try {
      // The view reads the tool's color while handling the event, so it can be put back right after.
      target.dispatchEvent(new win.KeyboardEvent("keydown", {
        code: "Digit1", key: "1", ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
      }));
    } finally {
      tool.color = previous;
    }
    lastShortcut = `sent ${color} to the ${view === internal._primaryView ? "primary" : "secondary"} view`;
  } catch (error) {
    lastShortcut = `failed: ${error}`;
    Zotero.debug(`UniZero: reader highlight shortcut ${lastShortcut}`);
  }
}

function views(reader: any): any[] {
  const internal = reader._internalReader;
  return [internal?._primaryView, internal?._secondaryView].filter(Boolean);
}

/** The window with its Xrays back, so privileged listeners and events work in it. */
function unwaived(win: any): Window | undefined {
  if (!win) { return undefined; }
  try {
    return Components.utils.unwaiveXrays(win);
  } catch {
    return win;
  }
}

/**
 * What the shortcuts can see in the selected reader tab. Read-only. Run it from
 * Zotero's Developer > Run JavaScript after selecting text in a reader:
 * `return JSON.stringify(Zotero.UniZero.api.readerShortcutProbe(), null, 2)`.
 */
export function probeReaderShortcuts(): Record<string, unknown> {
  const report: Record<string, unknown> = {
    enabled: !!Zotero.Prefs.get(SELECTION_SHORTCUTS_PREF),
    isMac: Zotero.isMac,
    registered,
    attachedWindows: attached.size,
    lastSelection,
    lastShortcut,
  };
  try {
    const win = Zotero.getMainWindow() as any;
    const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID) as any;
    if (!reader) { return { ...report, reader: "the selected tab is not a reader" }; }
    const internal = reader._internalReader;
    report.reader = {
      type: reader._type,
      internalReader: !!internal,
      highlightColor: internal?._tools?.highlight?.color,
      lastViewPrimary: internal?._lastViewPrimary,
      views: views(reader).map((view) => {
        const viewWin = unwaived(view._iframeWindow);
        return { window: !!viewWin, attached: !!viewWin && attached.has(viewWin) };
      }),
    };
  } catch (error) {
    report.error = String(error);
  }
  return report;
}
