import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";

/**
 * Obsidian's suggest base classes assign these fields in their constructors, so an
 * accessor of the same name on a subclass throws and aborts the plugin's `onload`.
 */
vi.mock("obsidian", () => {
  class EditorSuggest {
    isOpen = false;
    win = null;
    scope = { register: vi.fn() };
    suggestEl = {};
    suggestInnerEl = {};
    suggestions = {};
    instructionsEl = {};
    context = null;
    limit = 100;
    constructor(public app: unknown) {}
    setInstructions(): void {}
  }
  return { EditorSuggest, Notice: class {} };
});

describe("constructing the suggesters", () => {
  const plugin = { register: vi.fn() };

  it("survives the base constructor's field assignments", async () => {
    const { CitationSuggest } = await import("../src/suggest");
    const { LinkTargetSuggest } = await import("../src/targetSuggest");
    const app = {} as App;
    expect(() => new CitationSuggest(app, plugin as never)).not.toThrow();
    expect(() => new LinkTargetSuggest(app, plugin as never)).not.toThrow();
  });
});
