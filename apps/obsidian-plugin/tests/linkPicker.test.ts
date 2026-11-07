import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import type UnizeroPlugin from "../src/main";
import { chooseLinkLocation } from "../src/linkPicker";

const ui = vi.hoisted(() => ({ choices: [] as string[], menus: [] as { title: string; labels: string[] }[] }));
vi.mock("obsidian", () => ({
  Modal: class {}, Setting: class {}, Notice: class {},
  SuggestModal: class {
    title = "";
    setPlaceholder(title: string) { this.title = title; }
    getSuggestions(_query: string): { label: string; value: unknown }[] { return []; }
    onChooseSuggestion(_choice: { label: string; value: unknown }) {}
    open() {
      const items = this.getSuggestions("");
      ui.menus.push({ title: this.title, labels: items.map((i) => i.label) });
      const wanted = ui.choices.shift();
      const choice = items.find((item) => item.label.startsWith(wanted!));
      if (!choice) { throw new Error(`No choice matching ${wanted}`); }
      this.onChooseSuggestion(choice);
    }
  },
}));
vi.mock("fs/promises", () => ({ readFile: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks(); ui.choices = ["Markdown /", "Reading notes", "^result"];
  ui.menus = []; vi.mocked(readFile).mockResolvedValue("Text^result\n");
});

describe("reselecting an attachment and its location", () => {
  it("offers ordinary Markdown beside Raw and reads the chosen file", async () => {
    const bridge = {
      artifacts: vi.fn(async () => ({ pdfs: [], artifacts: [], markdowns: [
        { key: "RAW1", title: "Working text", purpose: "raw", main: true },
        { key: "USER1", title: "Reading notes", purpose: "user", main: false },
      ] })),
      linkTarget: vi.fn(async () => ({ source: { path: "C:/Notes.md" } })),
    };
    const target = { kind: "paper" as const, libraryID: 7, itemKey: "PAPER001", action: "detail" as const };
    const chosen = await chooseLinkLocation({ app: {}, bridge } as unknown as UnizeroPlugin, target);
    expect(ui.menus[1].labels).toEqual(["Working text (Raw · default)", "Reading notes (Markdown)"]);
    expect(bridge.linkTarget).toHaveBeenCalledWith(target, "markdown", "USER1");
    expect(readFile).toHaveBeenCalledWith("C:/Notes.md", "utf8");
    expect(chosen).toEqual({ ...target, action: "markdown", attachmentKey: "USER1", location: { kind: "block", value: "result" } });
  });
});
