import { describe, expect, it } from "vitest";
import {
  citationPrefixAt,
  citationText,
  isPaperRef,
  paperRefKey,
  scanCitations,
  withPdfPage,
} from "../src/citation";

const REF = { libraryID: 1, itemKey: "HLP48L8X" };

describe("scanCitations", () => {
  it("reads the citation forms including a PDF page", () => {
    const tokens = scanCitations(
      "See @1/HLP48L8X, the note @1/HLP48L8X.md, @1/HLP48L8X.pdf, and @1/HLP48L8X.pdf:15",
    );
    expect(tokens.map((token) => [
      token.libraryID,
      token.itemKey,
      token.action,
      token.page,
    ])).toEqual([
      [1, "HLP48L8X", "detail", undefined],
      [1, "HLP48L8X", "markdown", undefined],
      [1, "HLP48L8X", "pdf", undefined],
      [1, "HLP48L8X", "pdf", 15],
    ]);
  });

  it("reports offsets that cover the whole token including the suffix", () => {
    const text = "x @1/HLP48L8X.pdf y";
    const [token] = scanCitations(text);
    expect(text.slice(token.from, token.to)).toBe("@1/HLP48L8X.pdf");
    expect(token.raw).toBe("@1/HLP48L8X.pdf");
  });

  it("includes the page suffix in offsets for .pdf:{page}", () => {
    const text = "see @1/HLP48L8X.pdf:15 here";
    const [token] = scanCitations(text);
    expect(text.slice(token.from, token.to)).toBe("@1/HLP48L8X.pdf:15");
    expect(token.raw).toBe("@1/HLP48L8X.pdf:15");
    expect(token.action).toBe("pdf");
    expect(token.page).toBe(15);
  });

  it("does not treat a bare colon after the key as a page", () => {
    const [token] = scanCitations("@1/HLP48L8X:extra");
    expect(token.itemKey).toBe("HLP48L8X");
    expect(token.action).toBe("detail");
    expect(token.page).toBeUndefined();
    expect(token.raw).toBe("@1/HLP48L8X");
  });

  it("ignores page 0 and non-numeric page tails", () => {
    const zero = scanCitations("@1/HLP48L8X.pdf:0")[0];
    expect(zero.action).toBe("pdf");
    expect(zero.page).toBeUndefined();
    expect(zero.raw).toBe("@1/HLP48L8X.pdf");

    const [paged] = scanCitations("@1/HLP48L8X.pdf:15andmore");
    expect(paged.raw).toBe("@1/HLP48L8X.pdf:15");
    expect(paged.page).toBe(15);
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
    expect(citationPrefixAt("@1/HLP48L8X.pdf", 15)).toBeUndefined();
    expect(citationPrefixAt("@1/HLP48L8X.pdf:15", 18)).toBeUndefined();
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

  it("round-trips a PDF page", () => {
    const text = citationText(REF, "pdf", 15);
    expect(text).toBe("@1/HLP48L8X.pdf:15");
    const [token] = scanCitations(text);
    expect(token.action).toBe("pdf");
    expect(token.page).toBe(15);
  });
});

describe("withPdfPage", () => {
  it("appends ?page= for a positive page", () => {
    expect(withPdfPage("zotero://open-pdf/library/items/ABC", 15))
      .toBe("zotero://open-pdf/library/items/ABC?page=15");
  });

  it("uses & when the URL already has a query", () => {
    expect(withPdfPage("zotero://open-pdf/library/items/ABC?foo=1", 3))
      .toBe("zotero://open-pdf/library/items/ABC?foo=1&page=3");
  });

  it("leaves the URL alone without a valid page", () => {
    const url = "zotero://open-pdf/library/items/ABC";
    expect(withPdfPage(url)).toBe(url);
    expect(withPdfPage(url, 0)).toBe(url);
    expect(withPdfPage(url, -1)).toBe(url);
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
