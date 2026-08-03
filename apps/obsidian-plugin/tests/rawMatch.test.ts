import { describe, expect, it } from "vitest";
import { matchRawFrontmatter } from "../src/rawMatch";

const settings = {
  itemKeyProperty: "zotero-key",
  citekeyProperty: "citekey",
};

const paper = {
  libraryID: 1,
  itemKey: "HLP48L8X",
  citekey: "smith2020",
};

describe("matchRawFrontmatter", () => {
  it("matches the configured item-key property first", () => {
    expect(matchRawFrontmatter(
      { "zotero-key": "HLP48L8X", uid: "other" },
      paper,
      settings,
    )).toBe("itemKeyProperty");
  });

  it("matches conversion uid (= itemKey)", () => {
    expect(matchRawFrontmatter(
      { uid: "HLP48L8X", title: "A paper" },
      paper,
      settings,
    )).toBe("uid");
  });

  it("matches legacy unizero-libraryID-itemKey uid", () => {
    expect(matchRawFrontmatter(
      { uid: "unizero-1-HLP48L8X" },
      paper,
      settings,
    )).toBe("uid");
  });

  it("matches unizero-item libraryID:itemKey", () => {
    expect(matchRawFrontmatter(
      { "unizero-item": "1:HLP48L8X" },
      paper,
      settings,
    )).toBe("unizero-item");
  });

  it("does not treat another library's unizero-item as a hit", () => {
    expect(matchRawFrontmatter(
      { "unizero-item": "2:HLP48L8X" },
      paper,
      settings,
    )).toBeUndefined();
  });

  it("falls back to the citekey property", () => {
    expect(matchRawFrontmatter(
      { citekey: "smith2020" },
      paper,
      settings,
    )).toBe("citekeyProperty");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchRawFrontmatter(
      { title: "Something else", uid: "OTHERKEY" },
      paper,
      settings,
    )).toBeUndefined();
    expect(matchRawFrontmatter(undefined, paper, settings)).toBeUndefined();
  });
});
