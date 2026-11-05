import { describe, expect, it } from "vitest";
import { caretAfter, completionAt, jumpAt, locationChoices, pageChoices, targetChoices } from "../src/linkCompletion";
import { parseLinkTarget } from "../src/linkTarget";
import { textAnchors } from "../src/documentLinks";

const paper = "[丁学良, 2017](unizero://paper/1/2BJFPCUL";
/** `|` marks the caret. */
const at = (text: string) => completionAt(text.replace("|", ""), text.indexOf("|"));
const files = {
  pdfs: [{ key: "PDF00001", title: "Paper.pdf", main: true }],
  artifacts: [{ key: "RAW00001", title: "Raw.md", kind: "raw" }, { key: "BAK00001", title: "Backup", kind: "raw-backup" }],
};

describe("what the caret is completing", () => {
  it("starts at the attachment choice right after the item key", () => {
    const c = at(`${paper}|) after`)!;
    expect(c).toMatchObject({ stage: "target", query: "", closes: true, ref: { libraryID: 1, itemKey: "2BJFPCUL" } });
    expect(`${paper}) after`.slice(c.from, c.to)).toBe("");
    expect(at(`${paper}.m|)`)).toMatchObject({ stage: "target", query: ".m" });
  });
  it("moves to locations and pages once the attachment is written", () => {
    expect(at(`${paper}.md|)`)).toMatchObject({ stage: "location", fragment: undefined, target: { action: "markdown" } });
    expect(at(`${paper}.md#Met|)`)).toMatchObject({ stage: "location", fragment: "Met" });
    expect(at(`${paper}.md#^ab|)`)).toMatchObject({ stage: "location", fragment: "^ab" });
    expect(at(`${paper}.md?attachment=RAW1#Met|)`)).toMatchObject({ stage: "location", target: { attachmentKey: "RAW1" } });
    expect(at(`${paper}.pdf|)`)).toMatchObject({ stage: "page", digits: "" });
    expect(at(`${paper}.pdf15|)`)).toMatchObject({ stage: "page", digits: "15" });
    expect(at(`${paper}.pdf:15|)`)).toMatchObject({ stage: "page", digits: "15" });
    expect(at(`${paper}.pdf?attachment=P1&page=15|)`)).toMatchObject({ stage: "page", digits: "15", attachmentKey: "P1" });
  });
  it("completes Vault documents, decoding their identity", () => {
    expect(at("[B](unizero://note/my%20vault/123|)")).toMatchObject({ stage: "location", target: { kind: "note", vaultID: "my vault", uid: "123" } });
    expect(at("[B](unizero://note/v/123#In|)")).toMatchObject({ stage: "location", fragment: "In" });
  });
  it("stays out of the way elsewhere", () => {
    expect(at(`${paper})| after`)).toBeUndefined();
    expect(at("[a](https://example.com/|)")).toBeUndefined();
    expect(at("plain unizero://paper/1/KEY|")).toBeUndefined();
    expect(at(`[a](unizero://paper/1/2BJ|FPCUL)`)).toBeUndefined();
    expect(at("[a](unizero://note/v/12|3)")).toBeUndefined();
    expect(at(`${paper}.docx|)`)).toBeUndefined();
  });
  it("replaces up to its own closing bracket only", () => {
    const line = `${paper}.md#old) and [b](unizero://paper/1/OTHER)`;
    const c = completionAt(line, line.indexOf("#old") + 2)!;
    expect(line.slice(c.from, c.to)).toBe("#old");
    const open = `${paper} and [b](unizero://paper/1/OTHER)`;
    expect(completionAt(open, paper.length)!.to).toBe(paper.length);
  });
});

describe("punctuation from a Chinese IME", () => {
  it("jumps from the search on any form of the key", () => {
    for (const hash of ["#", "\uFF03"]) { expect(jumpAt(`丁学良${hash}`)).toEqual({ query: "丁学良", next: "heading" }); }
    for (const caret of ["^", "\uFF3E", "\u2026\u2026"]) { expect(jumpAt(`丁学良 ${caret}`)).toEqual({ query: "丁学良", next: "block" }); }
    expect(jumpAt("#")).toEqual({ query: "", next: "heading" });
    expect(jumpAt("vault note#")).toEqual({ query: "vault note", next: "heading" });
    expect(jumpAt("丁学良")).toBeUndefined();
    expect(jumpAt("c#sharp")).toBeUndefined();
  });
  it("reads the same forms inside a destination and replaces them", () => {
    const hash = `${paper}.md\uFF03Met)`;
    const full = completionAt(hash, hash.length - 1)!;
    expect(full).toMatchObject({ stage: "location", fragment: "Met" });
    expect(hash.slice(full.from, full.to)).toBe("\uFF03Met");
    expect(at(`${paper}.md\u2026\u2026|)`)).toMatchObject({ stage: "location", fragment: "^" });
    expect(at(`${paper}.md#\u2026\u2026ab|)`)).toMatchObject({ stage: "location", fragment: "^ab" });
    expect(at(`${paper}.md^|)`)).toMatchObject({ stage: "location", fragment: "^" });
    expect(at("[B](unizero://note/v/123\uFF03In|)")).toMatchObject({ stage: "location", fragment: "In", target: { uid: "123" } });
    expect(at("[B](unizero://note/v/123\u2026\u2026|)")).toMatchObject({ stage: "location", fragment: "^", target: { uid: "123" } });
  });
});

