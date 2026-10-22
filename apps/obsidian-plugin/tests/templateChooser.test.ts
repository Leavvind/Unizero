import { describe, expect, it } from "vitest";
import type { BridgeTemplates } from "../src/bridge";
import { templateMenuEntries } from "../src/templates";

const listed: BridgeTemplates = {
  available: true,
  defaultTemplate: "paper-to-zotero-markdown",
  templates: [
    { id: "paper-to-zotero-markdown", name: "Generate Raw Markdown", description: "" },
    { id: "paper-to-markdown", name: "Generate paper Markdown", description: "" },
  ],
};

describe("template chooser entries", () => {
  it("lists every template and checks the configured default", () => {
    const entries = templateMenuEntries(listed, "paper-to-markdown");

    expect(entries.map((entry) => [entry.title, entry.template, entry.checked])).toEqual([
      ["Generate Raw Markdown", "paper-to-zotero-markdown", false],
      ["Generate paper Markdown", "paper-to-markdown", true],
    ]);
  });

  it("checks Zotero's default when the setting is empty", () => {
    const entries = templateMenuEntries(listed, "");

    expect(entries.map((entry) => entry.checked)).toEqual([true, false]);
  });

  it("still offers the default while the runtime is stopped", () => {
    const [hint, fallback, ...rest] = templateMenuEntries(
      { ...listed, available: false, templates: [] },
      "",
    );

    expect(rest).toEqual([]);
    expect(hint.disabled).toBe(true);
    expect(fallback.disabled).toBe(false);
    // An empty setting sends no template, so Zotero picks its own default.
    expect(fallback.template).toBe("");
    expect(fallback.title).toContain("paper-to-zotero-markdown");
  });
});
