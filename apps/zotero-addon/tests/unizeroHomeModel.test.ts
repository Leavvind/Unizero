import { describe, expect, it } from "vitest";
import {
  columnRows,
  homeColumns,
  paperCredit,
  searchTokens,
  type HomeMention,
  type HomePair,
  type HomePaper,
  type HomeTimes,
} from "../src/ui/unizeroHomeModel";

const paper = (itemKey: string, extra: Partial<HomePaper> = {}): HomePaper => ({
  libraryID: 1, itemKey, itemID: itemKey.charCodeAt(0), title: `${itemKey} paper`,
  authors: [`Ann ${itemKey}`], year: "2020", ...extra,
});
const mention = (text: string, time?: number, purpose: "raw" | "canvas" = "canvas"): HomeMention => ({
  attachmentKey: "NOTE", purpose, line: 0, text, pdf: [], ...(time !== undefined ? { time } : {}),
});
const pair = (citing: string, cited: string, mentions: HomeMention[], missing = false): HomePair => ({
  citing: `1:${citing}`, cited: `1:${cited}`, missing, mentions,
});

// A mentions B and C; D mentions B; A also mentions a paper not in the library.
// E has only annotations; F and H nothing at all.
const library = [
  paper("A", { dateAdded: 100 }),
  paper("B", { dateAdded: 300, year: "2014" }),
  paper("C", { dateAdded: 200, year: "2018", title: "Liquidity" }),
  paper("D", { dateAdded: 400 }),
  paper("E", { dateAdded: 500 }),
  paper("F", { dateAdded: 600 }),
  paper("H", { dateAdded: 800 }),
];
const pairs = [
  pair("A", "B", [mention("B one", 10), mention("B two", 40, "raw")]),
  pair("A", "C", [mention("C liquidity claim", 45)]),
  pair("A", "GONE", [mention("gone", 50)], true),
  pair("D", "B", [mention("K5 text", 60)]),
];
const times: HomeTimes = {
  highlights: new Map([["A", { count: 6, time: 48 }], ["E", { count: 2, time: 90 }]]),
};
const summaryOf = (key: string) => library.find((each) => `1:${each.itemKey}` === key);
const keys = (rows: { scopedKey: string }[]) => rows.map((row) => row.scopedKey);
const query = (column: "references" | "citations", extra = {}) =>
  ({ column, sort: "default" as const, query: "", ...extra });

describe("Uniconnection columns", () => {
  const columns = homeColumns(library, pairs, times, summaryOf);

  it("lists papers by their latest activity: a mention written, an annotation made", () => {
    const rows = columnRows(columns.references, query("references"));
    expect(keys(rows)).toEqual(["1:E", "1:D", "1:A"]);
    expect(rows.map((row) => row.activity?.kind)).toEqual(["highlight", "mention", "mention"]);
    expect(rows[0]).toMatchObject({ highlights: 2, time: 90, partners: [] });
  });

  it("lists under each paper the papers it mentions, newest note first", () => {
    const a = columns.references.find((row) => row.scopedKey === "1:A")!;
    expect(a.partners.map((each) => [each.scopedKey, each.mentions.length, each.time, Boolean(each.paper)]))
      .toEqual([["1:GONE", 1, 50, false], ["1:C", 1, 45, true], ["1:B", 2, 40, true]]);
    expect(a).toMatchObject({ mentions: 4, highlights: 6, time: 50, activity: { kind: "mention", time: 50 } });
  });

  it("lists each mentioned paper with who mentions it, most recently mentioned first", () => {
    const rows = columnRows(columns.citations, query("citations"));
    expect(keys(rows)).toEqual(["1:B", "1:C"]);
    expect(rows[0].partners.map((each) => [each.scopedKey, each.time])).toEqual([["1:D", 60], ["1:A", 40]]);
    expect(rows[0]).toMatchObject({ mentions: 3, time: 60 });
  });

  it("only lists papers in scope, but names partners outside it", () => {
    const scoped = homeColumns([library[0], library[2]], pairs, times, summaryOf);
    expect(keys(scoped.references)).toEqual(["1:A"]);
    expect(keys(scoped.citations)).toEqual(["1:C"]);
    expect(scoped.references[0].partners.find((each) => each.scopedKey === "1:B")?.paper?.title).toBe("B paper");
  });

  it("names a partner in another library", () => {
    const other = paper("X", { libraryID: 2 });
    const crossed = homeColumns(library, [{ citing: "1:A", cited: "2:X", missing: false, mentions: [mention("x", 5)] }],
      times, (key) => key === "2:X" ? other : summaryOf(key));
    expect(crossed.references.find((row) => row.scopedKey === "1:A")?.partners[0]?.paper).toBe(other);
    // The cited paper is not in this scope, so it is no Citations row here.
    expect(crossed.citations).toEqual([]);
  });

  it("sorts by count, date added or year, and searches partners and mention text", () => {
    expect(keys(columnRows(columns.citations, query("citations", { sort: "count" }))))
      .toEqual(["1:B", "1:C"]);
    expect(keys(columnRows(columns.references, query("references", { sort: "dateAdded" }))))
      .toEqual(["1:E", "1:D", "1:A"]);
    expect(keys(columnRows(columns.citations, query("citations", { sort: "year" }))))
      .toEqual(["1:C", "1:B"]);
    expect(keys(columnRows(columns.references, query("references", { query: "liquidity" }))))
      .toEqual(["1:A"]);
    expect(keys(columnRows(columns.citations, query("citations", { query: "K5 text" }))))
      .toEqual(["1:B"]);
  });
});

