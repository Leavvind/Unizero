import { describe, expect, it } from "vitest";
import { columnRows, homeColumns, type HomePair, type HomePaper, type HomeTimes } from "../src/ui/unizeroHomeModel";

const paper = (itemKey: string, extra: Partial<HomePaper> = {}): HomePaper => ({
  libraryID: 1, itemKey, itemID: itemKey.charCodeAt(0), title: `${itemKey} paper`,
  authors: [`Ann ${itemKey}`], year: "2020", ...extra,
});
const quote = (annotationKey: string, text = `${annotationKey} text`) => ({ annotationKey, text });
const pair = (citing: string, cited: string, keys: string[], missing = false): HomePair => ({
  citing: `1:${citing}`, cited: `1:${cited}`, missing, excerpts: keys.map((key) => quote(key)),
});

// A quoted B and C; D quoted B; A also quoted a paper since deleted. E has only
// highlights, G only a note, F only loaded References, H nothing at all.
const library = [
  paper("A", { dateAdded: 100 }),
  paper("B", { dateAdded: 300, year: "2014" }),
  paper("C", { dateAdded: 200, year: "2018", title: "Liquidity" }),
  paper("D", { dateAdded: 400 }),
  paper("E", { dateAdded: 500 }),
  paper("F", { dateAdded: 600 }),
  paper("G", { dateAdded: 700 }),
  paper("H", { dateAdded: 800 }),
];
const pairs = [
  pair("A", "B", ["K1", "K2"]),
  pair("A", "C", ["K3"]),
  pair("A", "GONE", ["K4"], true),
  pair("D", "B", ["K5"]),
];
const times: HomeTimes = {
  notes: new Map([["A", 50], ["D", 70]]),
  annotations: new Map([["K1", 10], ["K2", 40], ["K3", 45], ["K5", 60]]),
  highlights: new Map([["A", { count: 6, time: 48 }], ["E", { count: 2, time: 90 }]]),
  userNotes: new Map([["G", 80]]),
  references: new Map([["1:A", 20], ["1:F", 30]]),
};
const summaryOf = (key: string) => library.find((each) => `1:${each.itemKey}` === key);
const keys = (rows: { scopedKey: string }[]) => rows.map((row) => row.scopedKey);
const query = (column: "references" | "citations", extra = {}) =>
  ({ column, sort: "default" as const, query: "", ...extra });

describe("Unizero Home columns", () => {
  const columns = homeColumns(library, pairs, times, summaryOf);

  it("lists papers by their latest activity: highlight, quote, note, References", () => {
    const rows = columnRows(columns.references, query("references"));
    expect(keys(rows)).toEqual(["1:E", "1:G", "1:D", "1:A", "1:F"]);
    expect(rows.map((row) => row.activity?.kind))
      .toEqual(["highlight", "note", "excerpt", "excerpt", "references"]);
    expect(rows[0]).toMatchObject({ highlights: 2, time: 90, partners: [] });
  });

  it("lists under each paper only the papers it quoted, newest quote first", () => {
    const a = columns.references.find((row) => row.scopedKey === "1:A")!;
    expect(a.partners.map((each) => [each.scopedKey, each.excerpts.length, each.time, Boolean(each.paper)]))
      .toEqual([["1:C", 1, 45, true], ["1:B", 2, 40, true], ["1:GONE", 1, undefined, false]]);
    expect(a).toMatchObject({ quotes: 4, highlights: 6, time: 50 });
  });

  it("lists each quoted paper with who quoted it, most recently cited first", () => {
    const rows = columnRows(columns.citations, query("citations"));
    expect(keys(rows)).toEqual(["1:B", "1:C"]);
    expect(rows[0].partners.map((each) => [each.scopedKey, each.time])).toEqual([["1:D", 60], ["1:A", 40]]);
    expect(rows[0]).toMatchObject({ quotes: 3, time: 60 });
  });

  it("does not count an excerpt note that no longer quotes anything", () => {
    // H's note had passages once; all were removed, so it holds no pair.
    const emptied = homeColumns(library, pairs, { ...times, notes: new Map([...times.notes, ["H", 99]]) }, summaryOf);
    expect(keys(emptied.references)).not.toContain("1:H");
  });

  it("only lists papers in scope, but names partners outside it", () => {
    const scoped = homeColumns([library[0], library[2]], pairs, times, summaryOf);
    expect(keys(scoped.references)).toEqual(["1:A"]);
    expect(keys(scoped.citations)).toEqual(["1:C"]);
    expect(scoped.references[0].partners.find((each) => each.scopedKey === "1:B")?.paper?.title).toBe("B paper");
  });

  it("sorts by count, date added or year, and searches partners and passages", () => {
    expect(keys(columnRows(columns.citations, query("citations", { sort: "count" }))))
      .toEqual(["1:B", "1:C"]);
    expect(keys(columnRows(columns.references, query("references", { sort: "dateAdded" }))))
      .toEqual(["1:G", "1:F", "1:E", "1:D", "1:A"]);
    expect(keys(columnRows(columns.citations, query("citations", { sort: "year" }))))
      .toEqual(["1:C", "1:B"]);
    expect(keys(columnRows(columns.references, query("references", { query: "liquidity" }))))
      .toEqual(["1:A"]);
    expect(keys(columnRows(columns.citations, query("citations", { query: "K5 text" }))))
      .toEqual(["1:B"]);
  });
});
