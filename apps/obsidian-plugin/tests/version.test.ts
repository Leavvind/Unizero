import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// One tag releases the add-on and this plugin; the add-on's package.json chooses
// the version and `npm run release` copies it here. A mismatch means a hand edit.
const read = (path: string): { version: string } =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("plugin version", () => {
  it("matches the Zotero add-on's version", () => {
    const addon = read("../../zotero-addon/package.json").version;
    expect(read("../manifest.json").version).toBe(addon);
    expect(read("../package.json").version).toBe(addon);
  });
});
