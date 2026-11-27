import { describe, expect, it } from "vitest";
import { scanCanvasLinks, scanDocumentLinks } from "@unizero/links";
import { PaperLinkIndex, sourceKey, type PaperNote } from "../src/modules/paperLinkIndex";

const note = (itemKey: string, attachmentKey: string, purpose: "raw" | "canvas", libraryID = 1): PaperNote =>
  ({ libraryID, itemKey, attachmentKey, purpose, title: `${itemKey} ${purpose}` });
const pdf = (annotation: string) => `zotero://open-pdf/library/items/PDFA0001?page=2&annotation=${annotation}`;

const rawA = [
  `Claim one [pdf](${pdf("AAA1")}).`,
  "",
  `Claim two [pdf](${pdf("BBB2")}) after [B](unizero://paper/1/BKEY0001) and again [B again](unizero://paper/1/BKEY0001.pdf).`,
  "",
  "A self-link [me](unizero://paper/1/AKEY0001) and [C](unizero://paper/1/CKEY0001).",
  "",
  "Vault note [n](unizero://note/vault/uid).",
].join("\n");
const canvasA = JSON.stringify({ nodes: [{ id: "card", type: "text", text: "See [B](unizero://paper/1/BKEY0001)" }], edges: [] });
const rawD = "Builds on [B](unizero://paper/1/BKEY0001).";

function built(): PaperLinkIndex {
  const index = new PaperLinkIndex();
  index.put(note("AKEY0001", "RAWA0001", "raw"), "f1", scanDocumentLinks(rawA), 100);
  index.put(note("AKEY0001", "CANA0001", "canvas"), "f2", scanCanvasLinks(canvasA), 200);
  index.put(note("DKEY0001", "RAWD0001", "raw"), "f3", scanDocumentLinks(rawD), 300);
  return index;
}

describe("paper-link index", () => {
  it("keeps only paper-to-paper mentions, one per unit", () => {
    const references = built().references({ libraryID: 1, itemKey: "AKEY0001" });
    expect(references.map((group) => [group.paper.itemKey, group.mentions.length])).toEqual([["BKEY0001", 2], ["CKEY0001", 1]]);
    const [canvas, raw] = references[0].mentions;
    expect(canvas).toMatchObject({ nodeId: "card", text: "See B", pdf: [], time: 200 });
    expect(canvas.source.purpose).toBe("canvas");
    expect(raw).toMatchObject({ line: 2, text: "Claim two after B and again B again.", pdf: [pdf("BBB2")], time: 100 });
  });

  it("leaves render-only nocite links out", () => {
    const index = new PaperLinkIndex();
    index.put(note("EKEY0001", "RAWE0001", "raw"), "f", scanDocumentLinks(
      "Aside [B](unizero://paper/1/BKEY0001 \"nocite\").\n\nReal [C](unizero://paper/1/CKEY0001)."), 1);
    expect(index.references({ libraryID: 1, itemKey: "EKEY0001" }).map((group) => group.paper.itemKey)).toEqual(["CKEY0001"]);
    expect(index.citations({ libraryID: 1, itemKey: "BKEY0001" })).toEqual([]);
  });

  it("answers who mentions a paper", () => {
    const citations = built().citations({ libraryID: 1, itemKey: "BKEY0001" });
    expect(citations.map((group) => [group.paper.itemKey, group.mentions.length])).toEqual([["AKEY0001", 2], ["DKEY0001", 1]]);
    expect(built().citations({ libraryID: 1, itemKey: "AKEY0001" })).toEqual([]);
  });

  it("ignores Markdown attachments that are not a paper's Raw or Canvas", () => {
    const index = new PaperLinkIndex();
    index.put({ ...note("AKEY0001", "USER0001", "raw"), purpose: "user" as any }, "f", scanDocumentLinks(rawD));
    expect(index.mentions()).toEqual([]);
  });

  it("re-reads a source only when its fingerprint changes, and forgets unlisted sources", () => {
    const index = built();
    const a = note("AKEY0001", "RAWA0001", "raw");
    expect(index.fingerprint(a)).toBe("f1");
    index.put(a, "f1b", scanDocumentLinks("nothing here"), 400);
    expect(index.references({ libraryID: 1, itemKey: "AKEY0001" }).map((group) => group.mentions.length)).toEqual([1]);
    index.retain(new Set([sourceKey(a)]));
    expect(index.size).toBe(1);
    expect(index.citations({ libraryID: 1, itemKey: "BKEY0001" })).toEqual([]);
  });

  it("keeps a source's last mentions when a read fails", () => {
    const index = built();
    const canvas = note("AKEY0001", "CANA0001", "canvas");
    index.fail(canvas, "Unexpected end of JSON input");
    expect(index.failures()).toEqual([{ source: canvas, error: "Unexpected end of JSON input" }]);
    expect(index.fingerprint(canvas)).toBeUndefined();
    expect(index.references({ libraryID: 1, itemKey: "AKEY0001" })[0].mentions).toHaveLength(2);
  });

  it("keeps library scope in identity", () => {
    const index = new PaperLinkIndex();
    index.put(note("AKEY0001", "RAWA0001", "raw", 2), "f", scanDocumentLinks("[B](unizero://paper/1/BKEY0001) [A](unizero://paper/1/AKEY0001)"));
    // Library 2's A mentions library 1's B and library 1's A: both are other papers.
    expect(index.references({ libraryID: 2, itemKey: "AKEY0001" }).map((group) => group.paper))
      .toEqual([{ libraryID: 1, itemKey: "AKEY0001" }, { libraryID: 1, itemKey: "BKEY0001" }]);
  });
});
