import { describe, expect, it } from "vitest";
import {
  citationPrefixAt,
  citationText,
  isPaperRef,
  paperRefKey,
  scanCitations,
} from "../src/citation";

const REF = { libraryID: 1, itemKey: "HLP48L8X" };

describe("scanCitations", () => {
  it("reads the three citation forms", () => {
    const tokens = scanCitations(
      "See @1/HLP48L8X, the note @1/HLP48L8X.md, and @1/HLP48L8X.pdf",
    );
    expect(tokens.map((token) => [token.libraryID, token.itemKey, token.action])).toEqual([
      [1, "HLP48L8X", "detail"],
      [1, "HLP48L8X", "markdown"],
      [1, "HLP48L8X", "pdf"],
    ]);
  });

  it("reports offsets that cover the whole token including the suffix", () => {
    const text = "x @1/HLP48L8X.pdf y";
    const [token] = scanCitations(text);
    expect(text.slice(token.from, token.to)).toBe("@1/HLP48L8X.pdf");
    expect(token.raw).toBe("@1/HLP48L8X.pdf");
  });

  it("matches after punctuation and at the start of the text", () => {
    expect(scanCitations("@1/AAAA1111").map((t) => t.itemKey)).toEqual(["AAAA1111"]);
    expect(scanCitations("(@1/AAAA1111)").map((t) => t.itemKey)).toEqual(["AAAA1111"]);
    expect(scanCitations("[@1/AAAA1111]").map((t) => t.itemKey)).toEqual(["AAAA1111"]);
    expect(scanCitations("see:@1/AAAA1111").map((t) => t.itemKey)).toEqual(["AAAA1111"]);
  });

  it("does not read an email address as a citation", () => {
    expect(scanCitations("write to user@example.com please")).toEqual([]);
    expect(scanCitations("j45rbnr8p4@privaterelay.appleid.com")).toEqual([]);
  });

  it("treats a backslash as an escape", () => {
    expect(scanCitations("\\@1/AAAA1111")).toEqual([]);
  });

  it("does not match the tail of a doubled prefix", () => {
    expect(scanCitations("@@1/AAAA1111")).toEqual([]);
  });

  it("does not treat a bare citekey as a citation", () => {
    expect(scanCitations("@smith2019")).toEqual([]);
    expect(scanCitations("@danielShortLongHorizonBehavioral2020")).toEqual([]);
  });

  it("stops the key at an unsupported character", () => {
    const [token] = scanCitations("@1/HLP48L8X:extra");
    expect(token.itemKey).toBe("HLP48L8X");
    expect(token.action).toBe("detail");
  });

  it("treats an unknown suffix as ordinary text after the key", () => {
    const [token] = scanCitations("@1/HLP48L8X.docx");
    expect(token.itemKey).toBe("HLP48L8X");
    expect(token.action).toBe("detail");
    expect(token.raw).toBe("@1/HLP48L8X");
  });

  it("is reusable across calls despite the shared global regex", () => {
    const text = "@1/AAAA1111 and @2/BBBB2222";
    expect(scanCitations(text)).toHaveLength(2);
    expect(scanCitations(text)).toHaveLength(2);
  });
});

describe("citationPrefixAt", () => {
  it("reports the bare trigger", () => {
    expect(citationPrefixAt("cite @", 6)).toEqual({ start: 5, query: "" });
  });

  it("reports a free-text query", () => {
    expect(citationPrefixAt("cite @dan", 9)).toEqual({ start: 5, query: "dan" });
  });

  it("keeps the popup open across spaces for multi-word search", () => {
    expect(citationPrefixAt("cite @richardson accounting", 27)).toEqual({
      start: 5,
      query: "richardson accounting",
    });
  });

  it("collapses internal whitespace in the query", () => {
    expect(citationPrefixAt("@foo  bar ", 10)).toEqual({ start: 0, query: "foo bar" });
  });

  it("reads the prefix at the cursor, not at the end of the line", () => {
    expect(citationPrefixAt("cite @dan and more", 9)).toEqual({ start: 5, query: "dan" });
  });

  it("closes once the written address is complete", () => {
    expect(citationPrefixAt("@1/HLP48L8X", 11)).toBeUndefined();
    expect(citationPrefixAt("@1/HLP48L8X.md", 14)).toBeUndefined();
  });

  it("closes once the user has typed a hard terminator after the query", () => {
    expect(citationPrefixAt("@smith2019, next", 16)).toBeUndefined();
    expect(citationPrefixAt("@smith2019. Next", 16)).toBeUndefined();
  });

  it("stays closed inside an email address", () => {
    expect(citationPrefixAt("user@example", 12)).toBeUndefined();
  });

  it("stays closed when there is no trigger", () => {
    expect(citationPrefixAt("plain text", 10)).toBeUndefined();
  });
});

describe("citationText", () => {
  it("round-trips through the scanner", () => {
    for (const action of ["detail", "markdown", "pdf"] as const) {
      const text = citationText(REF, action);
      const [token] = scanCitations(text);
      expect(token.libraryID).toBe(REF.libraryID);
      expect(token.itemKey).toBe(REF.itemKey);
      expect(token.action).toBe(action);
    }
  });
});

describe("paperRefKey / isPaperRef", () => {
  it("formats the durable pair", () => {
    expect(paperRefKey(REF)).toBe("1/HLP48L8X");
  });

  it("accepts a well-formed ref", () => {
    expect(isPaperRef(REF)).toBe(true);
    expect(isPaperRef({ libraryID: 0, itemKey: "X" })).toBe(false);
    expect(isPaperRef({ libraryID: 1, itemKey: "bad/key" })).toBe(false);
  });
});
