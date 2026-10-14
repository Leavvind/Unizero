import {
  blockIndexForLocation,
  formatNoteLocation,
  isEmptyLocation,
  parseNoteLocation,
  sectionAtBlock,
  type NoteBlock,
} from "../src/notes/noteLocation";

const blocks: NoteBlock[] = [
  { tag: "p", text: "preface" },
  { tag: "h1", text: "Book" },
  { tag: "h2", text: "Introduction" },
  { tag: "p", text: "a" },
  { tag: "h2", text: "Method" },
  { tag: "p", text: "b" },
  { tag: "h1", text: "Part two" },
  { tag: "h2", text: " Introduction " },
  { tag: "p", text: "c" },
];

describe("note locations", () => {
  it("reads Better Notes' line and section parameters", () => {
    expect(parseNoteLocation("zotero://note/u/IQQ6S4FN/?line=12")).toEqual({ line: 12 });
    expect(parseNoteLocation("zotero://note/u/IQQ6S4FN/?section=Intro%20to%20X")).toEqual({ section: "Intro to X" });
    expect(parseNoteLocation("zotero://note/u/IQQ6S4FN/")).toEqual({});
  });

  it("reads the occurrence only next to a section, and drops malformed values", () => {
    expect(parseNoteLocation("x?section=Introduction&n=2")).toEqual({ section: "Introduction", occurrence: 2 });
    expect(parseNoteLocation("x?line=3&n=2")).toEqual({ line: 3 });
    expect(parseNoteLocation("x?section=A&n=0")).toEqual({ section: "A" });
    expect(parseNoteLocation("x?line=-1")).toEqual({});
    expect(parseNoteLocation("x?line=abc&section=")).toEqual({});
    expect(parseNoteLocation("x?line=4#frag")).toEqual({ line: 4 });
  });

  it("formats a location, preferring the section", () => {
    expect(formatNoteLocation({})).toBe("");
    expect(formatNoteLocation({ line: 7 })).toBe("?line=7");
    expect(formatNoteLocation({ section: "A & B=C" })).toBe("?section=A%20%26%20B%3DC");
    expect(formatNoteLocation({ section: "Introduction", occurrence: 2 })).toBe("?section=Introduction&n=2");
    expect(formatNoteLocation({ section: "Introduction", occurrence: 1 })).toBe("?section=Introduction");
    expect(formatNoteLocation({ section: "A", line: 9 })).toBe("?section=A");
  });

  it("round-trips through the parser", () => {
    for (const location of [{ line: 0 }, { section: "A & B", occurrence: 3 }, { section: "导论" }]) {
      expect(parseNoteLocation(`x${formatNoteLocation(location)}`)).toEqual(location);
    }
  });

  it("finds a section, counting repeated headings", () => {
    expect(blockIndexForLocation(blocks, { section: "Introduction" })).toBe(2);
    expect(blockIndexForLocation(blocks, { section: "Introduction", occurrence: 2 })).toBe(7);
    expect(blockIndexForLocation(blocks, { section: "Introduction", occurrence: 3 })).toBeUndefined();
    expect(blockIndexForLocation(blocks, { section: "preface" })).toBeUndefined();
  });

  it("clamps a line to the last block and falls back to it when a section is missing", () => {
    expect(blockIndexForLocation(blocks, { line: 4 })).toBe(4);
    expect(blockIndexForLocation(blocks, { line: 99 })).toBe(8);
    expect(blockIndexForLocation(blocks, { section: "Gone", line: 5 })).toBe(5);
    expect(blockIndexForLocation([], { line: 0 })).toBeUndefined();
  });

  it("names the section a block belongs to, with its occurrence", () => {
    expect(sectionAtBlock(blocks, 3)).toEqual({ section: "Introduction", occurrence: 1 });
    expect(sectionAtBlock(blocks, 8)).toEqual({ section: "Introduction", occurrence: 2 });
    expect(sectionAtBlock(blocks, 6)).toEqual({ section: "Part two", occurrence: 1 });
    expect(sectionAtBlock(blocks, 0)).toBeUndefined();
  });

  it("names a heading as its own section, and agrees with the lookup", () => {
    const here = sectionAtBlock(blocks, 7)!;
    expect(blockIndexForLocation(blocks, here)).toBe(7);
  });

  it("tells an empty location", () => {
    expect(isEmptyLocation({})).toBe(true);
    expect(isEmptyLocation({ line: 0 })).toBe(false);
  });
});