describe("Uniconnection scope", () => {
  it("describes only the papers that become rows or partners", () => {
    const described: string[] = [];
    const scope = {
      keys: library.map((each) => `1:${each.itemKey}`),
      paper: (key: string) => { described.push(key); return summaryOf(key)!; },
    };
    const lazy = homeColumns(scope, pairs, times, summaryOf);
    expect(lazy).toEqual(homeColumns(library, pairs, times, summaryOf));
    // F and H have no activity and nobody mentions them.
    expect(described.sort()).toEqual(["1:A", "1:B", "1:C", "1:D", "1:E"]);
  });
});

describe("paper text", () => {
  it("credits authors and year", () => {
    expect(paperCredit({ authors: ["Ann Smith"], year: "2014" })).toBe("Smith (2014)");
    expect(paperCredit({ authors: ["Ann Smith", "Bo Lee"] })).toBe("Smith & Lee");
    expect(paperCredit({ authors: ["A X", "B Y", "C Z"], year: "2020" })).toBe("X et al. (2020)");
  });
  it("drops name connectors from a search", () => {
    expect(searchTokens("Smith et al, 2014")).toEqual(["smith", "2014"]);
    expect(searchTokens("al")).toEqual(["al"]);
  });
});

describe("Uniconnection Vault notes", () => {
  const note = { vaultID: "v", vaultName: "Notes", path: "Files/Literature.canvas", title: "Literature", format: "canvas" as const };
  const noted: HomeMention = { purpose: "vault", note, line: 3, nodeId: "card", text: "Cox (2020) in a review", pdf: [], time: 70 };
  const vaultPair: HomePair = { citing: "vault:v:Files/Literature.canvas", cited: "1:C", missing: false, mentions: [noted], note };
  const columns = homeColumns(library, [...pairs, vaultPair], times, summaryOf);

  it("counts a Vault note as a Citations partner, never as a References row", () => {
    expect(keys(columns.references)).not.toContain(vaultPair.citing);
    const c = columns.citations.find((row) => row.scopedKey === "1:C")!;
    expect(c.partners.map((each) => [each.scopedKey, each.note?.title, each.paper?.itemKey])).toEqual([
      ["vault:v:Files/Literature.canvas", "Literature", undefined],
      ["1:A", undefined, "A"],
    ]);
    expect(c).toMatchObject({ mentions: 2, time: 70 });
  });

  it("finds a row by the Vault note's title", () => {
    expect(keys(columnRows(columns.citations, query("citations", { query: "literature" })))).toEqual(["1:C"]);
  });

  it("lists a paper only Vault notes mention", () => {
    const only = homeColumns(library, [{ ...vaultPair, cited: "1:F" }], times, summaryOf);
    expect(keys(only.citations)).toEqual(["1:F"]);
    // Only annotations put rows on the left; being mentioned does not.
    expect(keys(only.references).sort()).toEqual(["1:A", "1:E"]);
  });
});
