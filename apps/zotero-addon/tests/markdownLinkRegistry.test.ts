import {
  defaultMarkdownUrl,
  ensureMarkdownLink,
  recordMarkdownLink,
  validateMarkdownUrl,
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
});

function item(libraryID: number, key: string): Zotero.Item {
  return { libraryID, key } as Zotero.Item;
}

describe("Markdown link registry", () => {
  it("generates an Advanced URI without using an absolute path", () => {
    expect(defaultMarkdownUrl(item(1, "ABCD2345"), "Academic"))
      .toBe("obsidian://adv-uri?vault=Academic&uid=unizero-1-ABCD2345");
    expect(defaultMarkdownUrl(item(1, "ABCD2345"), ""))
      .toBe("obsidian://adv-uri?uid=unizero-1-ABCD2345");
  });

  it("accepts only Obsidian URLs", () => {
    expect(validateMarkdownUrl(" obsidian://adv-uri?uid=20260726161952 "))
      .toBe("obsidian://adv-uri?uid=20260726161952");
    expect(() => validateMarkdownUrl("D:\\Academic\\Paper.md"))
      .toThrow("must be an obsidian:// URL");
  });

  it("creates a generated URL once and preserves a later manual edit", async () => {
    const paper = item(101, "PAPER1");
    const generated = defaultMarkdownUrl(paper, "Academic");
    expect(await ensureMarkdownLink(paper, generated)).toMatchObject({
      libraryID: 101,
      itemKey: "PAPER1",
      url: generated,
    });

    const edited = "obsidian://adv-uri?vault=Other&uid=20260726161952";
    await recordMarkdownLink(paper, edited);
    expect(await ensureMarkdownLink(
      paper,
      defaultMarkdownUrl(paper, "ChangedSetting"),
    )).toMatchObject({ url: edited });

    const document = JSON.parse(
      files.get("/zotero/unizero/markdown-links/101.json") || "{}",
    );
    expect(document.items.PAPER1.url).toBe(edited);
    expect(JSON.stringify(document)).not.toContain("D:\\");
  });
});