describe("choices", () => {
  it("offers Raw, PDF and the Item pane, omitting the attachment when there is one", () => {
    expect(targetChoices(files, "").map((c) => [c.label, c.text, c.next])).toEqual([
      ["Raw", ".md", true], ["PDF", ".pdf", true], ["Item pane", "", false],
    ]);
    expect(targetChoices(files, ".p").map((c) => c.label)).toEqual(["PDF"]);
    expect(targetChoices({ pdfs: [], artifacts: [] }, "").map((c) => c.label)).toEqual(["Item pane"]);
  });
  it("names the attachment when a paper has several", () => {
    const many = { pdfs: [{ key: "P1", title: "A", main: true }, { key: "P2", title: "B", main: false }],
      artifacts: [{ key: "R1", title: "R", kind: "raw" }, { key: "R2", title: "S", kind: "raw" }] };
    expect(targetChoices(many, "").map((c) => c.text)).toEqual([".md?attachment=R1", ".md?attachment=R2", ".pdf?attachment=P1", ".pdf?attachment=P2", ""]);
  });
  it("lists and filters headings and blocks, encoding what it writes", () => {
    const anchors = textAnchors("# Related Work\n\n## 引言 (一)\n\nA fact ^fact-1\n\nOther ^other\n");
    expect(locationChoices(anchors).map((c) => c.label)).toEqual(["Whole file", "Related Work", "引言 (一)", "^fact-1", "^other"]);
    expect(locationChoices(anchors).map((c) => c.level)).toEqual([undefined, 1, 2, undefined, undefined]);
    expect(locationChoices(anchors, "rel")[0].text).toBe("#Related%20Work");
    expect(locationChoices(anchors, "Related%20W").map((c) => c.label)).toEqual(["Related Work"]);
    expect(locationChoices(anchors, "related w").map((c) => c.label)).toEqual(["Related Work"]);
    expect(locationChoices(anchors, "^").map((c) => c.label)).toEqual(["^fact-1", "^other"]);
    expect(locationChoices(anchors, "%5Efa").map((c) => c.text)).toEqual(["#%5Efact-1"]);
    expect(locationChoices(anchors, "nothing")).toEqual([]);
  });
  it("offers a way out of a block search in a file without block IDs", () => {
    const [only] = locationChoices(textAnchors("# Title\n\nText\n"), "^");
    expect(only).toMatchObject({ label: "No block IDs in this file", text: "" });
    expect(locationChoices(textAnchors("# Title\n"), "^abc")).toEqual([]);
  });
  it("writes only links the parser accepts", () => {
    const uri = "unizero://paper/1/KEY.md";
    for (const choice of locationChoices(textAnchors("# 引言 (一) 100%\n\nText ^b-1\n"))) {
      expect(parseLinkTarget(uri + choice.text), choice.label).toBeDefined();
    }
    for (const [base, c] of [["unizero://paper/1/KEY.pdf", { digits: "15" }], ["unizero://paper/1/KEY.pdf?attachment=P1", { digits: "15", attachmentKey: "P1" }]] as const) {
      expect(parseLinkTarget(base + pageChoices(c)[0].text)).toMatchObject({ page: 15 });
    }
  });
  it("offers a page only for a valid number", () => {
    expect(pageChoices({ digits: "" }).map((c) => c.label)).toEqual(["Whole PDF"]);
    expect(pageChoices({ digits: "0" }).map((c) => c.label)).toEqual(["Whole PDF"]);
    expect(pageChoices({ digits: "15" }).map((c) => c.text)).toEqual(["?page=15", ""]);
  });
  it("keeps the caret inside to continue and moves past the link when done", () => {
    const span = { from: 10, to: 10, closes: true };
    expect(caretAfter(span, { text: ".md", next: true })).toBe(13);
    expect(caretAfter(span, { text: "#Methods", next: false })).toBe(19);
    expect(caretAfter({ ...span, closes: false }, { text: "#Methods", next: false })).toBe(18);
  });
});
