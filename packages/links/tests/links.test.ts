import { describe, expect, it } from "vitest";
import {
  indexedLinks,
  isPaperToPaper,
  parseLinkTarget,
  parsePdfAnchor,
  scanCanvasLinks,
  scanDocumentLinks,
  serializeLinkTarget,
  type LinkTarget,
} from "../src";

const pdf = (key: string, annotation: string) => `zotero://open-pdf/library/items/${key}?page=3&annotation=${annotation}`;

describe("link grammar", () => {
  it("round-trips the canonical forms", () => {
    for (const uri of [
      "unizero://paper/1/ABCD1234",
      "unizero://paper/2/ABCD1234.pdf?page=12",
      "unizero://paper/1/ABCD1234.md?attachment=EFGH5678#%5Eblock-1",
      "unizero://note/vault/2024-uid#Heading",
    ]) {
      const target = parseLinkTarget(uri);
      expect(target, uri).toBeDefined();
      expect(serializeLinkTarget(target!)).toBe(uri);
    }
  });

  it("rejects what the strict grammar does not name", () => {
    for (const uri of [
      "unizero://paper/0/ABCD1234",
      "unizero://paper/1/ABCD1234?attachment=X",
      "unizero://paper/1/ABCD1234.pdf?nocite=1",
      "unizero://paper/1/ABCD1234#Heading",
      "unizero://note/vault/a%2Fb",
    ]) { expect(parseLinkTarget(uri), uri).toBeUndefined(); }
  });
});

describe("evidence units", () => {
  it("pairs a mention only with the PDF anchors of its own paragraph", () => {
    const text = [
      `First claim [pdf](${pdf("PDF1", "AAA1")}).`,
      "",
      `Second claim [pdf](${pdf("PDF1", "BBB2")}) as shown by [Smith, 2020](unizero://paper/1/BKEY0001).`,
    ].join("\n");
    const [link] = scanDocumentLinks(text);
    expect(link.target).toMatchObject({ kind: "paper", libraryID: 1, itemKey: "BKEY0001" });
    expect(link.line).toBe(2);
    expect(link.unit).toEqual({ text: "Second claim as shown by Smith, 2020.", pdf: [pdf("PDF1", "BBB2")] });
  });

  it("keeps a mention without a PDF anchor", () => {
    const [link] = scanDocumentLinks("- Compare [B](unizero://paper/1/BKEY0001) here");
    expect(link.unit).toEqual({ text: "Compare B here", pdf: [] });
  });

  it("ignores links in code and lookalike PDF links", () => {
    const text = "`[B](unizero://paper/1/BKEY0001)` and [x](zotero://open-pdf/library/items/K?page=1 extra) [C](unizero://paper/1/CKEY0001)";
    const links = scanDocumentLinks(text);
    expect(links.map((link) => link.target.kind === "paper" && link.target.itemKey)).toEqual(["CKEY0001"]);
    expect(links[0].unit?.pdf).toEqual([]);
  });

  it("records the Canvas card of each mention", () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: "card-1", type: "text", text: `One [pdf](${pdf("PDF1", "AAA1")})\n\nTwo [B](unizero://paper/1/BKEY0001)` },
        { id: "file-1", type: "file", file: "x.md" },
      ],
      edges: [],
    });
    const [link] = scanCanvasLinks(canvas);
    expect(link.nodeId).toBe("card-1");
    expect(link.unit).toEqual({ text: "Two B", pdf: [] });
  });

  it("treats invalid Canvas JSON as a failed read", () => {
    expect(() => scanCanvasLinks("{")).toThrow();
  });
});

describe("link roles", () => {
  const b: LinkTarget = { kind: "paper", libraryID: 1, itemKey: "BKEY0001", action: "pdf" };
  it("counts only another paper, linked from a paper's Raw or Canvas", () => {
    expect(isPaperToPaper({ kind: "zotero", libraryID: 1, itemKey: "AKEY0001", purpose: "canvas" }, b)).toBe(true);
    expect(isPaperToPaper({ kind: "zotero", libraryID: 1, itemKey: "AKEY0001", purpose: "raw" }, b)).toBe(true);
    expect(isPaperToPaper({ kind: "zotero", libraryID: 1, itemKey: "AKEY0001", purpose: "user" }, b)).toBe(false);
    expect(isPaperToPaper({ kind: "zotero", libraryID: 1, itemKey: "BKEY0001", purpose: "raw" }, b)).toBe(false);
    expect(isPaperToPaper({ kind: "vault" }, b)).toBe(false);
    expect(isPaperToPaper({ kind: "zotero", libraryID: 1, itemKey: "AKEY0001", purpose: "raw" },
      { kind: "note", vaultID: "v", uid: "u" })).toBe(false);
  });
  it("keeps cross-library mentions", () => {
    expect(isPaperToPaper({ kind: "zotero", libraryID: 2, itemKey: "BKEY0001", purpose: "raw" }, b)).toBe(true);
  });
});

describe("render-only links", () => {
  it("marks a link titled nocite, inline or by reference, and leaves the URI alone", () => {
    const links = scanDocumentLinks([
      "[A](unizero://paper/1/AKEY0001 \"nocite\") and [B](unizero://paper/1/BKEY0001)",
      "[C][c] and [D](unizero://paper/1/DKEY0001 \"other\")",
      "",
      "[c]: unizero://paper/1/CKEY0001 'nocite'",
    ].join("\n"));
    expect(links.map((l) => [l.target.kind === "paper" && l.target.itemKey, !!l.nocite])).toEqual([
      ["AKEY0001", true], ["BKEY0001", false], ["CKEY0001", true], ["DKEY0001", false]]);
    expect(indexedLinks(links).map((l) => l.target.kind === "paper" && l.target.itemKey)).toEqual(["BKEY0001", "DKEY0001"]);
  });
  it("reads the title inside Canvas cards", () => {
    const canvas = JSON.stringify({ nodes: [{ id: "n1", type: "text", text: "[A](unizero://paper/1/AKEY0001 \"nocite\")" }], edges: [] });
    expect(scanCanvasLinks(canvas)[0].nocite).toBe(true);
  });
});

describe("PDF anchors", () => {
  it("reads Zotero's own open-pdf links", () => {
    expect(parsePdfAnchor(pdf("PDF1", "AAA1"))).toEqual({ attachmentKey: "PDF1", page: 3, annotationKey: "AAA1" });
    expect(parsePdfAnchor("zotero://open-pdf/groups/42/items/PDF1")).toEqual({ groupID: 42, attachmentKey: "PDF1" });
  });
  it("rejects anything else", () => {
    for (const url of [
      "zotero://open-pdf/library/items/PDF1?page=0",
      "zotero://open-pdf/library/items/PDF1?annotation=a%2Fb",
      "zotero://open-pdf/users/1/items/PDF1",
      "zotero://select/library/items/PDF1",
      "https://example.org/x.pdf",
    ]) { expect(parsePdfAnchor(url), url).toBeUndefined(); }
  });
});
