import { describe, expect, it } from "vitest";
import {
  citationRows,
  filterRows,
  libraryRows,
  providerCitationRows,
  referenceRows,
  rowCredit,
  shortAuthors,
  type PaperSummary,
} from "../src/ui/literatureSidebarModel";

const candidate = (title: string, itemID?: number, extra = {}): any => ({
  identifiers: {}, title, authors: ["Ann Smith", "Bo Lee", "Cy Wu"], year: "2014",
  membership: { inLibrary: Boolean(itemID), libraryID: 1, itemID }, ...extra,
});
const keys: Record<number, string> = { 11: "1:B", 12: "1:C", 13: "1:D" };
const keyOf = (c: any) => (c.membership.itemID ? keys[c.membership.itemID] : undefined);
const summaries: Record<string, PaperSummary> = {
  "1:E": { libraryID: 1, itemKey: "E", itemID: 15, title: "Only quoted", authors: ["Eve Ng"], year: "2020" },
};
const summaryOf = (key: string) => summaries[key];
const excerpt = (annotationKey: string, text = "quote") => ({ annotationKey, text });

describe("referenceRows", () => {
  const list = [candidate("Out"), candidate("B paper", 11), candidate("C paper", 12), candidate("B dup", 11)];

  it("puts quoted papers first in note order, then the provider list without duplicates", () => {
    const rows = referenceRows(list, [
      { scopedKey: "1:C", missing: false, excerpts: [excerpt("K1")] },
      { scopedKey: "1:E", missing: false, excerpts: [excerpt("K2")] },
    ], keyOf, summaryOf);
    expect(rows.map((row) => [row.group, row.title, row.excerpts.length])).toEqual([
      ["quoted", "C paper", 1],
      ["quoted", "Only quoted", 1],
      ["provider", "Out", 0],
      ["provider", "B paper", 0],
    ]);
    expect(rows[0]).toMatchObject({ id: "1:C", number: 3, inLibrary: true, missing: false });
    expect(rows[2]).toMatchObject({ id: "provider:0", inLibrary: false });
  });

  it("keeps a quoted paper that is gone, flagged missing", () => {
    const rows = referenceRows([], [{ scopedKey: "1:GONE", missing: true, excerpts: [excerpt("K")] }],
      keyOf, summaryOf);
    expect(rows).toMatchObject([{ id: "1:GONE", missing: true, inLibrary: false, title: "Missing item GONE" }]);
  });

  it("numbers rows by provider order when the snapshot carries one", () => {
    const rows = referenceRows([candidate("X", undefined, { sourceOrder: 6 })], [], keyOf, summaryOf);
    expect(rows[0].number).toBe(7);
  });
});

describe("citationRows", () => {
  const library: Record<string, PaperSummary> = {
    "1:D": { libraryID: 1, itemKey: "D", itemID: 13, title: "D quotes", authors: ["Di Ho"], year: "2019" },
    "1:F": { libraryID: 1, itemKey: "F", itemID: 16, title: "F older", authors: ["Fa Li"], year: "2011" },
    "1:G": { libraryID: 1, itemKey: "G", itemID: 17, title: "G newer", authors: ["Gu Ma"], year: "2022" },
  };
  const libraryOf = (key: string) => library[key];

  it("lists quoting papers first, then the other citing papers newest first, once each", () => {
    const rows = citationRows([{ scopedKey: "1:D", missing: false, excerpts: [excerpt("K")] }],
      ["1:D", "1:F", "1:G", "1:GONE"], libraryOf);
    expect(rows.map((row) => [row.group, row.title])).toEqual([
      ["quoted", "D quotes"], ["library", "G newer"], ["library", "F older"],
    ]);
    expect(rows.every((row) => row.inLibrary)).toBe(true);
  });
});

describe("providerCitationRows", () => {
  it("keeps the provider order and drops papers already listed from the library", () => {
    const listed = citationRows([], ["1:B"], (key) => ({ libraryID: 1, itemKey: key.slice(2), itemID: 11, title: "B", authors: [] }));
    const rows = providerCitationRows(
      [candidate("Out"), candidate("B again", 11), candidate("C paper", 12), candidate("C dup", 12)],
      listed, keyOf);
    expect(rows.map((row) => [row.group, row.title, row.inLibrary, row.id])).toEqual([
      ["provider", "Out", false, "provider:0"],
      ["provider", "C paper", true, "1:C"],
    ]);
  });
});

describe("libraryRows", () => {
  it("drops hits already listed and the paper itself", () => {
    const listed = referenceRows([candidate("B paper", 11)], [], keyOf, summaryOf);
    const hit = (itemKey: string): PaperSummary =>
      ({ libraryID: 1, itemKey, itemID: 1, title: itemKey, authors: [] });
    expect(libraryRows([hit("B"), hit("SELF"), hit("F"), hit("F")], listed, "1:SELF").map((row) => row.id))
      .toEqual(["1:F"]);
  });
});

describe("filterRows", () => {
  const rows = referenceRows([candidate("Liquidity in TRACE", 11), candidate("Bond pricing")],
    [{ scopedKey: "1:B", missing: false, excerpts: [excerpt("K", "we clean the data")] }], keyOf, summaryOf);

  it("matches every token across title, authors, year and quoted text", () => {
    expect(filterRows(rows, "trace smith").map((row) => row.title)).toEqual(["Liquidity in TRACE"]);
    expect(filterRows(rows, "clean, 2014").map((row) => row.title)).toEqual(["Liquidity in TRACE"]);
    expect(filterRows(rows, "smith and clean").map((row) => row.title)).toEqual(["Liquidity in TRACE"]);
    expect(filterRows(rows, "smith & clean, 2014").map((row) => row.title)).toEqual(["Liquidity in TRACE"]);
    expect(filterRows(rows, "  ")).toBe(rows);
    expect(filterRows(rows, "nothing")).toEqual([]);
  });
});

describe("credits", () => {
  it("shortens author lists the way citations read", () => {
    expect(shortAuthors(["Jens Dick-Nielsen"])).toBe("Dick-Nielsen");
    expect(shortAuthors(["A Smith", "B Lee"])).toBe("Smith & Lee");
    expect(shortAuthors(["A Smith", "B Lee", "C Wu"])).toBe("Smith et al.");
    expect(rowCredit({ authors: [], year: "2020" } as any)).toBe("2020");
  });
});
