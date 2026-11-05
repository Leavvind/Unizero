import { describe, expect, it, vi } from "vitest";
import { LinkSourceDirectory } from "../src/server/linkSourceDirectory";
import type { LinkSource } from "../src/zotero/linkSources";

const source = (key: string): LinkSource => ({ libraryID: 2, itemKey: "PAPER001", attachmentKey: key,
  title: key, itemTitle: "Paper", format: "md", purpose: "raw", available: false, version: "1" });
describe("source directory snapshots", () => {
  it("continues the same snapshot even if the library changes", async () => {
    const read = vi.fn(async () => [source("A"), source("B")]);
    const directory = new LinkSourceDirectory(() => [2], read);
    const first = await directory.page({ limit: "1" });
    read.mockResolvedValue([source("C")]);
    const second = await directory.page({ scan: first.scan, offset: String(first.nextOffset), limit: "1" });
    expect(first.complete).toBe(false); expect(second.complete).toBe(true);
    expect(second.items[0].attachmentKey).toBe("B"); expect(read).toHaveBeenCalledTimes(1);
    expect(first.scope).toEqual([2]);
  });
  it("expires interrupted scans explicitly", async () => {
    let now = 0; const directory = new LinkSourceDirectory(() => [2], async () => [], () => now);
    const first = await directory.page({}); now = 300001;
    await expect(directory.page({ scan: first.scan })).rejects.toMatchObject({ status: 409 });
  });
  it("bounds retained snapshots and clears them on unload", async () => {
    const directory = new LinkSourceDirectory(() => [2], async () => []);
    const first = await directory.page({});
    for (let i = 0; i < 4; i += 1) { await directory.page({}); }
    await expect(directory.page({ scan: first.scan })).rejects.toMatchObject({ status: 409 });
    const latest = await directory.page({}); directory.clear();
    await expect(directory.page({ scan: latest.scan })).rejects.toMatchObject({ status: 409 });
  });
  it.each([{ offset: "1" }, { limit: "201" }, { offset: "-1" }, { libraries: "0" }, { libraries: "2,no" }])("rejects invalid scope/page %s", async (query) => {
    const directory = new LinkSourceDirectory(() => [2], async () => []);
    await expect(directory.page(query)).rejects.toMatchObject({ status: 400 });
  });
  it("does not publish a partial directory on failure", async () => {
    const directory = new LinkSourceDirectory(() => [2], async () => { throw new Error("library unreadable"); });
    await expect(directory.page({})).rejects.toThrow("library unreadable");
  });
});
