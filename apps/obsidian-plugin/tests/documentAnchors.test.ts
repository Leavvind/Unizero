import { describe, expect, it } from "vitest";
import { resolveTextLocation, textAnchors } from "../src/documentLinks";
import { locationChoices } from "../src/linkCompletion";

describe("line-end block IDs", () => {
  it.each(["", " ", "\t"])("finds the reported CJK block with separator %j", (separator) => {
    const text = `# Title\r\n\r\n回工棚取铁锹的路上，我们从未有过这种危机感${separator}^1231312  \r\n`;
    const anchors = textAnchors(text);
    expect(locationChoices(anchors, "^")).toEqual([
      { label: "^1231312", detail: "line 3", text: "#%5E1231312", next: false },
    ]);
    expect(resolveTextLocation(text, { kind: "block", value: "1231312" })).toEqual({ status: "found", line: 2 });
    expect(text.slice(anchors[1].offset, anchors[1].offset + 8)).toBe("^1231312");
  });

  it("keeps standalone IDs and IDs after formatted prose or comments", () => {
    const text = "Paragraph\n^own-line\n\n**Prose**^bold\n\nProse^comment %%hidden%%\n";
    expect(textAnchors(text).map((a) => [a.location.value, a.line])).toEqual([
      ["own-line", 1], ["bold", 3], ["comment", 5],
    ]);
  });

  it.each([
    "Prose\\^escaped\n", "Prose^mid-line suffix\n", "Prose^before-code`code`\n",
    "Prose^before-emphasis*text*\n", "[Prose^label](https://example.com)\n",
    "`Prose^inline`\n", "```\nProse^fenced\n```\n", "    Prose^indented\n",
    "%%Prose^comment%%\n", "<!-- Prose^html -->\n", "---\nuid: Prose^property\n---\n",
  ])("ignores escaped, nonterminal and inert carets: %j", (text) => {
    expect(textAnchors(text).filter((a) => a.location.kind === "block")).toEqual([]);
  });

  it("reports duplicate unspaced IDs rather than choosing one", () => {
    expect(resolveTextLocation("First^same\n\nSecond^same\n", { kind: "block", value: "same" }))
      .toEqual({ status: "ambiguous" });
  });
});
