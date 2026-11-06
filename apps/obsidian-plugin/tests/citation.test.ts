import { scanDocumentLinks } from "../src/documentLinks";
import { describe, expect, it } from "vitest";
import {
  citationPrefixAt,
  citationText,
  isPaperRef,
  paperRefKey,
  withPdfPage,
} from "../src/citation";

const REF = { libraryID: 1, itemKey: "HLP48L8X" };

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
      const [{ target: token }] = scanDocumentLinks(text);
      if (token.kind !== "paper") { throw new Error("Expected paper"); }
      expect(token.libraryID).toBe(REF.libraryID);
      expect(token.itemKey).toBe(REF.itemKey);
      expect(token.action).toBe(action);
    }
  });

  it("round-trips a PDF page", () => {
    const text = citationText(REF, "pdf", 15);
    expect(text).toBe("[1/HLP48L8X, p. 15](unizero://paper/1/HLP48L8X.pdf?page=15)");
    const [{ target: token }] = scanDocumentLinks(text);
    if (token.kind !== "paper") { throw new Error("Expected paper"); }
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
