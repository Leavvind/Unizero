import {
  assertMarkdownUidAvailable,
  recordMarkdownLink,
  resolveMarkdownLink,
  uidFromMarkdownFrontmatter,
} from "../src/zotero/markdownLinkRegistry";

const files = new Map<string, string>();

function missingFile(): Error {
  const error = new Error("missing");
  error.name = "NotFoundError";
  return error;
}

beforeAll(() => {
  (globalThis as any).PathUtils = {
    join: (...parts: string[]) => parts.join("/"),
    parent: (path: string) => path.slice(0, path.lastIndexOf("/")),
  };
  (globalThis as any).IOUtils = {
    readUTF8: async (path: string) => {
      if (!files.has(path)) { throw missingFile(); }
      return files.get(path);
    },
    makeDirectory: async () => undefined,
    writeUTF8: async (path: string, value: string) => {
      files.set(path, value);
    },
  };
  (globalThis as any).Zotero.DataDirectory = { dir: "/zotero" };
  (globalThis as any).Zotero.File = {
    getContentsAsync: async (path: string) => {
      if (!files.has(path)) { throw missingFile(); }
      return files.get(path);
    },
  };
});

function item(libraryID: number, key: string): Zotero.Item {
  return { libraryID, key } as Zotero.Item;
}

function attachment(key: string, path: string): Zotero.Item {
  return {
    key,
    getFilePathAsync: async () => files.has(path) ? path : false,
    getFilePath: () => path,
  } as unknown as Zotero.Item;
}

describe("Markdown link registry", () => {
  it("accepts the UUID text form documented by Advanced URI", () => {
    expect(uidFromMarkdownFrontmatter(
      "---\nuid: d43f7a17-058c-4aea-b8dc-515ea646825a\n---\n",
    )).toBe("d43f7a17-058c-4aea-b8dc-515ea646825a");
  });

  it("keeps numeric-looking identifiers as strings", () => {
    expect(uidFromMarkdownFrontmatter("---\nuid: 00103\n---\n")).toBe("00103");
  });

  it("reads quoted UniZero identifiers and ignores empty YAML values", () => {
    expect(uidFromMarkdownFrontmatter("---\nuid: 'unizero-1-ABCD2345'\n---\n"))
      .toBe("unizero-1-ABCD2345");
    expect(uidFromMarkdownFrontmatter("---\nuid: null\n---\n")).toBe("");
  });

  it("records a conversion and refreshes the binding after the file uid changes", async () => {
    const paper = item(101, "PAPER1");
    const markdown = attachment("MD1", "/vault/Paper.md");
    files.set("/vault/Paper.md", "---\nuid: first-id\n---\n");

    await recordMarkdownLink(paper, markdown, "/vault/Paper.md");
    expect(await resolveMarkdownLink(paper, markdown)).toMatchObject({
      libraryID: 101,
      itemKey: "PAPER1",
      attachmentKey: "MD1",
      path: "/vault/Paper.md",
      uid: "first-id",
      exists: true,
    });

    files.set("/vault/Paper.md", "---\nuid: changed-id\n---\n");
    expect(await resolveMarkdownLink(paper, markdown)).toMatchObject({
      uid: "changed-id",
      exists: true,
    });

    const document = JSON.parse(
      files.get("/zotero/unizero/markdown-links/101.json") || "{}",
    );
    expect(document.items.PAPER1.uid).toBe("changed-id");
  });

  it("rejects a uid already bound to another item in the same library", async () => {
    const first = item(102, "FIRST");
    const second = item(102, "SECOND");
    const firstAttachment = attachment("MD1", "/vault/First.md");
    files.set("/vault/First.md", "---\nuid: shared-id\n---\n");
    await recordMarkdownLink(first, firstAttachment, "/vault/First.md");

    await expect(assertMarkdownUidAvailable(second, "shared-id"))
      .rejects.toThrow("already linked to Zotero item FIRST");
  });

  it("does not invent a uid for an unreachable legacy absolute-path link", async () => {
    const paper = item(103, "LEGACY");
    const markdown = attachment("MD-OLD", "/old-device/Legacy.md");

    expect(await resolveMarkdownLink(paper, markdown)).toMatchObject({
      path: "/old-device/Legacy.md",
      uid: "",
      exists: false,
    });
  });
});
