/**
 * Note editor integration: styles the note-editor iframe, adds "copy link" items to
 * its right-click menu and the selection shortcuts, and reports what the editor exposes
 * so later work can be checked against a real Zotero.
 *
 * Zotero has no public hook for a note editor appearing. Like Better Notes, this
 * wraps `Zotero.Notes.registerEditorInstance`, which is private: it fires at the
 * start of an editor's `init()`, so the editor is set up once `_initPromise`
 * settles. The wrapper is inert after `unregisterNoteEditorStyle`, even when
 * another add-on has wrapped it again and it cannot be taken off.
 */

import { config } from "../../package.json";
import { sectionAtBlock, type NoteLocation } from "../notes/noteLocation";
import { noteLink } from "./noteLinks";
import { blockIndexOf, editorCore, editorRoot, liveWindow, readBlocks } from "./noteNavigation";
import { attachOutline, detachOutline, hasOutline } from "./noteOutline";
import { attachShortcuts, describeShortcutHandles, detachShortcuts } from "./noteShortcuts";

const STYLE_ID = `${config.addonRef}-note-editor-style`;
const STYLE_PREF = `${config.addonRef}.noteEditor.style`;
const STYLE_PATH = "chrome/content/styles/note-editor.css";
const OUTLINE_STYLE_PATH = "chrome/content/styles/note-outline.css";
const MENU_CLASS = `${config.addonRef}-note-link-item`;

type RegisterEditorInstance = (instance: Zotero.EditorInstance) => void;

let active = false;
let css = "";
let outlineCss = "";
let original: RegisterEditorInstance | undefined;
let wrapper: RegisterEditorInstance | undefined;
/** The top-level block each editor document last had a right-click on. */
const contextBlock = new WeakMap<Document, number>();

/** Install the hook and set up every open editor. Idempotent. */
export async function registerNoteEditorStyle(): Promise<void> {
  if (active) { return; }
  // The probe needs none of the style, so it is available even if the file cannot be read.
  addon.api.noteEditorProbe = probeNoteEditors;
  // `rootURI` is a jar: or file: URL, which `Zotero.File.getContentsAsync` would take for a path.
  css = await readAddonFile(STYLE_PATH);
  outlineCss = await readAddonFile(OUTLINE_STYLE_PATH);
  const notes = Zotero.Notes;
  original = notes.registerEditorInstance;
  wrapper = function (this: unknown, instance: Zotero.EditorInstance) {
    original!.call(this, instance);
    void setUpWhenReady(instance);
  };
  notes.registerEditorInstance = wrapper;
  active = true;
  for (const editor of notes._editorInstances) { void setUpWhenReady(editor); }
}

/** Take the hook off and undo the setup in every open editor. */
export function unregisterNoteEditorStyle(): void {
  delete addon.api.noteEditorProbe;
  if (!active) { return; }
  active = false;
  const notes = Zotero.Notes;
  if (wrapper && notes.registerEditorInstance === wrapper && original) {
    notes.registerEditorInstance = original;
  }
  original = undefined;
  wrapper = undefined;
  for (const editor of notes._editorInstances) { tearDown(editor); }
}

async function readAddonFile(path: string): Promise<string> {
  const response = await fetch(rootURI + path);
  if (!response.ok) { throw new Error(`cannot read ${path}: ${response.status}`); }
  return response.text();
}

async function setUpWhenReady(editor: Zotero.EditorInstance): Promise<void> {
  try {
    // `registerEditorInstance` runs before `init()` assigns the fresh promise,
    // and on a reinit before the new core exists: yield once, then wait on it.
    await Promise.resolve();
    await editor._initPromise;
    if (!active || editor._item?.itemTypeID !== Zotero.ItemTypes.getID("note")) { return; }
    applyStyle(editor);
    attachContextMenu(editor);
    // The item pane's copy is too narrow for a sidebar; only a tab gets one.
    const win = liveWindow(editor);
    if (win && editor._tabID) { attachOutline(win, outlineCss); }
    if (win && !editor._readOnly) { attachShortcuts(win); }
  } catch (error) {
    // The editor can be torn down before it finishes starting.
    Zotero.debug(`UniZero: note editor setup skipped: ${error}`);
  }
}

function tearDown(editor: Zotero.EditorInstance): void {
  const win = liveWindow(editor);
  win?.document.getElementById(STYLE_ID)?.remove();
  if (win) { detachOutline(win); detachShortcuts(win); }
  win?.document.removeEventListener("contextmenu", onContextMenu, true);
  try {
    editor._popup?.removeEventListener("popupshowing", onPopupShowing);
    removeMenuItems(editor._popup);
  } catch {
    // The popup goes with its editor.
  }
}

function applyStyle(editor: Zotero.EditorInstance): void {
  const win = liveWindow(editor);
  if (!win) { return; }
  const doc = win.document;
  doc.getElementById(STYLE_ID)?.remove();
  if (!Zotero.Prefs.get(STYLE_PREF)) { return; }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  (doc.head || doc.documentElement).appendChild(style);
}

// ---- Right-click menu: copy a link to a block or a section ----

/** Adding the same listener again is a no-op, so a reinit does not stack them. */
function attachContextMenu(editor: Zotero.EditorInstance): void {
  liveWindow(editor)?.document.addEventListener("contextmenu", onContextMenu, true);
  editor._popup?.addEventListener("popupshowing", onPopupShowing);
}

/** Remember which block the right-click landed on; the menu opens after this runs. */
function onContextMenu(event: Event): void {
  const doc = event.currentTarget as Document;
  const root = doc.querySelector(".primary-editor");
  const index = root ? blockIndexOf(root, event.target as Node) : undefined;
  if (index === undefined) { contextBlock.delete(doc); } else { contextBlock.set(doc, index); }
}

