import { describe, expect, it, vi, beforeEach } from "vitest";
import { attachmentLinkSource, listLinkSources, linkSourceLibraries, paperDocument } from "../src/zotero/linkSources";

const parent = { id: 1, libraryID: 2, key: "PAPER001", deleted: false, isRegularItem: () => true, getField: () => "Paper", getAttachments: () => [10, 11, 12] };
const attachment = (id: number, kind?: string, path: string | false = `C:/storage/${id}.md`) => ({ id, libraryID: 2, parentID: 1, key: `ATTACH${id}`,
  deleted: false, version: 3, dateModified: "2026-11-05", attachmentContentType: "text/markdown", attachmentFilename: `${id}.md`,
  isFileAttachment: () => true,
  getField: () => "Renamed attachment", getNote: () => "", getTags: () => kind ? [{ tag: `unizero:${kind}` }] : [],
  getFilePathAsync: vi.fn(async () => path) });

beforeEach(() => {
  const entries = new Map([[10, attachment(10, "raw")], [11, attachment(11, "raw-backup")], [12, attachment(12)]]);
  (globalThis as any).Zotero = { Libraries: { getAll: () => [{ libraryID: 2, libraryType: "group" }, { libraryID: 4, libraryType: "feed" }] },
    Items: { get: (id: number) => entries.get(id), getAsync: async (ids: number | number[]) => Array.isArray(ids) ? ids.map((id) => entries.get(id)) : entries.get(ids), getAll: vi.fn(async () => [parent]) } };
  (globalThis as any).IOUtils = { exists: vi.fn(async () => true) };
});
describe("read-only attachment directory", () => {
  it("lists Raw and declared user Markdown, excludes backups and generated summaries", async () => {
    const sources = await listLinkSources([2]);
    expect(sources.map((s) => s.attachmentKey)).toEqual(["ATTACH10", "ATTACH12"]);
    expect(sources[0]).toMatchObject({ libraryID: 2, itemKey: "PAPER001", purpose: "raw", available: true });
    for (const kind of ["raw-backup", "markdown", "markdown-copy", "references", "tables"]) {
      expect(await attachmentLinkSource(parent as any, attachment(20, kind) as any)).toBeUndefined();
    }
  });
  it("keeps unavailable sources with identity and no usable path", async () => {
    (globalThis as any).IOUtils.exists.mockResolvedValue(false);
    expect(await attachmentLinkSource(parent as any, attachment(10, "raw") as any)).toMatchObject({ available: false, path: undefined });
  });
  it("does not resolve an explicit missing attachment to a default", async () => {
    expect(await paperDocument(parent as any, "MISSING")).toBeUndefined();
    expect(await paperDocument(parent as any, "ATTACH10")).toMatchObject({ attachmentKey: "ATTACH10" });
  });
  it("rejects foreign parents/libraries and never falls back to the user library", async () => {
    const foreign = { ...attachment(10, "raw"), libraryID: 9 };
    expect(await attachmentLinkSource(parent as any, foreign as any)).toBeUndefined();
    expect(linkSourceLibraries()).toEqual([2]); expect(() => linkSourceLibraries([1])).toThrow();
  });
});
