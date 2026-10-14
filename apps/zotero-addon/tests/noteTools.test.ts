import { Window } from "happy-dom";
import { TOOL_COLORS, toolAction, type KeyLike } from "../src/notes/noteTools";
import { attachTools, detachTools } from "../src/zotero/noteTools";

const key = (code: string, modifiers: Partial<KeyLike> = {}): KeyLike => ({
  code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers,
});

describe("note tool keys", () => {
  it("picks the highlight tool with Alt+1 and the eraser with Alt+2", () => {
    expect(toolAction(key("Digit1", { altKey: true }), undefined)).toEqual({ type: "tool", tool: "highlight" });
    expect(toolAction(key("Digit2", { altKey: true }), "highlight")).toEqual({ type: "tool", tool: "erase" });
    expect(toolAction(key("Digit3", { altKey: true }), undefined)).toBeUndefined();
    expect(toolAction(key("Digit0", { altKey: true }), undefined)).toBeUndefined();
  });

  it("takes bare digits and Escape only while a tool is on", () => {
    expect(toolAction(key("Digit2"), undefined)).toBeUndefined();
    expect(toolAction(key("Escape"), undefined)).toBeUndefined();
    expect(toolAction(key("Digit2"), "highlight")).toEqual({ type: "color", index: 1 });
    expect(toolAction(key("Digit4"), "highlight")).toEqual({ type: "color", index: 3 });
    expect(toolAction(key("Digit5"), "highlight")).toBeUndefined();
    expect(toolAction(key("Digit0"), "highlight")).toBeUndefined();
    expect(toolAction(key("Escape"), "highlight")).toEqual({ type: "exit" });
  });

  it("leaves digits alone while erasing", () => {
    expect(toolAction(key("Digit1"), "erase")).toBeUndefined();
    expect(toolAction(key("Escape"), "erase")).toEqual({ type: "exit" });
  });

  it("leaves Ctrl, Cmd and Shift combinations to the editor", () => {
    expect(toolAction(key("Digit1", { ctrlKey: true }), "highlight")).toBeUndefined();
    expect(toolAction(key("Digit1", { metaKey: true, altKey: true }), undefined)).toBeUndefined();
    expect(toolAction(key("Digit1", { shiftKey: true }), "highlight")).toBeUndefined();
  });

  it("numbers the colors in the reader's order", () => {
    expect(TOOL_COLORS.map((color) => color.name)).toEqual(["Yellow", "Red", "Green", "Blue"]);
  });
});

describe("note tools in the editor window", () => {
  let zotero: any;
  let original: unknown;
  let calls: string[];

  beforeEach(() => {
    zotero = (globalThis as any).Zotero;
    original = zotero.Prefs;
    zotero.Prefs = { get: () => true, set: () => undefined };
    calls = [];
  });

  afterEach(() => { zotero.Prefs = original; });

  function editorWindow(selectionEmpty = false) {
    const win = new Window({ url: "http://localhost/" });
    win.document.body.innerHTML = `<div class="editor-core"><div class="primary-editor"><p>some text</p></div></div>`;
    const plugin = (name: string) => ({
      setColor: (color: string) => calls.push(`${name}:set:${color}`),
      removeColor: () => calls.push(`${name}:remove`),
    });
    (win as any).wrappedJSObject = {
      _currentEditorInstance: {
        _editorCore: {
          view: { state: { selection: { empty: selectionEmpty } } },
          pluginState: {
            highlightColor: plugin("highlight"), underlineColor: plugin("underline"), textColor: plugin("text"),
          },
        },
      },
    };
    return win as unknown as globalThis.Window;
  }

  const press = (win: Window, code: string, altKey = false) => {
    const event = new (win as any).KeyboardEvent("keydown", { code, altKey, bubbles: true, cancelable: true });
    win.document.dispatchEvent(event);
    return event;
  };
  const badge = (win: Window) => win.document.getElementById("unizero-note-tool") as HTMLElement;

  it("shows the tool, takes the digit that picks a color, and applies it to the selection", () => {
    const win = editorWindow();
    attachTools(win, "");
    expect(badge(win).hidden).toBe(true);
    press(win, "Digit1", true);
    expect(badge(win).hidden).toBe(false);
    expect(badge(win).textContent).toContain("Highlight · Yellow");
    const event = press(win, "Digit3");
    expect(event.defaultPrevented).toBe(true);
    expect(calls).toEqual(["highlight:set:#5fb23680"]);
    expect(badge(win).textContent).toContain("Green");
    detachTools(win);
  });

  it("does not take digits when no tool is on, and does not color an empty selection", () => {
    const win = editorWindow(true);
    attachTools(win, "");
    expect(press(win, "Digit1").defaultPrevented).toBe(false);
    press(win, "Digit1", true);
    press(win, "Digit2");
    expect(calls).toEqual([]);
    expect(badge(win).textContent).toContain("Highlight · Red");
    detachTools(win);
  });

  it("toggles a tool off with the same key and with Escape", () => {
    const win = editorWindow();
    attachTools(win, "");
    press(win, "Digit1", true);
    press(win, "Digit1", true);
    expect(badge(win).hidden).toBe(true);
    press(win, "Digit1", true);
    press(win, "Escape");
    expect(badge(win).hidden).toBe(true);
    detachTools(win);
  });

  it("switches from highlighting to erasing, which takes no digits", () => {
    const win = editorWindow();
    attachTools(win, "");
    press(win, "Digit1", true);
    press(win, "Digit2", true);
    expect(badge(win).textContent).toContain("Erase");
    expect(press(win, "Digit1").defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    detachTools(win);
  });

  it("clears highlight, underline and text colors when the mouse is released in erase mode", async () => {
    const win = editorWindow();
    attachTools(win, "");
    press(win, "Digit2", true);
    win.document.querySelector(".primary-editor")!
      .dispatchEvent(new (win as any).MouseEvent("mouseup", { button: 0, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls).toEqual(["highlight:remove", "underline:remove", "text:remove"]);
    detachTools(win);
  });

  it("removes everything it added, and does nothing when switched off", () => {
    const win = editorWindow();
    attachTools(win, "");
    attachTools(win, "");
    expect(win.document.querySelectorAll("#unizero-note-tool")).toHaveLength(1);
    detachTools(win);
    expect(badge(win)).toBeNull();
    expect(win.document.getElementById("unizero-note-tools-style")).toBeNull();
    expect(press(win, "Digit1", true).defaultPrevented).toBe(false);
    zotero.Prefs = { get: () => false, set: () => undefined };
    attachTools(win, "");
    expect(badge(win)).toBeNull();
  });
});
