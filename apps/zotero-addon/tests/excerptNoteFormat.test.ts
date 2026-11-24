import { describe, expect, it } from "vitest";
import {
  addExcerptToNote,
  newExcerptNote,
  parseExcerptNote,
  parseSelectURI,
  removeExcerptFromNote,
  selectURI,
  type ExcerptInput,
} from "../src/zotero/excerptNoteFormat";

const ATTACHMENT_URI = "http://zotero.org/users/local/abcd/items/9WF3W4YM";
const CITING_URI = "http://zotero.org/users/local/abcd/items/PAPERAAA";
const B = { scope: "library", itemKey: "DICKNIEL" };
const C = { scope: "library", itemKey: "PAPERCCC" };

function input(annotationKey: string, text: string, pageLabel = "7"): ExcerptInput {
  return {
    annotationKey,
    attachmentURI: ATTACHMENT_URI,
    citingItemURI: CITING_URI,
    text,
    pageLabel,
    position: { pageIndex: Number(pageLabel) - 1, rects: [[1, 2, 3, 4]] },
    color: "#ffd400",
    citationLabel: `Author, 2020, p. ${pageLabel}`,
  };
}

/** A note as Zotero writes one when highlights are dragged in (attribute order varies). */
function zoteroNote(): string {
  const annotation = encodeURIComponent(JSON.stringify({
    attachmentURI: ATTACHMENT_URI,
    annotationKey: "CET4ELBZ",
    color: "#ffd400",
    pageLabel: "7",
    position: { pageIndex: 6, rects: [[0, 0, 1, 1]] },
  }));
  return `<div data-citation-items="%5B%5D" data-schema-version="9"><h1>Cited passages</h1>
<p>My own preface, untouched.</p>
<h2><a href="zotero://select/library/items/DICKNIEL" rel="noopener noreferrer nofollow">Dick-Nielsen (2014)</a></h2>
<p><span data-annotation="${annotation}" class="highlight">“Following Dick-Nielsen (2014), we clean the TRACE data &amp; adjust records.”</span> <span class="citation" data-citation="%7B%7D">(<span class="citation-item">A, 2020, p. 7</span>)</span></p>
<p>A remark of mine.</p>
</div>`;
}

describe("select links", () => {
  it("round-trips user and group scopes", () => {
    expect(parseSelectURI(selectURI(B))).toEqual(B);
    expect(parseSelectURI("zotero://select/groups/42/items/ABCD1234"))
      .toEqual({ scope: "groups/42", itemKey: "ABCD1234" });
    expect(parseSelectURI("https://example.org")).toBeUndefined();
  });
});

describe("parseExcerptNote", () => {
  it("reads a section and its highlight as Zotero writes them", () => {
    expect(parseExcerptNote(zoteroNote())).toEqual([{
      target: B,
      label: "Dick-Nielsen (2014)",
      excerpts: [{
        annotationKey: "CET4ELBZ",
        attachmentKey: "9WF3W4YM",
        attachmentURI: ATTACHMENT_URI,
        pageLabel: "7",
        pageIndex: 6,
        text: "Following Dick-Nielsen (2014), we clean the TRACE data & adjust records.",
      }],
    }]);
  });

  it("ignores headings without a select link and highlights outside a section", () => {
    const note = addExcerptToNote(newExcerptNote(), B, "B", input("K1", "one"))
      .replace("<h1>", `<p>${"<span class=\"highlight\" data-annotation=\"%7B%22annotationKey%22%3A%22STRAY%22%7D\">x</span>"}</p><h2>Just a heading</h2><h1>`);
    expect(parseExcerptNote(note).map((section) => section.excerpts.map((e) => e.annotationKey)))
      .toEqual([["K1"]]);
  });

  it("survives undecodable annotation data by skipping that highlight", () => {
    const note = zoteroNote().replace(/data-annotation="[^"]*"/, "data-annotation=\"%E0%A4%A\"");
    expect(parseExcerptNote(note)).toEqual([{ target: B, label: "Dick-Nielsen (2014)", excerpts: [] }]);
  });

  it("merges two sections for the same paper and drops duplicate annotations", () => {
    let note = addExcerptToNote(newExcerptNote(), B, "B", input("K1", "one"));
    note = addExcerptToNote(note, C, "C", input("K2", "two"));
    // A second B section, as a user copy-paste or sync merge could produce.
    note = note.replace("</div>", `<h2><a href="${selectURI(B)}">B again</a></h2>\n`
      + `${addExcerptToNote(newExcerptNote(), B, "B", input("K1", "one")).match(/<p>[\s\S]*?<\/p>/)![0]}`
      + `${addExcerptToNote(newExcerptNote(), B, "B", input("K3", "three")).match(/<p>[\s\S]*?<\/p>/)![0]}</div>`);
    const sections = parseExcerptNote(note);
    expect(sections.map((section) => section.target.itemKey)).toEqual(["DICKNIEL", "PAPERCCC"]);
    expect(sections[0].excerpts.map((e) => e.annotationKey)).toEqual(["K1", "K3"]);
  });
});

