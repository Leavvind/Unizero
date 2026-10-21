import { HIGHLIGHT_COLORS, highlightKey, type KeyLike } from "../src/zotero/readerShortcutKeys";

const key = (code: string, modifiers: Partial<KeyLike> = {}): KeyLike => ({
  code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers,
});
const cmdOption = { metaKey: true, altKey: true };
const ctrlAlt = { ctrlKey: true, altKey: true };

describe("reader selection shortcut keys", () => {
  it("maps Cmd+Option+B/R/P to blue, red and purple on macOS", () => {
    expect(highlightKey(key("KeyB", cmdOption), true)).toBe("blue");
    expect(highlightKey(key("KeyR", cmdOption), true)).toBe("red");
    expect(highlightKey(key("KeyP", cmdOption), true)).toBe("purple");
  });

  it("uses Ctrl+Alt in place of Cmd+Option elsewhere", () => {
    expect(highlightKey(key("KeyB", ctrlAlt), false)).toBe("blue");
    expect(highlightKey(key("KeyB", cmdOption), false)).toBeUndefined();
    expect(highlightKey(key("KeyB", ctrlAlt), true)).toBeUndefined();
  });

  it("needs exactly the platform modifier and Option", () => {
    expect(highlightKey(key("KeyB", { metaKey: true }), true)).toBeUndefined();
    expect(highlightKey(key("KeyB", { altKey: true }), true)).toBeUndefined();
    expect(highlightKey(key("KeyB", { ...cmdOption, shiftKey: true }), true)).toBeUndefined();
    expect(highlightKey(key("KeyB", { ...cmdOption, ctrlKey: true }), true)).toBeUndefined();
  });

  it("lets AltGr, which Windows reports as Ctrl+Alt, type its character", () => {
    const altGraph = { ...ctrlAlt, getModifierState: (name: string) => name === "AltGraph" };
    expect(highlightKey(key("KeyB", altGraph), false)).toBeUndefined();
    expect(highlightKey(key("KeyB", { ...ctrlAlt, getModifierState: () => false }), false)).toBe("blue");
    // Gecko may report Option as AltGraph on macOS; Cmd+Option still counts there.
    expect(highlightKey(key("KeyB", { ...cmdOption, getModifierState: () => true }), true)).toBe("blue");
  });

  it("leaves the reader's own Ctrl+Option+digit keys, and the old clear key, alone", () => {
    expect(highlightKey(key("Digit1", ctrlAlt), false)).toBeUndefined();
    expect(highlightKey(key("Digit1", cmdOption), true)).toBeUndefined();
    expect(highlightKey(key("Backslash", cmdOption), true)).toBeUndefined();
  });

  it("uses the reader's annotation colors", () => {
    expect(HIGHLIGHT_COLORS).toEqual({ blue: "#2ea8e5", red: "#ff6666", purple: "#a28ae5" });
  });
});
