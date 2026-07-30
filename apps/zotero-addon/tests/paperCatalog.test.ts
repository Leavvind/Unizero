import { PaperCatalog } from "../src/projects/paperCatalog";

const files = new Map<string, string>();

function missingFile(): Error {
  const error = new Error("missing");
  error.name = "NotFoundError";
  return error;
}

beforeEach(() => {
  files.clear();
  (globalThis as any).PathUtils = {
    join: (...parts: string[]) => parts.join("/"),
    parent: (path: string) => path.slice(0, path.lastIndexOf("/")),
  };
  (globalThis as any).IOUtils = {
    readUTF8: vi.fn(async (path: string) => {
      if (!files.has(path)) { throw missingFile(); }
      return files.get(path);
    }),
    makeDirectory: vi.fn(async () => undefined),
    writeUTF8: vi.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
  };
  (globalThis as any).Zotero.Libraries = {
    userLibraryID: 1,
    get: (libraryID: number) => libraryID === 12
      ? { libraryType: "group", libraryTypeID: 9001 }
      : { libraryType: "user" },
  };
  (globalThis as any).Zotero.ItemTypes = {
    getName: () => "journalArticle",
  };
});

function item(
  libraryID: number,
  key: string,
  title: string,
): Zotero.Item {
  const fields: Record<string, string | number> = {
    title,
    DOI: "10.1000/example",
    extra: "Semantic Scholar Paper ID: ABC123",
    date: "2024",
    publicationTitle: "Test Journal",
    abstractNote: "Abstract",
    itemTypeID: 1,
    url: "",
  };
  return {
    libraryID,
    key,
    getField: (field: string) => fields[field] || "",
    getExtraField: () => "",
    getCreators: () => [{ firstName: "Ada", lastName: "Lovelace" }],
  } as unknown as Zotero.Item;
}

describe("PaperCatalog", () => {
  it("keeps one stable Paper behind a Zotero binding while metadata changes", async () => {
    let next = 0;
    const catalog = new PaperCatalog("/data/unizero/literature", {
      now: () => 1000 + next,
      createID: (kind) => `${kind}_${++next}`,
    });

    const first = await catalog.ensureZoteroPaper(
      item(1, "ITEM1", "Original title"),
    );
    const refreshed = await catalog.ensureZoteroPaper(
      item(1, "ITEM1", "Corrected title"),
    );

    expect(first.id).toBe("paper_1");
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.title).toBe("Corrected title");
    expect(refreshed.identifiers).toMatchObject({
      doi: "10.1000/example",
      semanticScholarPaperId: "ABC123",
    });
    expect(refreshed.bindings).toEqual([{
      library: "library",
      itemKey: "ITEM1",
    }]);
    expect(await catalog.readPaper(first.id)).toEqual(refreshed);
  });

  it("uses the portable group scope in the binding index", async () => {
    const catalog = new PaperCatalog("/data/unizero/literature", {
      createID: () => "paper_group",
    });
    const paper = await catalog.ensureZoteroPaper(
      item(12, "GROUPITEM", "Group paper"),
    );

    expect(paper.bindings).toEqual([{
      library: "groups/9001",
      itemKey: "GROUPITEM",
    }]);
    const index = JSON.parse(
      files.get("/data/unizero/literature/index.json") || "{}",
    );
    expect(index.bindings["groups/9001:GROUPITEM"]).toBe("paper_group");
  });
});
