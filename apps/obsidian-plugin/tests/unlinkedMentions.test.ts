import { describe, expect, it, vi } from "vitest";
import { findMentions, mentionSnippet } from "../src/unlinkedMentions";

describe("mentionSnippet", () => {
  it("splits out the match so each of several mentions on one line is distinct", () => {
    const line = "- 柴静说，柴静认为";
    const [first, second] = findMentions(line, ["柴静"]);
    expect(mentionSnippet(line, first.ch, 2)).toEqual({ before: "", match: "柴静", after: "说，柴静认为" });
    expect(mentionSnippet(line, second.ch, 2)).toEqual({ before: "柴静说，", match: "柴静", after: "认为" });
  });

  it("clips long lines around the match with ellipses", () => {
    const line = `${"a".repeat(100)} Name ${"b".repeat(200)}`;
    const snippet = mentionSnippet(line, 101, 4, 80, 20);
    expect(snippet.before).toBe(`…${"a".repeat(19)} `);
    expect(snippet.match).toBe("Name");
    expect(snippet.after.endsWith("…")).toBe(true);
    expect(snippet.before.length + snippet.match.length + snippet.after.length).toBeLessThanOrEqual(82);
  });
});

const texts = (text: string, terms: string[]) => findMentions(text, terms).map((m) => m.text);

describe("findMentions", () => {
  it("matches the title and aliases case-insensitively, longest first, with positions", () => {
    const text = "Intro\nWe used deep learning and Deep Learning Methods here.";
    const found = findMentions(text, ["Deep Learning", "deep learning methods"]);
    expect(found.map((m) => m.text)).toEqual(["deep learning", "Deep Learning Methods"]);
    expect(found[0]).toMatchObject({ line: 1, ch: 8, lineText: "We used deep learning and Deep Learning Methods here." });
    expect(text.slice(found[1].from, found[1].to)).toBe("Deep Learning Methods");
  });

  it("requires whole words in Latin text but not in Chinese", () => {
    expect(texts("transformers and a transformer", ["transformer"])).toEqual(["transformer"]);
    expect(texts("我们研究注意力机制的效果", ["注意力机制"])).toEqual(["注意力机制"]);
  });

  it("skips links, code, comments, URLs and frontmatter", () => {
    const text = [
      "---", "title: Attention", "---",
      "[[Attention]] ![[Attention]] [Attention](x.md) [x](unizero://note/v/Attention)",
      "`Attention` %% Attention %% <!-- Attention --> https://ex.com/Attention",
      "```", "Attention", "```",
      "[ref]: https://Attention",
      "Plain Attention here.",
    ].join("\n");
    const found = findMentions(text, ["Attention"]);
    expect(found).toHaveLength(1);
    expect(found[0].lineText).toBe("Plain Attention here.");
  });

  it("treats an unclosed fence as code to the end and ignores empty terms", () => {
    expect(texts("A note\n```\nnote", ["note"])).toEqual(["note"]);
    expect(findMentions("anything", ["", "  "])).toEqual([]);
  });

  it("escapes regular-expression characters in titles", () => {
    expect(texts("See C++ (2nd ed.) now", ["C++ (2nd ed.)"])).toEqual(["C++ (2nd ed.)"]);
  });
});

describe("findMentions exclusion spans", () => {
  it("computes spans only when a term matches, and honours supplied spans", () => {
    const spansOf = vi.fn((): Array<[number, number]> => []);
    expect(findMentions("Nothing relevant here.", ["Alpha"], spansOf)).toEqual([]);
    expect(spansOf).not.toHaveBeenCalled();
    const text = "Alpha and `Alpha`";
    expect(findMentions(text, ["Alpha"], spansOf).map((m) => m.from)).toEqual([0, 11]);
    expect(findMentions(text, ["Alpha"]).map((m) => m.from)).toEqual([0]);
    expect(spansOf).toHaveBeenCalledTimes(1);
  });
});