describe("addExcerptToNote", () => {
  it("creates the note, the section, and a highlight Zotero can read back", () => {
    const note = addExcerptToNote("", B, "Dick-Nielsen (2014)", input("K1", "  a <b> & c  "));
    expect(note.startsWith("<div data-schema-version=\"9\"><h1>Cited passages</h1>")).toBe(true);
    expect(note).toContain(`<a href="zotero://select/library/items/DICKNIEL">Dick-Nielsen (2014)</a>`);
    const [section] = parseExcerptNote(note);
    expect(section.excerpts).toEqual([{
      annotationKey: "K1",
      attachmentKey: "9WF3W4YM",
      attachmentURI: ATTACHMENT_URI,
      pageLabel: "7",
      pageIndex: 6,
      text: "a <b> & c",
    }]);
    expect(note.trimEnd().endsWith("</div>")).toBe(true);
  });

  it("appends to an existing section and keeps the user's own text in place", () => {
    const before = zoteroNote();
    const note = addExcerptToNote(before, B, "ignored", input("P2DTU3UK", "Using the collected data,"));
    expect(parseExcerptNote(note)[0].excerpts.map((e) => e.annotationKey))
      .toEqual(["CET4ELBZ", "P2DTU3UK"]);
    expect(note).toContain("<p>My own preface, untouched.</p>");
    expect(note).toContain("<p>A remark of mine.</p>");
    expect(note.indexOf("P2DTU3UK")).toBeLessThan(note.indexOf("A remark of mine."));
  });

  it("inserts at a given position and never duplicates an annotation", () => {
    let note = addExcerptToNote("", B, "B", input("K1", "one"));
    note = addExcerptToNote(note, B, "B", input("K2", "two"));
    note = addExcerptToNote(note, B, "B", input("K0", "zero"), 0);
    expect(addExcerptToNote(note, B, "B", input("K2", "two"))).toBe(note);
    expect(parseExcerptNote(note)[0].excerpts.map((e) => e.annotationKey))
      .toEqual(["K0", "K1", "K2"]);
  });

  it("adds a new section at the end, after the others", () => {
    let note = addExcerptToNote("", B, "B", input("K1", "one"));
    note = addExcerptToNote(note, C, "C", input("K2", "two"));
    note = addExcerptToNote(note, B, "B", input("K3", "three"));
    expect(parseExcerptNote(note).map((s) => [s.target.itemKey, s.excerpts.map((e) => e.annotationKey)]))
      .toEqual([["DICKNIEL", ["K1", "K3"]], ["PAPERCCC", ["K2"]]]);
  });

  it("keeps group scope distinct from the user library", () => {
    const group = { scope: "groups/7", itemKey: "DICKNIEL" };
    let note = addExcerptToNote("", B, "B", input("K1", "one"));
    note = addExcerptToNote(note, group, "B (group)", input("K2", "two"));
    expect(parseExcerptNote(note).map((s) => s.target)).toEqual([B, group]);
  });
});

