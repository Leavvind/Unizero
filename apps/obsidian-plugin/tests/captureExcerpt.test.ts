import { describe, expect, it } from "vitest";
import {
  formatIncomingText,
  normalizeExcerptLabel,
  parseZoteroExcerpt,
} from "../src/capture/excerpt";

describe("Zotero excerpt parsing", () => {
  it("formats an annotation as excerpt plus author-year link", () => {
    const input =
      "“Quoted text” ([Smith et al., 2024, p. 17](zotero://open-pdf/library/items/ABC?page=17))";
    expect(formatIncomingText(input)).toBe(
      "Quoted text [Smith et al., 2024](zotero://open-pdf/library/items/ABC?page=17)",
    );
  });

  it("keeps internal quotation marks in the excerpt", () => {
    const input =
      "“Text with “internal” quotation marks” ([Lee, 2020](zotero://select/library/items/ABC))";
    expect(parseZoteroExcerpt(input)?.content).toBe("Text with “internal” quotation marks");
  });

  it("normalizes different author-year locator labels", () => {
    expect(normalizeExcerptLabel("Smith, 2024, p. 17")).toBe("Smith, 2024");
    expect(normalizeExcerptLabel("张三，2023，第 9 页")).toBe("张三, 2023");
  });

  it("leaves ordinary clipboard text unchanged", () => {
    expect(formatIncomingText("ordinary text")).toBe("ordinary text");
  });

  it("never writes a UniZero citation", () => {
    const input = "“Quote” ([Author, 2026](zotero://open-pdf/library/items/ABC))";
    expect(formatIncomingText(input)).not.toMatch(/@\d+\//);
  });

  it("keeps the open-pdf link and the comment of Zotero's Markdown copy", () => {
    const input =
      "“text” ([Smith, 2024, p. 17](zotero://select/library/items/K)) " +
      "([pdf](zotero://open-pdf/library/items/A?page=17&annotation=X)) My comment here";
    expect(parseZoteroExcerpt(input)).toEqual({
      content: "text",
      label: "Smith, 2024",
      link: "zotero://open-pdf/library/items/A?page=17&annotation=X",
      comment: "My comment here",
    });
    expect(formatIncomingText(input)).toBe(
      "text [Smith, 2024](zotero://open-pdf/library/items/A?page=17&annotation=X)\nMy comment here",
    );
  });

  it("keeps the locator when the link carries no page", () => {
    const input = "“text” ([Smith, 2024, p. 3](zotero://select/library/items/K)) A comment";
    expect(parseZoteroExcerpt(input)).toEqual({
      content: "text",
      label: "Smith, 2024, p. 3",
      link: "zotero://select/library/items/K",
      comment: "A comment",
    });
  });

  it("does not take a page number or part of a longer number for the year", () => {
    expect(normalizeExcerptLabel("Smith, n.d., p. 2019")).toBe("Smith, n.d., p. 2019");
    expect(normalizeExcerptLabel("Org, 20235")).toBe("Org, 20235");
    expect(normalizeExcerptLabel("Smith, 2024a, p. 2019")).toBe("Smith, 2024a");
  });
});
