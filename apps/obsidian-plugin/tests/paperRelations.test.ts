import { describe, expect, it } from "vitest";
import { scanCanvasLinks, scanDocumentLinks } from "../src/documentLinks";
import { LinkIndex, type SourceDocument } from "../src/linkIndex";
import { noteCitations, noteReferences, paperCitations, paperReferences, pdfAnchorPage } from "../src/paperRelations";

const pdf = (annotation: string) => `zotero://open-pdf/library/items/XGLGZ4VJ?page=4&annotation=${annotation}`;
const A = { libraryID: 1, itemKey: "AAAA1111" }, B = { libraryID: 1, itemKey: "BBBB2222" };
const paperLink = (label: string, paper: { libraryID: number; itemKey: string }, suffix = "") =>
  `[${label}](unizero://paper/${paper.libraryID}/${paper.itemKey}${suffix})`;

const zotero = (paper: { libraryID: number; itemKey: string }, attachmentKey: string, purpose: string,
  format: "md" | "canvas" = "md"): SourceDocument => ({ kind: "zotero", ...paper, attachmentKey, title: `${purpose} file`,
  itemTitle: `Paper ${paper.itemKey}`, format, purpose, version: "1" });
const vault = (path: string): SourceDocument => ({ kind: "vault", path, title: path, vaultID: "v", format: "md" });
const canvas = (...texts: string[]) => JSON.stringify({ nodes: texts.map((text, i) => ({ id: `n${i}`, type: "text", text })), edges: [] });

describe("evidence units", () => {
  it("pairs a link only with the PDF anchors of its own paragraph", () => {
    const text = [
      `The importance of stock-level liquidity is weakened. [pdf](${pdf("XV73L3U9")})`,
      "",
      `liquidity ${paperLink("providers", B)} charge a higher price after negative news. [pdf](${pdf("P8XU5H7P")})`,
    ].join("\n");
    const [link] = scanDocumentLinks(text);
    expect(link.unit).toMatchObject({ text: "liquidity providers charge a higher price after negative news.", pdf: [pdf("P8XU5H7P")] });
  });

  it("keeps the quoted text and drops the PDF label and its empty brackets", () => {
    const text = `“${paperLink("Although the best", B)} quote instantly adjusts” ([pdf](${pdf("SZHY9F7F")}))`;
    expect(scanDocumentLinks(text)[0].unit).toMatchObject({ text: "“Although the best quote instantly adjusts”", pdf: [pdf("SZHY9F7F")] });
  });

  it("scopes units to one paragraph inside a Canvas card and ignores other link shapes", () => {
    const card = `First ${paperLink("B", B)}.\n\nSecond [pdf](${pdf("K1")}) [web](https://example.com) [sel](zotero://select/library/items/K)`;
    const [link] = scanCanvasLinks(canvas(card));
    expect(link.nodeId).toBe("n0");
    expect(link.unit).toMatchObject({ text: "First B.", pdf: [] });
  });

  it("gives a heading its own unit", () => {
    expect(scanDocumentLinks(`## On ${paperLink("B", B)}`)[0].unit?.text).toBe("On B");
  });

  it("reads PDF pages for labels", () => {
    expect(pdfAnchorPage(pdf("X"))).toBe(4);
    expect(pdfAnchorPage("zotero://open-pdf/library/items/X?annotation=Y")).toBeUndefined();
  });
});