describe("removeExcerptFromNote", () => {
  it("removes one excerpt and keeps the rest", () => {
    let note = addExcerptToNote("", B, "B", input("K1", "one"));
    note = addExcerptToNote(note, B, "B", input("K2", "two"));
    note = removeExcerptFromNote(note, B, "K1");
    expect(parseExcerptNote(note)[0].excerpts.map((e) => e.annotationKey)).toEqual(["K2"]);
  });

  it("drops a section left empty, but not one holding the user's text", () => {
    let note = addExcerptToNote("", B, "B", input("K1", "one"));
    note = addExcerptToNote(note, C, "C", input("K2", "two"));
    expect(parseExcerptNote(removeExcerptFromNote(note, B, "K1")).map((s) => s.target.itemKey))
      .toEqual(["PAPERCCC"]);
    const kept = removeExcerptFromNote(zoteroNote(), B, "CET4ELBZ");
    expect(parseExcerptNote(kept)).toEqual([{ target: B, label: "Dick-Nielsen (2014)", excerpts: [] }]);
    expect(kept).toContain("<p>A remark of mine.</p>");
  });

  it("only removes from the named section, and ignores unknown keys", () => {
    let note = addExcerptToNote("", B, "B", input("K1", "one"));
    note = addExcerptToNote(note, C, "C", input("K1", "one"));
    expect(removeExcerptFromNote(note, B, "NOPE")).toBe(note);
    const next = removeExcerptFromNote(note, C, "K1");
    expect(parseExcerptNote(next).map((s) => [s.target.itemKey, s.excerpts.length]))
      .toEqual([["DICKNIEL", 1]]);
  });

  it("keeps text the user wrote in the highlight's own paragraph", () => {
    const one = addExcerptToNote("", B, "B", input("K1", "one")).match(/<p>([\s\S]*?)<\/p>/)![1];
    const note = `<div data-schema-version="9"><h1>Cited passages</h1>\n<h2><a href="${selectURI(B)}">B</a></h2>\n<p>${one} — why this matters</p>\n</div>`;
    const next = removeExcerptFromNote(note, B, "K1");
    expect(parseExcerptNote(next)).toEqual([{ target: B, label: "B", excerpts: [] }]);
    expect(next).toContain("<p>— why this matters</p>");
  });

  it("keeps a section whose only remaining content is an image", () => {
    let note = addExcerptToNote("", B, "B", input("K1", "one"));
    note = note.replace("</div>", "<p><img data-attachment-key=\"IMAGEKEY\"></p>\n</div>");
    const next = removeExcerptFromNote(note, B, "K1");
    expect(next).toContain("<img data-attachment-key=\"IMAGEKEY\">");
    expect(parseExcerptNote(next).map((s) => s.target)).toEqual([B]);
  });

  it("cuts a highlight and its citation out of a paragraph the user shares", () => {
    const one = addExcerptToNote("", B, "B", input("K1", "one")).match(/<p>([\s\S]*?)<\/p>/)![1];
    const two = addExcerptToNote("", B, "B", input("K2", "two")).match(/<p>([\s\S]*?)<\/p>/)![1];
    const note = `<div data-schema-version="9"><h1>Cited passages</h1>\n<h2><a href="${selectURI(B)}">B</a></h2>\n<p>${one} and ${two} mine</p>\n</div>`;
    const next = removeExcerptFromNote(note, B, "K1");
    expect(parseExcerptNote(next)[0].excerpts.map((e) => e.annotationKey)).toEqual(["K2"]);
    expect(next).not.toContain("citation-item\">Author, 2020, p. 7</span>) and") ;
    expect(next).toContain(" mine</p>");
  });
});
