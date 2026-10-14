import {
  firstHeading,
  splitAtHeadings,
  splitAtParagraphs,
} from "../src/notes/splitMarkdown";

describe("splitMarkdown", () => {
  it("splits before each heading of the given level, keeping the preamble", () => {
    const md = "intro\n\n# A\na\n\n## A.1\nx\n\n# B\nb";
    expect(splitAtHeadings(md, 1)).toEqual([
      "intro\n",
      "# A\na\n\n## A.1\nx\n",
      "# B\nb",
    ]);
    expect(splitAtHeadings(md, 2)).toHaveLength(2);
  });

  it("does not treat # lines inside code or math blocks as headings", () => {
    const md = "# A\n```sh\n# comment\n```\n$$\n# not a heading\n$$\n# B";
    expect(splitAtHeadings(md, 1)).toEqual([
      "# A\n```sh\n# comment\n```\n$$\n# not a heading\n$$",
      "# B",
    ]);
  });

  it("splits at blank lines but never inside a block", () => {
    const md = "p1\n\np2\n```\na\n\nb\n```\n\np3";
    expect(splitAtParagraphs(md)).toEqual(["p1\n", "p2\n```\na\n\nb\n```\n", "p3"]);
  });

  it("reads the first heading's text", () => {
    expect(firstHeading("text\n## **Bold** title ##\n# Later")).toBe("Bold title");
    expect(firstHeading("```\n# code\n```\nplain")).toBe("");
  });
});
