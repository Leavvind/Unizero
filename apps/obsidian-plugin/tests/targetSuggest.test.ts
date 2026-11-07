import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, Editor, EditorPosition, EditorSuggestContext } from "obsidian";
import { readFile } from "fs/promises";
import type UnizeroPlugin from "../src/main";
import type { BridgeArtifacts } from "../src/bridge";
import { LinkTargetSuggest } from "../src/targetSuggest";

vi.mock("obsidian", () => ({ EditorSuggest: class { constructor(public app: unknown) {} setInstructions() {} close() {} }, Notice: class {} }));
vi.mock("fs/promises", () => ({ readFile: vi.fn() }));

const files: BridgeArtifacts = { libraryID: 7, itemKey: "PAPER001", pdfs: [], artifacts: [], markdowns: [
  { key: "RAW1", title: "Working text", purpose: "raw", main: true },
  { key: "USER1", title: "Reading notes", purpose: "user", main: false },
] };

function fixture(suffix: string, listing = files) {
  let line = `[Paper](unizero://paper/7/PAPER001${suffix})`;
  let cursor = { line: 0, ch: line.length - 1 };
  const editor = { getLine: () => line, getCursor: () => cursor,
    replaceRange: (text: string, from: EditorPosition, to: EditorPosition) => { line = line.slice(0, from.ch) + text + line.slice(to.ch); },
    setCursor: (position: EditorPosition) => { cursor = position; } } as unknown as Editor;
  const bridge = { artifacts: vi.fn(async () => listing),
    linkTarget: vi.fn(async (_ref, _action, key) => ({ source: { path: `C:/${key}.md` } })) };
  const trigger = vi.fn();
  const suggest = new LinkTargetSuggest({ workspace: { editorSuggest: { trigger } } } as unknown as App, { bridge } as unknown as UnizeroPlugin);
  const context = { editor, start: { line: 0, ch: 0 }, end: cursor, query: "" } as EditorSuggestContext;
  suggest.context = context;
  return { suggest, context, bridge, trigger, line: () => line };
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(readFile).mockResolvedValue("# Notes\n\nText^result\n"); });

describe("choosing Markdown before completing a location", () => {
  it.each([".md", ".md#Notes", ".md#^", ".md^res"])("chooses the attachment first for %s", async (suffix) => {
    const f = fixture(suffix);
    const choices = await f.suggest.getSuggestions(f.context);
    expect(choices.map((c) => c.label)).toEqual(["Working text", "Reading notes"]);
    expect(f.bridge.linkTarget).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    f.suggest.selectSuggestion(choices[1]);
    expect(f.line()).toContain(".md?attachment=USER1");
    const locations = await f.suggest.getSuggestions(f.context);
    expect(locations.some((c) => c.label === (suffix.includes("^") ? "^result" : "Notes"))).toBe(true);
    expect(f.bridge.linkTarget).toHaveBeenCalledWith(expect.objectContaining({ libraryID: 7, itemKey: "PAPER001" }), "markdown", "USER1");
    expect(readFile).toHaveBeenCalledWith("C:/USER1.md", "utf8");
    expect(f.trigger).toHaveBeenCalled();
  });

  it("selects a lone ordinary Markdown explicitly instead of asking for default Raw", async () => {
    const f = fixture(".md#^", { ...files, markdowns: [files.markdowns![1]] });
    const [choice] = await f.suggest.getSuggestions(f.context);
    expect(choice.text).toBe("?attachment=USER1#^");
    expect(f.bridge.linkTarget).not.toHaveBeenCalled();
  });

  it("continues directly into a sole default Raw", async () => {
    const f = fixture(".md#^", { ...files, markdowns: [files.markdowns![0]] });
    expect((await f.suggest.getSuggestions(f.context)).map((c) => c.label)).toEqual(["^result"]);
    expect(f.bridge.linkTarget).toHaveBeenCalledWith(expect.anything(), "markdown", undefined);
  });

  it("uses an already explicit attachment without loading the candidate list", async () => {
    const f = fixture(".md?attachment=USER1#^");
    expect((await f.suggest.getSuggestions(f.context)).map((c) => c.label)).toEqual(["^result"]);
    expect(f.bridge.artifacts).not.toHaveBeenCalled();
  });
});
