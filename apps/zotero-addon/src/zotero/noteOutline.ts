/**
 * The outline sidebar of a note tab: a panel listing the note's headings, injected
 * into the note-editor iframe beside the text.
 *
 * Better Notes builds this by patching the `note-editor` element and adding a XUL
 * splitter; this stays inside the iframe instead, so it needs no private element API
 * and goes away with the iframe's document. Everything it adds is removed by the
 * dispose function `attachOutline` returns, and by `detachOutline`.
 */

import { config } from "../../package.json";
import { activeEntry, noteOutline, outlineSignature, type OutlineEntry } from "../notes/noteOutline";
import type { NoteBlock } from "../notes/noteLocation";
import { editorRoot } from "./noteNavigation";

const PANEL_ID = `${config.addonRef}-note-outline`;
const TOGGLE_ID = `${config.addonRef}-note-outline-toggle`;
const STYLE_ID = `${config.addonRef}-note-outline-style`;
const OPEN_ATTRIBUTE = "data-uz-outline";
const REBUILD_DELAY_MS = 250;
/** A heading counts as current once its top is this far into the viewport. */
const CURRENT_SLACK_PX = 24;

/** Master switch for the outline. */
export const OUTLINE_PREF = `${config.addonRef}.noteEditor.outline`;
/** Whether the panel is open; shared by every note tab. */
const OPEN_PREF = `${OUTLINE_PREF}.open`;

const disposers = new WeakMap<Document, () => void>();

