import { Window } from "happy-dom";
import { HIGHLIGHT_COLORS, editAction, type KeyLike } from "../src/notes/editShortcuts";
import { attachShortcuts, detachShortcuts } from "../src/zotero/noteShortcuts";

const key = (code: string, modifiers: Partial<KeyLike> = {}): KeyLike => ({
  code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers,
});
const cmdOption = { metaKey: true, altKey: true };
const ctrlAlt = { ctrlKey: true, altKey: true };

describe("selection shortcut keys", () => {
  it("maps Cmd+Option+B/R/P to blue, red and purple, and Cmd+Option+\\ to clear, on macOS", () => {
    expect(editAction(key("KeyB", cmdOption), true)).toEqual({ type: "highlight", color: "blue" });
    expect(editAction(key("KeyR", cmdOption), true)).toEqual({ type: "highlight", color: "red" });
    expect(editAction(key("KeyP", cmdOption), true)).toEqual({ type: "highlight", color: "purple" });
    expect(editAction(key("Backslash", cmdOption), true)).toEqual({ type: "clear" });
  });

  it("uses Ctrl+Alt in place of Cmd+Option elsewhere", () => {
    expect(editAction(key("KeyB", ctrlAlt), false)).toEqual({ type: "highlight", color: "blue" });
    expect(editAction(key("Backslash", ctrlAlt), false)).toEqual({ type: "clear" });
    expect(editAction(key("KeyB", cmdOption), false)).toBeUndefined();
    expect(editAction(key("KeyB", ctrlAlt), true)).toBeUndefined();
  });

  it("needs exactly the platform modifier and Option", () => {
    expect(editAction(key("KeyB", { metaKey: true }), true)).toBeUndefined();
    expect(editAction(key("KeyB", { altKey: true }), true)).toBeUndefined();
    expect(editAction(key("KeyB", { ...cmdOption, shiftKey: true }), true)).toBeUndefined();
    expect(editAction(key("KeyB", { ...cmdOption, ctrlKey: true }), true)).toBeUndefined();
  });

  it("lets AltGr, which Windows reports as Ctrl+Alt, type its character", () => {
    const altGraph = { ...ctrlAlt, getModifierState: (name: string) => name === "AltGraph" };
    expect(editAction(key("KeyB", altGraph), false)).toBeUndefined();
    expect(editAction(key("Backslash", altGraph), false)).toBeUndefined();
    expect(editAction(key("KeyB", { ...ctrlAlt, getModifierState: () => false }), false))
      .toEqual({ type: "highlight", color: "blue" });
    // Gecko may report Option as AltGraph on macOS; Cmd+Option still counts there.
    expect(editAction(key("KeyB", { ...cmdOption, getModifierState: () => true }), true))
      .toEqual({ type: "highlight", color: "blue" });
  });

  it("leaves the reader's own Ctrl+Option+digit keys alone", () => {
    expect(editAction(key("Digit1", ctrlAlt), false)).toBeUndefined();
    expect(editAction(key("Digit1", cmdOption), true)).toBeUndefined();
  });

  it("uses the reader's annotation colors", () => {
    expect(HIGHLIGHT_COLORS).toEqual({ blue: "#2ea8e5", red: "#ff6666", purple: "#a28ae5" });
  });
});

describe("selection shortcuts in the note editor", () => {
  let zotero: any;
  let original: { Prefs: unknown; isMac: unknown };
  let calls: string[];

  beforeEach(() => {
    zotero = (globalThis as any).Zotero;
    original = { Prefs: zotero.Prefs, isMac: zotero.isMac };
    zotero.Prefs = { get: () => true, set: () => undefined };
    zotero.isMac = true;
    calls = [];
  });

  afterEach(() => { Object.assign(zotero, original); });

  function editorWindow(selectionEmpty = false) {
    const win = new Window({ url: "http://localhost/" });
    win.document.body.innerHTML = `<div class="editor-core"><div class="primary-editor"><p>some text</p></div></div>`;
    const marks = { strong: "strong", em: "em", highlight: "highlight", link: "link" };
    const tr = {
      docChanged: false,
      removeMark(from: number, to: number, mark: string) {
        calls.push(`remove:${mark}:${from}-${to}`);
        tr.docChanged = true;
        return tr;
      },
    };
    (win as any).wrappedJSObject = {
      _currentEditorInstance: {
        _editorCore: {
          view: {
            state: { selection: { empty: selectionEmpty, from: 2, to: 6 }, schema: { marks }, tr },
            dispatch: () => calls.push("dispatch"),
          },
          pluginState: { highlightColor: { setColor: (color: string) => calls.push(`set:${color}`) } },
        },
      },
    };
    return win as unknown as globalThis.Window;
  }

  const press = (win: Window, code: string, modifiers: Partial<KeyLike> & { repeat?: boolean } = cmdOption) => {
    const event = new (win as any).KeyboardEvent("keydown", { code, ...modifiers, bubbles: true, cancelable: true });
    win.document.dispatchEvent(event);
    return event;
  };

  it("highlights the selection in the key's color", () => {
    const win = editorWindow();
    attachShortcuts(win);
    expect(press(win, "KeyB").defaultPrevented).toBe(true);
    press(win, "KeyP");
    expect(calls).toEqual(["set:#2ea8e580", "set:#a28ae580"]);
    detachShortcuts(win);
  });

  it("clears every mark but links from the selection", () => {
    const win = editorWindow();
    attachShortcuts(win);
    press(win, "Backslash");
    expect(calls).toEqual(["remove:strong:2-6", "remove:em:2-6", "remove:highlight:2-6", "dispatch"]);
    detachShortcuts(win);
  });

  it("does nothing with only a caret, but still keeps the key from the editor", () => {
    const win = editorWindow(true);
    attachShortcuts(win);
    expect(press(win, "KeyR").defaultPrevented).toBe(true);
    press(win, "Backslash");
    expect(calls).toEqual([]);
    detachShortcuts(win);
  });

  it("acts once for a held key, but keeps the repeats from the editor", () => {
    const win = editorWindow();
    attachShortcuts(win);
    press(win, "KeyB");
    expect(press(win, "KeyB", { ...cmdOption, repeat: true }).defaultPrevented).toBe(true);
    expect(calls).toEqual(["set:#2ea8e580"]);
    detachShortcuts(win);
  });

  it("stops at once when switched off in an open note", () => {
    const win = editorWindow();
    attachShortcuts(win);
    zotero.Prefs = { get: () => false, set: () => undefined };
    expect(press(win, "KeyB").defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    detachShortcuts(win);
  });

  it("leaves other keys, including Cmd+B, to the editor", () => {
    const win = editorWindow();
    attachShortcuts(win);
    expect(press(win, "KeyB", { metaKey: true }).defaultPrevented).toBe(false);
    expect(press(win, "KeyB", ctrlAlt).defaultPrevented).toBe(false);
    expect(press(win, "Digit1", { altKey: true }).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    detachShortcuts(win);
  });

  it("does not stack listeners, takes them off, and stays off when switched off", () => {
    const win = editorWindow();
    attachShortcuts(win);
    attachShortcuts(win);
    press(win, "KeyB");
    expect(calls).toEqual(["set:#2ea8e580"]);
    detachShortcuts(win);
    expect(press(win, "KeyB").defaultPrevented).toBe(false);
    zotero.Prefs = { get: () => false, set: () => undefined };
    attachShortcuts(win);
    expect(press(win, "KeyB").defaultPrevented).toBe(false);
    expect(calls).toEqual(["set:#2ea8e580"]);
  });
});
