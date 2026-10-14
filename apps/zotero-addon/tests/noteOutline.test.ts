import { Window } from "happy-dom";
import { activeEntry, noteOutline, outlineSignature } from "../src/notes/noteOutline";
import { blockIndexForLocation } from "../src/notes/noteLocation";
import { attachOutline, detachOutline } from "../src/zotero/noteOutline";

const block = (tag: string, text = "") => ({ tag, text });

describe("note outline", () => {
  it("lists headings with text, nested by the headings above them", () => {
    const outline = noteOutline([
      block("p", "preface"),
      block("h1", "Book"),
      block("h3", "Skipped a level"),
      block("h2", "Part"),
      block("h3", "Deep"),
      block("h1", "Second book"),
    ]);
    expect(outline.map((entry) => [entry.index, entry.level, entry.depth])).toEqual([
      [1, 1, 0], [2, 3, 1], [3, 2, 1], [4, 3, 2], [5, 1, 0],
    ]);
  });

  it("skips empty headings and collapses whitespace in what it shows", () => {
    const outline = noteOutline([block("h2", "  "), block("h2", " A \n  B ")]);
    expect(outline).toHaveLength(1);
    expect(outline[0]).toMatchObject({ index: 1, text: "A B" });
  });

  it("numbers repeated headings the way a section link resolves them", () => {
    const blocks = [block("h2", "Intro"), block("p", "x"), block("h2", "Method"), block("h2", "Intro")];
    const second = noteOutline(blocks).find((entry) => entry.index === 3)!;
    expect(second.occurrence).toBe(2);
    expect(blockIndexForLocation(blocks, { section: second.text, occurrence: second.occurrence })).toBe(3);
  });

  it("gives equal signatures to outlines that render the same", () => {
    const a = noteOutline([block("h1", "A"), block("p", "one")]);
    const b = noteOutline([block("h1", "A"), block("p", "two")]);
    expect(outlineSignature(a)).toBe(outlineSignature(b));
    expect(outlineSignature(a)).not.toBe(outlineSignature(noteOutline([block("h2", "A")])));
  });

  it("finds the entry the reader is in", () => {
    expect(activeEntry([-300, -40, 10, 400], 24)).toBe(2);
    expect(activeEntry([100, 400], 24)).toBeUndefined();
    expect(activeEntry([], 24)).toBeUndefined();
  });
});

describe("note outline panel", () => {
  let zotero: any;
  let original: unknown;
  let prefs: Record<string, unknown>;

  beforeEach(() => {
    zotero = (globalThis as any).Zotero;
    original = zotero.Prefs;
    prefs = { "unizero.noteEditor.outline": true };
    zotero.Prefs = { get: (key: string) => prefs[key], set: (key: string, value: unknown) => { prefs[key] = value; } };
  });

  afterEach(() => { zotero.Prefs = original; });

  function editorWindow() {
    const win = new Window({ url: "http://localhost/" });
    win.document.body.innerHTML = `
      <div class="editor"><div class="editor-core"><div class="primary-editor">
        <h1>Book</h1><p>text</p><h2>Part</h2><p>more</p>
      </div></div></div>`;
    const root = win.document.querySelector(".primary-editor")!;
    const scrolled: number[] = [];
    Array.from(root.children).forEach((child, index) => {
      (child as any).scrollIntoView = () => { scrolled.push(index); };
    });
    return { win: win as unknown as globalThis.Window, root, scrolled };
  }

  const panel = (win: Window) => win.document.getElementById("unizero-note-outline");

  it("lists the headings and scrolls the editor to one that is clicked", () => {
    const { win, scrolled } = editorWindow();
    attachOutline(win, "/* css */");
    const items = Array.from(panel(win)!.querySelectorAll(".uz-outline-item"));
    expect(items.map((item) => item.textContent)).toEqual(["Book", "Part"]);
    (items[1] as HTMLElement).click();
    expect(scrolled).toEqual([2]);
    expect(items[1].getAttribute("aria-current")).toBe("true");
    detachOutline(win);
  });

  it("closes and reopens, remembering the choice", () => {
    const { win } = editorWindow();
    attachOutline(win, "");
    expect(win.document.documentElement.getAttribute("data-uz-outline")).toBe("open");
    (panel(win)!.querySelector(".uz-outline-close") as HTMLElement).click();
    expect(win.document.documentElement.getAttribute("data-uz-outline")).toBe("closed");
    expect(prefs["unizero.noteEditor.outline.open"]).toBe(false);
    (win.document.getElementById("unizero-note-outline-toggle") as HTMLElement).click();
    expect(prefs["unizero.noteEditor.outline.open"]).toBe(true);
    detachOutline(win);
  });

  it("removes everything it added, and does nothing when switched off", () => {
    const { win } = editorWindow();
    attachOutline(win, "");
    attachOutline(win, "");
    expect(win.document.querySelectorAll("#unizero-note-outline")).toHaveLength(1);
    detachOutline(win);
    expect(panel(win)).toBeNull();
    expect(win.document.getElementById("unizero-note-outline-toggle")).toBeNull();
    expect(win.document.getElementById("unizero-note-outline-style")).toBeNull();
    expect(win.document.documentElement.hasAttribute("data-uz-outline")).toBe(false);

    prefs["unizero.noteEditor.outline"] = false;
    attachOutline(win, "");
    expect(panel(win)).toBeNull();
  });

  it("shows a hint when the note has no headings", () => {
    const { win, root } = editorWindow();
    root.innerHTML = "<p>just text</p>";
    attachOutline(win, "");
    expect(panel(win)!.textContent).toContain("No headings");
    detachOutline(win);
  });
});
