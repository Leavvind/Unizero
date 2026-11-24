import { beforeEach, describe, expect, it } from "vitest";
import { bridgeExcerptGroups } from "../src/server/bridgePayloads";

const items: Record<string, any> = {
  DICKNIEL: {
    id: 11, key: "DICKNIEL", libraryID: 1, deleted: false,
    getField: (name: string) => ({ title: "Liquidity biases in TRACE", date: "2014-03-01" } as any)[name] || "",
    getCreators: () => [{ firstName: "Jens", lastName: "Dick-Nielsen" }],
  },
  TRASHED1: { id: 12, key: "TRASHED1", libraryID: 1, deleted: true, getField: () => "", getCreators: () => [] },
};

beforeEach(() => {
  (Zotero as any).Items = { getByLibraryAndKey: (_: number, key: string) => items[key] || false };
});

const excerpt = { annotationKey: "CET4ELBZ", attachmentKey: "9WF3W4YM", pageLabel: "7", pageIndex: 6, text: "Following Dick-Nielsen (2014)" };

describe("bridgeExcerptGroups", () => {
  it("adds display fields and a PDF jump link to each passage", () => {
    expect(bridgeExcerptGroups(1, [{ scopedKey: "1:DICKNIEL", missing: false, excerpts: [excerpt] }],
      (_, id) => (id === 11 ? "dicknielsen2014" : undefined))).toEqual([{
      libraryID: 1,
      itemKey: "DICKNIEL",
      inLibrary: true,
      title: "Liquidity biases in TRACE",
      authors: ["Jens Dick-Nielsen"],
      year: "2014",
      citekey: "dicknielsen2014",
      excerpts: [{
        annotationKey: "CET4ELBZ",
        attachmentKey: "9WF3W4YM",
        pageLabel: "7",
        text: "Following Dick-Nielsen (2014)",
        open: "zotero://open-pdf/library/items/9WF3W4YM?page=7&annotation=CET4ELBZ",
      }],
    }]);
  });

  it("keeps passages for a missing or trashed paper, without display fields", () => {
    const groups = bridgeExcerptGroups(1, [
      { scopedKey: "1:GONE0001", missing: true, excerpts: [{ annotationKey: "K", text: "t", pageLabel: "iv" }] },
      { scopedKey: "1:TRASHED1", missing: false, excerpts: [] },
      { scopedKey: "2:ELSEWHERE", missing: false, excerpts: [] },
    ], () => undefined);
    expect(groups.map((group) => [group.itemKey, group.inLibrary, group.title])).toEqual([
      ["GONE0001", false, ""], ["TRASHED1", false, ""],
    ]);
    // No PDF known and a non-numeric page label: no link is invented.
    expect(groups[0].excerpts[0].open).toBeUndefined();
  });

  it("never turns a printed page label into a PDF page", () => {
    const [group] = bridgeExcerptGroups(1, [{ scopedKey: "1:DICKNIEL", missing: false,
      excerpts: [{ annotationKey: "K", attachmentKey: "9WF3W4YM", pageLabel: "215", text: "t" }] }], () => undefined);
    expect(group.excerpts[0].open).toBe("zotero://open-pdf/library/items/9WF3W4YM?annotation=K");
  });
});