describe("paper relations", () => {
  function build(): LinkIndex {
    const index = new LinkIndex();
    // A's Canvas: one passage about B, one self link.
    index.replace(zotero(A, "CANVASA", "canvas", "canvas"), canvas(
      `${paperLink("Quote", B)} [pdf](${pdf("ANN1")})`,
      `${paperLink("me", A)} again`,
    ));
    // A's Raw mentions B twice.
    index.replace(zotero(A, "RAWA", "raw"), `${paperLink("B", B, ".pdf?page=3")}\n\n${paperLink("B again", B)}`);
    // An ordinary Markdown attachment of A and a Vault note: links, not relations.
    index.replace(zotero(A, "USERA", "user"), paperLink("B", B));
    index.replace(vault("notes/review.md"), paperLink("B", B));
    return index;
  }

  it("lists a paper's own Raw and Canvas links to other papers as References", () => {
    const [group, ...rest] = paperReferences(build(), A);
    expect(rest).toEqual([]);
    expect(group.paper).toEqual(B);
    expect(group.mentions.map((m) => m.source.kind === "zotero" && m.source.purpose)).toEqual(["canvas", "raw", "raw"]);
    expect(group.mentions[0].unit?.pdf).toEqual([pdf("ANN1")]);
  });

  it("counts links to one paper in one unit once, and same-text units apart", () => {
    const index = build();
    index.replace(zotero(A, "RAWA", "raw"),
      `See ${paperLink("B", B)} and ${paperLink("B p. 3", B, ".pdf?page=3")}.\n\n- Same ${paperLink("B", B)}\n- Same ${paperLink("B", B)}`);
    index.replace(vault("notes/review.md"), `${paperLink("B", B)} ${paperLink("B again", B)}`);
    expect(paperReferences(index, A)[0].mentions.map((m) => m.line)).toEqual([0, 0, 2, 3]);
    expect(paperCitations(index, B)[0].mentions).toHaveLength(4);
    expect(noteCitations(index, B).find((group) => group.title === "notes/review.md")?.mentions).toHaveLength(1);
  });

  it("lists other papers' Raw and Canvas links as Citations, grouped by citing paper", () => {
    const [group, ...rest] = paperCitations(build(), B);
    expect(rest).toEqual([]);
    expect(group).toMatchObject({ paper: A, title: "Paper AAAA1111" });
    expect(group.mentions).toHaveLength(3);
    expect(paperCitations(build(), A)).toEqual([]);
  });

  it("groups non-paper sources and self links as Notes in Citations", () => {
    const index = build();
    const notes = noteCitations(index, B);
    expect(notes.map((group) => [group.title, group.mentions.length])).toEqual([
      ["notes/review.md", 1], ["Paper AAAA1111 · user file", 1]]);
    expect(noteCitations(index, A).map((group) => group.mentions.map((m) => m.source.kind === "zotero" && m.source.attachmentKey)))
      .toEqual([["CANVASA"]]);
  });

  it("lists a paper's Raw and Canvas links to Vault notes as Notes in References", () => {
    const index = build();
    index.replace(zotero(A, "RAWA", "raw"), "[n](unizero://note/v/uid-1)\n\n[n again](unizero://note/v/uid-1#Heading)");
    index.replace(zotero(A, "USERA", "user"), "[n](unizero://note/v/uid-2)");
    const [group, ...rest] = noteReferences(index, A);
    expect(rest).toEqual([]);
    expect(group).toMatchObject({ key: "note:v/uid-1", target: { kind: "note", vaultID: "v", uid: "uid-1" } });
    expect(group.mentions).toHaveLength(2);
  });

  it("leaves render-only nocite links out of both lists", () => {
    const index = new LinkIndex();
    index.replace(zotero(A, "RAWA", "raw"), `[B](unizero://paper/1/BBBB2222 "nocite")\n\n[n](unizero://note/v/u "nocite")`);
    index.replace(vault("aside.md"), `[B](unizero://paper/1/BBBB2222 "nocite")`);
    expect(paperReferences(index, A)).toEqual([]);
    expect(noteReferences(index, A)).toEqual([]);
    expect(paperCitations(index, B)).toEqual([]);
    expect(noteCitations(index, B)).toEqual([]);
  });

  it("follows replaced and removed sources", () => {
    const index = build();
    index.replace(zotero(A, "RAWA", "raw"), "no links");
    expect(paperReferences(index, A)[0].mentions).toHaveLength(1);
    index.remove("zotero:1/AAAA1111/CANVASA");
    expect(paperReferences(index, A)).toEqual([]);
    expect(index.recordsOfPaper(A).map((r) => r.source.kind === "zotero" && r.source.attachmentKey).sort()).toEqual(["RAWA", "USERA"]);
  });
});
