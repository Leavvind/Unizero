import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { replaceLocalDocument } from "../src/localDocuments";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    const absolute = resolve(folder), parent = resolve(tmpdir());
    if (!absolute.startsWith(parent + sep) || !absolute.includes("unizero-document-test-")) { throw new Error("Unsafe test cleanup path"); }
    await rm(absolute, { recursive: true, force: true });
  }
});
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "unizero-document-test-")); folders.push(folder);
  const path = join(folder, "Raw.md"); await writeFile(path, "original\r\n![](attachments/image.png)\r\n"); return { folder, path };
}
describe("local document revision protection", () => {
  it("replaces an existing file and preserves unrelated text", async () => {
    const f = await fixture(), before = await readFile(f.path, "utf8");
    await replaceLocalDocument(f.path, before, before.replace("original", "edited"));
    expect(await readFile(f.path, "utf8")).toBe("edited\r\n![](attachments/image.png)\r\n");
    expect(await readdir(f.folder)).toEqual(["Raw.md"]);
  });
  it("refuses a changed revision without overwriting it", async () => {
    const f = await fixture(); await writeFile(f.path, "user's new edit");
    await expect(replaceLocalDocument(f.path, "original", "migration")).rejects.toThrow(/changed/);
    expect(await readFile(f.path, "utf8")).toBe("user's new edit");
  });
  it("does not create an unavailable attachment", async () => {
    const f = await fixture();
    await expect(replaceLocalDocument(join(f.folder, "missing.md"), "", "new")).rejects.toThrow();
    expect(await readdir(f.folder)).toEqual(["Raw.md"]);
  });
});