function removeMenuItems(popup: any): void {
  popup?.querySelectorAll(`.${MENU_CLASS}`).forEach((element: Element) => element.remove());
}

function onPopupShowing(event: Event): void {
  const popup = event.currentTarget as any;
  if (event.target !== popup) { return; }
  removeMenuItems(popup);
  const editor = active ? Zotero.Notes._editorInstances.find((candidate) => candidate._popup === popup) : undefined;
  const win = editor && liveWindow(editor);
  const root = win && editorRoot(win);
  if (!editor || !win || !root || !noteLink(editor._item)) { return; }
  // The right-click target, else wherever the caret is.
  const index = contextBlock.get(win.document) ?? blockIndexOf(root, win.getSelection()?.anchorNode ?? null);
  if (index === undefined) { return; }
  const blocks = readBlocks(root);
  const section = sectionAtBlock(blocks, index);
  const doc = popup.ownerDocument;
  const add = (element: Element) => { element.classList.add(MENU_CLASS); popup.appendChild(element); };
  add(doc.createXULElement("menuseparator"));
  const entries: Array<{ label: string; location: NoteLocation; text: string }> = [
    { label: "Copy link to this block", location: { line: index }, text: blocks[index].text.trim().slice(0, 40) || `#${index}` },
  ];
  if (section) {
    entries.push({
      label: "Copy link to this section",
      location: { section: section.section, occurrence: section.occurrence },
      text: section.section,
    });
  }
  for (const entry of entries) {
    const item = doc.createXULElement("menuitem");
    item.setAttribute("label", entry.label);
    item.addEventListener("command", () => copyLink(editor._item, entry.location, entry.text));
    add(item);
  }
}

/** Put the link on the clipboard as plain text and as an anchor; Obsidian turns the anchor into a Markdown link. */
function copyLink(note: Zotero.Item, location: NoteLocation, text: string): void {
  const url = noteLink(note, location);
  if (!url) { return; }
  const label = `${note.getNoteTitle()} › ${text}`;
  new ztoolkit.Clipboard()
    .addText(url, "text/plain")
    .addText(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`, "text/html")
    .copy();
  new ztoolkit.ProgressWindow("UniZero", { closeOtherProgressWindows: true })
    .createLine({ text: `Link copied: ${label}`, type: "success" })
    .show(2000);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- Probe ----

export interface NoteEditorProbe {
  hasEditorInstances: boolean;
  getByTabID: string;
  css: { lightDark: boolean; oklch: boolean };
  editors: Array<Record<string, unknown>>;
}

/**
 * What a real Zotero exposes about its open note editors: whether the private
 * handles Better Notes relies on exist, and whether the editor's top-level DOM
 * children line up with ProseMirror's top-level blocks. Read-only. Run it from
 * Zotero's Developer > Run JavaScript, which shows only a returned value:
 * `return JSON.stringify(await Zotero.UniZero.api.noteEditorProbe(), null, 2)`.
 */
export async function probeNoteEditors(): Promise<NoteEditorProbe> {
  const notes = Zotero.Notes;
  const mainWin = Zotero.getMainWindow() as any;
  const supports = (property: string, value: string) => {
    try { return !!mainWin.CSS.supports(property, value); } catch { return false; }
  };
  const editors: Array<Record<string, unknown>> = [];
  for (const editor of notes._editorInstances || []) {
    const report: Record<string, unknown> = {
      itemKey: editor._item?.key,
      libraryID: editor._item?.libraryID,
      tabID: editor._tabID,
      disableUI: editor._disableUI,
      readOnly: editor._readOnly,
    };
    const win = liveWindow(editor);
    report.alive = !!win;
    if (win) { try { Object.assign(report, inspectEditorWindow(win)); } catch (error) { report.error = String(error); } }
    editors.push(report);
  }
  return {
    hasEditorInstances: Array.isArray(notes._editorInstances),
    getByTabID: typeof notes.getByTabID,
    css: { lightDark: supports("color", "light-dark(red, blue)"), oklch: supports("color", "oklch(0.5 0.1 100)") },
    editors,
  };
}

function inspectEditorWindow(win: Window): Record<string, unknown> {
  const doc = win.document;
  const root = editorRoot(win);
  const report: Record<string, unknown> = {
    styleApplied: !!doc.getElementById(STYLE_ID),
    outlinePanel: hasOutline(win),
    shortcuts: describeShortcutHandles(win),
    colorScheme: win.getComputedStyle(doc.documentElement).colorScheme,
    hasPrimaryEditor: !!root,
  };
  if (!root) { return report; }
  report.rootClass = root.className;
  report.domTopLevelChildren = root.children.length;
  report.domChildTags = Array.from(root.children).slice(0, 12).map((child) => child.tagName.toLowerCase());
  report.headings = Array.from(root.children)
    .filter((child) => /^H[1-6]$/.test(child.tagName))
    .slice(0, 8)
    .map((child) => `${child.tagName} ${(child.textContent || "").trim().slice(0, 40)}`);
  const core = doc.querySelector(".editor-core");
  if (core) { report.scroll = { scrollHeight: core.scrollHeight, clientHeight: core.clientHeight }; }
  try {
    const view = editorCore(win)?.view;
    report.prosemirrorView = !!view;
    report.prosemirrorTopLevelBlocks = view?.state?.doc?.childCount ?? null;
  } catch (error) {
    report.prosemirrorView = `error: ${error}`;
  }
  return report;
}
