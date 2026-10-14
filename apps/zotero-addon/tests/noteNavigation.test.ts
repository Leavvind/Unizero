import { Window } from "happy-dom";
import {
  blockIndexOf,
  findTabEditor,
  readBlocks,
  revealNoteLocation,
} from "../src/zotero/noteNavigation";

function editorWindow() {
  const win = new Window({ url: "http://localhost/" });
  win.document.body.innerHTML = `
    <div class="editor-core"><div class="primary-editor">
      <p>preface</p>
      <h1>Book</h1>
      <h2>Introduction</h2>
      <p>first <strong>bold <em>deep</em></strong></p>
      <h2>Method</h2>
      <p>second</p>
    </div></div>`;
  const root = win.document.querySelector(".primary-editor")!;
  const scrolled: number[] = [];
  Array.from(root.children).forEach((child, index) => {
    (child as any).scrollIntoView = () => { scrolled.push(index); };
  });
  return { win, root: root as unknown as Element, scrolled };
}

describe("note navigation", () => {
  let zotero: any;
  let original: Record<string, unknown>;

  beforeEach(() => {
    zotero = (globalThis as any).Zotero;
    original = { Notes: zotero.Notes, Promise: zotero.Promise };
    zotero.Promise = { delay: () => Promise.resolve() };
    (globalThis as any).Components = { utils: { isDeadWrapper: () => false } };
  });

  afterEach(() => {
    Object.assign(zotero, original);
    delete (globalThis as any).Components;
  });

  function editor(noteID: number, win: unknown, tabID?: string) {
    return { _item: { id: noteID }, _tabID: tabID, _iframeWindow: win, _initPromise: Promise.resolve() };
  }

  it("reads one block per direct child of the editor root", () => {
    const { root } = editorWindow();
    expect(readBlocks(root).map((block) => block.tag)).toEqual(["p", "h1", "h2", "p", "h2", "p"]);
    expect(readBlocks(root)[3].text).toBe("first bold deep");
  });

  it("finds the top-level block of a deeply nested node, and none outside the root", () => {
    const { win, root } = editorWindow();
    const deep = win.document.querySelector("em")!;
    expect(blockIndexOf(root, deep as unknown as Node)).toBe(3);
    expect(blockIndexOf(root, root.children[1])).toBe(1);
    expect(blockIndexOf(root, win.document.body as unknown as Node)).toBeUndefined();
    expect(blockIndexOf(root, null)).toBeUndefined();
  });

  it("picks the editor that is in a tab, not the item pane's copy of the same note", () => {
    const pane = editor(7, editorWindow().win);
    const tab = editor(7, editorWindow().win, "tab-1");
    zotero.Notes = { _editorInstances: [pane, tab] };
    expect(findTabEditor(7)).toBe(tab);
    expect(findTabEditor(8)).toBeUndefined();
  });

  it("scrolls the tab's editor to a section, and not the item pane's", async () => {
    const pane = editorWindow();
    const tab = editorWindow();
    zotero.Notes = { _editorInstances: [editor(7, pane.win), editor(7, tab.win, "tab-1")] };
    expect(await revealNoteLocation(7, { section: "Method" })).toBe(true);
    expect(tab.scrolled).toEqual([4, 4]);
    expect(pane.scrolled).toEqual([]);
  });

  it("scrolls to a line, and reports a section that is not there", async () => {
    const tab = editorWindow();
    zotero.Notes = { _editorInstances: [editor(7, tab.win, "tab-1")] };
    expect(await revealNoteLocation(7, { line: 2 })).toBe(true);
    expect(tab.scrolled[0]).toBe(2);
    expect(await revealNoteLocation(7, { section: "Gone" })).toBe(false);
  });

  it("gives up when no tab ever shows the note", async () => {
    zotero.Notes = { _editorInstances: [] };
    expect(await revealNoteLocation(7, { line: 0 }, 20)).toBe(false);
  });
});
