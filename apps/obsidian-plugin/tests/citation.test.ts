import { describe, expect, it } from "vitest";
import {
  citationPrefixAt,
  citationText,
  isValidCitekey,
  scanCitations,
} from "../src/citation";

describe("scanCitations", () => {
  it("reads the three citation forms", () => {
    const tokens = scanCitations(
      "See @danielShortLongHorizonBehavioral2020, the note @smith2019.md, and @smith2019.pdf",
    );
    expect(tokens.map((token) => [token.citekey, token.action])).toEqual([
      ["danielShortLongHorizonBehavioral2020", "detail"],
      ["smith2019", "markdown"],
      ["smith2019", "pdf"],
    ]);
  });

  it("reports offsets that cover the whole token including the suffix", () => {
    const text = "x @smith2019.pdf y";
    const [token] = scanCitations(text);
    expect(text.slice(token.from, token.to)).toBe("@smith2019.pdf");
    expect(token.raw).toBe("@smith2019.pdf");
  });

  it("matches after punctuation and at the start of the text", () => {
    expect(scanCitations("@a2020").map((t) => t.citekey)).toEqual(["a2020"]);
    expect(scanCitations("(@a2020)").map((t) => t.citekey)).toEqual(["a2020"]);
    expect(scanCitations("[@a2020]").map((t) => t.citekey)).toEqual(["a2020"]);
    expect(scanCitations("see:@a2020").map((t) => t.citekey)).toEqual(["a2020"]);
  });

  it("does not read an email address as a citation", () => {
    expect(scanCitations("write to user@example.com please")).toEqual([]);
    expect(scanCitations("j45rbnr8p4@privaterelay.appleid.com")).toEqual([]);
  });

  it("treats a backslash as an escape", () => {
    expect(scanCitations("\\@notacitation")).toEqual([]);
  });

  it("does not match the tail of a doubled prefix", () => {
    expect(scanCitations("@@smith2019")).toEqual([]);
  });

  it("requires the key to start with a letter", () => {
    expect(scanCitations("@2020smith")).toEqual([]);
    expect(scanCitations("@_private")).toEqual([]);
  });

  it("stops the key at an unsupported character", () => {
    const [token] = scanCitations("@smith2019:extra");
    expect(token.citekey).toBe("smith2019");
    expect(token.action).toBe("detail");
  });

  it("treats an unknown suffix as ordinary text after the key", () => {
    const [token] = scanCitations("@smith2019.docx");
    expect(token.citekey).toBe("smith2019");
    expect(token.action).toBe("detail");
    expect(token.raw).toBe("@smith2019");
  });

  it("is reusable across calls despite the shared global regex", () => {
    const text = "@a2020 and @b2021";
    expect(scanCitations(text)).toHaveLength(2);
    expect(scanCitations(text)).toHaveLength(2);
  });
});

describe("citationPrefixAt", () => {
  it("reports the bare trigger", () => {
    expect(citationPrefixAt("cite @", 6)).toEqual({ start: 5, query: "" });
  });

  it("reports a partial key", () => {
    expect(citationPrefixAt("cite @dan", 9)).toEqual({ start: 5, query: "dan" });
  });

  it("reads the prefix at the cursor, not at the end of the line", () => {
    expect(citationPrefixAt("cite @dan and more", 9)).toEqual({ start: 5, query: "dan" });
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
      const text = citationText("smith2019", action);
      const [token] = scanCitations(text);
      expect(token.citekey).toBe("smith2019");
      expect(token.action).toBe(action);
    }
  });
});

describe("isValidCitekey", () => {
  it("accepts the keys the syntax can express", () => {
    expect(isValidCitekey("danielShortLongHorizonBehavioral2020")).toBe(true);
    expect(isValidCitekey("a-b_c1")).toBe(true);
  });

  it("rejects keys the syntax cannot round-trip", () => {
    expect(isValidCitekey("2020smith")).toBe(false);
    expect(isValidCitekey("smith.2019")).toBe(false);
    expect(isValidCitekey("")).toBe(false);
  });
});
