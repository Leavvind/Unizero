import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeArtifacts } from "../src/server/bridgePayloads";
import { paperDocument } from "../src/zotero/linkSources";

function attachment(id: number, title: string, kind?: string, extra = {}) {
  return { id, key: `ATTACH${id}`, parentID: 1, libraryID: 7, deleted: false, version: 1, dateModified: "2026-11-07",
    attachmentContentType: "text/markdown", attachmentFilename: `${title}.md`,
    isFileAttachment: () => true, getField: () => title, getTags: () => kind ? [{ tag: `unizero:${kind}` }] : [],
    getNote: () => kind ? `<!--unizero:${JSON.stringify({ kind, source: "ATTACH10", schema: 1 })}-->` : "",
    getFilePathAsync: vi.fn(async () => `C:/storage/${id}/document.md`), ...extra };
}
let entries: ReturnType<typeof attachment>[];
const parent = { id: 1, key: "PAPER001", libraryID: 7, getField: () => "Paper", getAttachments: () => entries.map((a) => a.id) };

beforeEach(() => {
  entries = [
    attachment(10, "Paper.pdf", undefined, { attachmentContentType: "application/pdf", attachmentFilename: "paper.pdf" }),
    attachment(11, "Working text", "raw"), attachment(12, "Reading notes"),
    attachment(13, "Backup", "raw-backup"), attachment(14, "Summary", "markdown"),
    attachment(15, "Board", "canvas", { attachmentFilename: "board.canvas" }),
    attachment(16, "Deleted notes", undefined, { deleted: true }),
    attachment(17, "Other library", undefined, { libraryID: 2 }),
    attachment(18, "Other parent", undefined, { parentID: 2 }),
    attachment(19, "Inline note", undefined, { isFileAttachment: () => false }),
    attachment(20, "Unknown export", "future-output"),
    attachment(21, "By filename", undefined, { attachmentContentType: "application/octet-stream" }),
  ];
  (Zotero as any).Items = { get: (id: number) => entries.find((a) => a.id === id),
    getAsync: async (ids: number[]) => ids.map((id) => entries.find((a) => a.id === id)) };
  (globalThis as any).IOUtils = { exists: vi.fn(async () => true) };
});

describe("Markdown attachment candidates from /artifacts", () => {
  it("declares Raw and ordinary Markdown using the same eligibility as the resolver", async () => {
    const listing = await bridgeArtifacts(parent as any);
    expect(listing).toMatchObject({ libraryID: 7, itemKey: "PAPER001" });
    expect(listing.markdowns.map((f) => [f.key, f.title, f.purpose, f.main])).toEqual([
      ["ATTACH11", "Working text", "raw", true], ["ATTACH12", "Reading notes", "user", false],
      ["ATTACH21", "By filename", "user", false],
    ]);
    for (const file of listing.markdowns) {
      const source = await paperDocument(parent as any, file.key);
      expect(source).toMatchObject({ attachmentKey: file.key, path: file.path, format: "md" });
    }
    expect(listing.pdfs.map((f) => f.key)).toEqual(["ATTACH10"]);
    expect(listing.artifacts.map((f) => f.key)).toEqual(["ATTACH11", "ATTACH13", "ATTACH14", "ATTACH15"]);
  });

  it("keeps unsynced files selectable without inventing a usable path", async () => {
    (IOUtils.exists as any).mockResolvedValue(false);
    const listing = await bridgeArtifacts(parent as any);
    expect(listing.markdowns).toHaveLength(3);
    expect(listing.markdowns.every((f) => f.path === undefined)).toBe(true);
  });

  it("lists ordinary files without Raw and retains attachment identity after rename", async () => {
    entries = [attachment(12, "Renamed notes")];
    const listing = await bridgeArtifacts(parent as any);
    expect(listing.markdowns).toMatchObject([{ key: "ATTACH12", title: "Renamed notes", purpose: "user", main: false }]);
    expect(await paperDocument(parent as any)).toBeUndefined();
    expect(await paperDocument(parent as any, "ATTACH12")).toMatchObject({ title: "Renamed notes" });
  });

  it("retains file identity after a path read fails without breaking other artifacts", async () => {
    entries.find((a) => a.id === 12)!.getFilePathAsync.mockRejectedValue(new Error("offline"));
    const listing = await bridgeArtifacts(parent as any);
    expect(listing.markdowns.find((a) => a.key === "ATTACH12")).toMatchObject({ title: "Reading notes", path: undefined });
    expect(listing.artifacts.find((a) => a.key === "ATTACH11")?.path).toBe("C:/storage/11/document.md");
  });
});