/** Show the outline in this editor window. Replaces any outline it already has. */
export function attachOutline(win: Window, css: string): void {
  detachOutline(win);
  if (!Zotero.Prefs.get(OUTLINE_PREF)) { return; }
  const doc = win.document;
  const core = doc.querySelector(".editor-core") as HTMLElement | null;
  const host = core?.parentElement;
  if (!core || !host) { return; }

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  (doc.head || doc.documentElement).appendChild(style);

  const panel = doc.createElement("aside");
  panel.id = PANEL_ID;
  const header = doc.createElement("header");
  const title = doc.createElement("span");
  title.textContent = "Outline";
  const close = doc.createElement("button");
  close.className = "uz-outline-close";
  close.title = "Hide outline";
  close.textContent = "×";
  header.append(title, close);
  const list = doc.createElement("nav");
  list.className = "uz-outline-list";
  panel.append(header, list);
  const toggle = doc.createElement("button");
  toggle.id = TOGGLE_ID;
  toggle.title = "Show outline";
  toggle.textContent = "☰";
  host.append(panel, toggle);

  let entries: OutlineEntry[] = [];
  let signature: string | undefined;
  let current: number | undefined;
  let rebuildTimer: number | undefined;
  let frame: number | undefined;

  /** The panel sits below whatever the editor puts above its text, such as the toolbar. */
  const layout = () => {
    panel.style.top = `${core.offsetTop}px`;
    toggle.style.top = `${core.offsetTop + 6}px`;
  };

  const setOpen = (open: boolean) => {
    doc.documentElement.setAttribute(OPEN_ATTRIBUTE, open ? "open" : "closed");
    layout();
  };

  const markCurrent = (next: number | undefined) => {
    if (next === current) { return; }
    current = next;
    list.querySelectorAll("[aria-current]").forEach((item: Element) => item.removeAttribute("aria-current"));
    if (next === undefined) { return; }
    const item = list.querySelector(`[data-entry="${next}"]`);
    item?.setAttribute("aria-current", "true");
    item?.scrollIntoView({ block: "nearest" });
  };

  const updateCurrent = () => {
    const root = editorRoot(win);
    if (!root || !entries.length) { markCurrent(undefined); return; }
    const coreTop = core.getBoundingClientRect().top;
    const tops = entries.map((entry) => {
      const block = root.children[entry.index];
      return block ? block.getBoundingClientRect().top - coreTop : Infinity;
    });
    markCurrent(activeEntry(tops, CURRENT_SLACK_PX));
  };

  const rebuild = () => {
    rebuildTimer = undefined;
    const root = editorRoot(win);
    entries = root ? noteOutline(headingBlocks(root)) : [];
    const next = outlineSignature(entries);
    if (next !== signature) {
      signature = next;
      current = undefined;
      if (!entries.length) {
        const empty = doc.createElement("div");
        empty.className = "uz-outline-empty";
        empty.textContent = "No headings";
        list.replaceChildren(empty);
      } else {
        list.replaceChildren(...entries.map((entry, position) => {
          const item = doc.createElement("button");
          item.className = "uz-outline-item";
          item.dataset.entry = String(position);
          item.style.setProperty("--uz-depth", String(entry.depth));
          item.title = entry.text;
          item.textContent = entry.text;
          return item;
        }));
      }
    }
    layout();
    updateCurrent();
  };

  const scheduleRebuild = () => {
    if (rebuildTimer === undefined) { rebuildTimer = win.setTimeout(rebuild, REBUILD_DELAY_MS); }
  };

  const onScroll = () => {
    if (frame === undefined) {
      frame = win.requestAnimationFrame(() => { frame = undefined; updateCurrent(); });
    }
  };

  const onListClick = (event: Event) => {
    const item = (event.target as Element).closest?.("[data-entry]");
    const entry = item && entries[Number(item.getAttribute("data-entry"))];
    const block = entry && editorRoot(win)?.children[entry.index];
    if (!block) { return; }
    (block as HTMLElement).scrollIntoView(true);
    markCurrent(Number(item.getAttribute("data-entry")));
  };

  // Clicking the panel must not take the caret out of the text.
  const keepFocus = (event: Event) => event.preventDefault();
  const onClose = () => { Zotero.Prefs.set(OPEN_PREF, false); setOpen(false); };
  const onOpen = () => { Zotero.Prefs.set(OPEN_PREF, true); setOpen(true); };

  list.addEventListener("click", onListClick);
  panel.addEventListener("mousedown", keepFocus);
  close.addEventListener("click", onClose);
  toggle.addEventListener("click", onOpen);
  core.addEventListener("scroll", onScroll, { passive: true });
  win.addEventListener("resize", layout);
  const observer = new (win as any).MutationObserver(scheduleRebuild) as MutationObserver;
  observer.observe(core, { childList: true, subtree: true, characterData: true });

  setOpen(Zotero.Prefs.get(OPEN_PREF) !== false);
  rebuild();

  disposers.set(doc, () => {
    observer.disconnect();
    if (rebuildTimer !== undefined) { win.clearTimeout(rebuildTimer); }
    if (frame !== undefined) { win.cancelAnimationFrame(frame); }
    list.removeEventListener("click", onListClick);
    panel.removeEventListener("mousedown", keepFocus);
    close.removeEventListener("click", onClose);
    toggle.removeEventListener("click", onOpen);
    core.removeEventListener("scroll", onScroll);
    win.removeEventListener("resize", layout);
    panel.remove();
    toggle.remove();
    style.remove();
    doc.documentElement.removeAttribute(OPEN_ATTRIBUTE);
  });
}

/** Whether this editor window currently shows an outline panel. */
export function hasOutline(win: Window): boolean {
  return !!win.document.getElementById(PANEL_ID);
}

/** Remove the outline from this editor window, if it has one. */
export function detachOutline(win: Window): void {
  const doc = win.document;
  disposers.get(doc)?.();
  disposers.delete(doc);
}

/**
 * Blocks carrying text only for headings: the outline never reads the rest, and
 * `textContent` of every paragraph of a long book is wasted work on each edit.
 */
function headingBlocks(root: Element): NoteBlock[] {
  return Array.from(root.children).map((child) => {
    const tag = child.tagName.toLowerCase();
    return { tag, text: /^h[1-6]$/.test(tag) ? child.textContent || "" : "" };
  });
}
