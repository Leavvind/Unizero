import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadDigest, loadReferences } from "../src/artifacts.js";

// Rendered by `_block_html` / `_PAGE_TEMPLATE` in the paper runtime's
// providers/tables.py; regenerate it from there when that format changes.
const DIGEST = join(import.meta.dirname, "fixtures", "tables-digest.html");

describe("tables digest", () => {
  it("reads caption, exact page, notes, and crop of each table", async () => {
    const [first, second] = await loadDigest(DIGEST);
    expect(first).toMatchObject({
      id: "t01",
      caption: "Table 3: SUE & returns <by decile>",
      page: 12,
      footnote: "t-stats in parentheses.",
      image: { mimeType: "image/png" },
    });
    expect(first.image!.base64.length).toBeGreaterThan(0);
    expect(second).toMatchObject({ id: "t02", caption: "Table", page: undefined, image: undefined });
  });
});

describe("references file", () => {
  it("accepts the versioned schema and rejects anything else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unizero-mcp-"));
    const good = join(dir, "refs.json");
    await writeFile(good, JSON.stringify({
      schema: "unizero.references/2",
      references: [{ index: 1, raw: "Ball, R. (1968).", page: 30, identifiers: { doi: "10.2307/2490232" } }],
    }));
    expect((await loadReferences(good)).references[0].identifiers.doi).toBe("10.2307/2490232");

    const legacy = join(dir, "legacy.json");
    await writeFile(legacy, JSON.stringify({
      schema: "zominer.references/1",
      references: [{ index: 1, raw: "Ball, R. (1968).", page: 31, identifiers: {} }],
    }));
    expect((await loadReferences(legacy)).references).toHaveLength(1);

    const bad = join(dir, "other.json");
    await writeFile(bad, JSON.stringify({ references: [] }));
    await expect(loadReferences(bad)).rejects.toThrow(/not a UniZero references file/);
  });
});

describe("digest captions", () => {
  it("drops MinerU's escaped inline tags but keeps other angle brackets", async () => {
    const { parseDigest } = await import("../src/artifacts.js");
    const [table] = parseDigest(
      "<section>\n<h2>T&lt;sub&gt;a&lt;/sub&gt;ble 4 &lt;by decile&gt;</h2>\n</section>");
    expect(table.caption).toBe("Table 4 <by decile>");
  });
});
