import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { normaliseRaw, outline, parseRaw, readSlice, search, sectionRange } from "../src/raw.js";

const RAW = [
  "﻿# Post-Earnings Drift [p1](zotero://open-pdf/library/items/PDFKEY01?page=1)",
  "",
  "",
  "",
  "## 1. Introduction   ",
  "We define ==SUE== [📖](zotero://open-pdf/library/items/PDFKEY01?page=2&annotation=ANNKEY01) as surprise.",
  "![](images/fig%201.jpg)",
  "## 2. Data [p4](zotero://open-pdf/groups/9/items/PDFKEY01?page=4)",
  "Sample from CRSP.",
  "### 2.1 Returns",
  "Returns are $r_t$.",
  "## 3. Results",
  "Drift is large. ![](https://example.org/x.png)",
].join("\n");

describe("normaliseRaw", () => {
  const dir = resolve("/papers/raw");
  const md = normaliseRaw(RAW, dir);

  it("turns page links into markers and drops highlight links", () => {
    expect(md).toContain("# Post-Earnings Drift [p.1]");
    expect(md).toContain("## 2. Data [p.4]");
    expect(md).toContain("We define ==SUE== as surprise.");
    expect(md).not.toContain("zotero://");
    expect(md.startsWith("﻿")).toBe(false);
  });

  it("makes relative image links absolute and leaves URLs alone", () => {
    expect(md).toContain(`![](<${resolve(dir, "images/fig 1.jpg")}>)`);
    expect(md).toContain("![](https://example.org/x.png)");
  });

  it("reads CRLF files like LF ones", () => {
    const crlf = parseRaw("raw.md", normaliseRaw(RAW.replace(/\n/g, "\r\n"), dir));
    expect(crlf.lines.some((line) => line.includes("\r"))).toBe(false);
    expect(outline(crlf)).toHaveLength(5);
  });

  it("collapses blank runs and trailing spaces", () => {
    expect(md).not.toMatch(/\n{3,}/);
    expect(md).toContain("## 1. Introduction\n");
  });
});

describe("document reading", () => {
  const doc = parseRaw("raw.md", normaliseRaw(RAW, "/papers"));

  it("carries the page in force on every line", () => {
    const line = doc.lines.findIndex((text) => text.startsWith("Sample from")) + 1;
    expect(doc.pages[0]).toBe(1);
    expect(doc.pages[line - 1]).toBe(4);
  });

  it("outlines headings with levels and pages, without markers", () => {
    expect(outline(doc).map((entry) => [entry.level, entry.heading, entry.page])).toEqual([
      [1, "Post-Earnings Drift", 1],
      [2, "1. Introduction", 1],
      [2, "2. Data", 4],
      [3, "2.1 Returns", 4],
      [2, "3. Results", 4],
    ]);
  });

  it("bounds a section by the next heading of the same level", () => {
    const range = sectionRange(doc, "2. data")!;
    expect(doc.lines[range.from - 1]).toBe("## 2. Data [p.4]");
    expect(doc.lines[range.to - 1]).toBe("Returns are $r_t$.");
    expect(sectionRange(doc, "Returns")).toBeDefined();
    expect(sectionRange(doc, "Conclusion")).toBeUndefined();
  });

  it("stops a slice at max_chars on a line boundary", () => {
    const slice = readSlice(doc, 1, doc.lines.length, 60);
    expect(slice.truncated).toBe(true);
    expect(slice.text.split("\n")[0]).toMatch(/^L1 p\.1 {2}# Post-Earnings Drift/);
    expect(slice.to).toBeLessThan(doc.lines.length);
  });

  it("searches by regex, falling back to plain text for invalid patterns", () => {
    expect(search(doc, "sue|crsp", 0, 10).total).toBe(2);
    expect(search(doc, "$r_t", 0, 10).total).toBe(1);
    const { hits } = search(doc, "CRSP", 1, 10);
    expect(hits[0].page).toBe(4);
    expect(hits[0].text.split("\n")).toHaveLength(3);
  });

  it("skips blank lines in output, keeping line numbers and paragraph context", () => {
    const spaced = parseRaw("raw.md", "# A\n\nfirst\n\nneedle\n\nlast\n");
    expect(readSlice(spaced, 1, 7, 1000).text.split("\n").map((l) => l.split(" ")[0]))
      .toEqual(["L1", "L3", "L5", "L7"]);
    expect(search(spaced, "needle", 1, 5).hits[0].text).toBe(
      "L3 p.?  first\nL5 p.?  needle\nL7 p.?  last");
  });
});
