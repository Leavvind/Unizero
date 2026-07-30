import {
  ProjectRepository,
  projectSubjectForScope,
} from "../src/projects/projectRepository";

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
    getChildren: vi.fn(async (directory: string) => {
      const prefix = `${directory}/`;
      return [...files.keys()].filter((path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
    }),
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
});

function repository() {
  let next = 0;
  return new ProjectRepository("/data/unizero/projects", {
    now: () => 1000 + next,
    createID: (kind) => `${kind}_${++next}`,
  });
}

describe("ProjectRepository", () => {
  it("maps one portable Collection subject to one stable Project and Board", async () => {
    const store = repository();
    const subject = projectSubjectForScope({
      libraryID: 1,
      collectionID: 44,
      collectionKey: "COLLKEY1",
      name: "Asset Pricing",
    });

    const first = await store.ensureProject(subject, "Asset Pricing");
    const second = await store.ensureProject(subject, "Asset Pricing");

    expect(first).toEqual(second);
    expect(first.project.id).toBe("project_1");
    expect(first.defaultBoard.id).toBe("board_2");
    expect(first.project.subject).toEqual({
      kind: "collection",
      library: "library",
      collectionKey: "COLLKEY1",
    });
    expect(files.has(
      "/data/unizero/projects/objects/project_1/boards/board_2.json",
    )).toBe(true);
  });

  it("preserves identity across a Collection rename", async () => {
    const store = repository();
    const subject = projectSubjectForScope({
      libraryID: 1,
      collectionID: 44,
      collectionKey: "COLLKEY1",
      name: "Old name",
    });

    const first = await store.ensureProject(subject, "Old name");
    const renamed = await store.ensureProject(subject, "New name");

    expect(renamed.project.id).toBe(first.project.id);
    expect(renamed.defaultBoard.id).toBe(first.defaultBoard.id);
    expect(renamed.project.name).toBe("New name");
    expect(renamed.project.updatedAt).toBeGreaterThan(first.project.updatedAt);
  });

  it("serialises concurrent creation for the same Collection", async () => {
    const store = repository();
    const subject = projectSubjectForScope({
      libraryID: 12,
      collectionID: 55,
      collectionKey: "GROUPCOLL",
      name: "Group research",
    });

    const [left, right] = await Promise.all([
      store.ensureProject(subject, "Group research"),
      store.ensureProject(subject, "Group research"),
    ]);

    expect(left.project.id).toBe(right.project.id);
    expect(left.project.subject).toMatchObject({
      library: "groups/9001",
      collectionKey: "GROUPCOLL",
    });
    const index = JSON.parse(
      files.get("/data/unizero/projects/index.json") || "{}",
    );
    expect(Object.values(index.subjects)).toEqual([left.project.id]);
  });

  it("rejects a local collection row ID without a portable collection key", () => {
    expect(() => projectSubjectForScope({
      libraryID: 1,
      collectionID: 44,
      name: "Broken scope",
    })).toThrow("Collection key is required");
  });

  it("persists duplicate paper nodes independently and tombstones deletion", async () => {
    const store = repository();
    const subject = projectSubjectForScope({
      libraryID: 1,
      collectionID: 44,
      collectionKey: "COLLKEY1",
      name: "Board Project",
    });
    const bundle = await store.ensureProject(subject, "Board Project");

    const first = await store.createPaperNode(
      bundle.project.id,
      bundle.defaultBoard.id,
      "paper_A",
      { x: 10, y: 20 },
    );
    const duplicate = await store.createPaperNode(
      bundle.project.id,
      bundle.defaultBoard.id,
      "paper_A",
      { x: 300, y: 400 },
    );

    expect(first.id).not.toBe(duplicate.id);
    expect((await store.listBoardNodes(
      bundle.project.id,
      bundle.defaultBoard.id,
    )).map((node) => node.id)).toEqual([first.id, duplicate.id]);

    const moved = await store.moveBoardNode(
      bundle.project.id,
      bundle.defaultBoard.id,
      first.id,
      { x: Number.POSITIVE_INFINITY, y: -45, width: 20, height: 9999 },
    );
    expect(moved.geometry).toEqual({
      x: 10,
      y: -45,
      width: 160,
      height: 520,
    });

    const deleted = await store.deleteBoardNode(
      bundle.project.id,
      bundle.defaultBoard.id,
      first.id,
    );
    expect(deleted.deletedAt).toBeTypeOf("number");
    expect((await store.listBoardNodes(
      bundle.project.id,
      bundle.defaultBoard.id,
    )).map((node) => node.id)).toEqual([duplicate.id]);
  });

  it("persists manual edges independently and tombstones deletion", async () => {
    const store = repository();
    const subject = projectSubjectForScope({
      libraryID: 1,
      collectionID: 44,
      collectionKey: "COLLKEY1",
      name: "Connected Board",
    });
    const bundle = await store.ensureProject(subject, "Connected Board");
    const source = await store.createPaperNode(
      bundle.project.id,
      bundle.defaultBoard.id,
      "paper_A",
      { x: 10, y: 20 },
    );
    const target = await store.createPaperNode(
      bundle.project.id,
      bundle.defaultBoard.id,
      "paper_B",
      { x: 300, y: 400 },
    );

    await expect(store.createManualEdge(
      bundle.project.id,
      bundle.defaultBoard.id,
      source.id,
      source.id,
    )).rejects.toThrow("two different Board nodes");

    const edge = await store.createManualEdge(
      bundle.project.id,
      bundle.defaultBoard.id,
      source.id,
      target.id,
    );
    expect(await store.listBoardEdges(
      bundle.project.id,
      bundle.defaultBoard.id,
    )).toEqual([edge]);

    const deleted = await store.deleteBoardEdge(
      bundle.project.id,
      bundle.defaultBoard.id,
      edge.id,
    );
    expect(deleted.deletedAt).toBeTypeOf("number");
    expect(await store.listBoardEdges(
      bundle.project.id,
      bundle.defaultBoard.id,
    )).toEqual([]);
  });

  it("persists ordered text and embedded-paper blocks beside legacy paper nodes", async () => {
    const store = repository();
    const subject = projectSubjectForScope({
      libraryID: 1,
      collectionID: 44,
      collectionKey: "COLLKEY1",
      name: "Block Board",
    });
    const bundle = await store.ensureProject(subject, "Block Board");
    const legacyPaper = await store.createPaperNode(
      bundle.project.id,
      bundle.defaultBoard.id,
      "paper_A",
      { x: 10, y: 20 },
    );
    const textNode = await store.createTextNode(
      bundle.project.id,
      bundle.defaultBoard.id,
      { x: 400, y: 300 },
    );
    const textBlock = textNode.blocks[0];

    const edited = await store.updateTextBlock(
      bundle.project.id,
      bundle.defaultBoard.id,
      textNode.id,
      textBlock.id,
      "A connected reading note",
    );
    expect(edited.blocks[0]).toMatchObject({
      id: textBlock.id,
      kind: "text",
      text: "A connected reading note",
    });

    const embedded = await store.addPaperBlock(
      bundle.project.id,
      bundle.defaultBoard.id,
      textNode.id,
      "paper_A",
    );
    expect(embedded.blocks).toEqual([
      edited.blocks[0],
      expect.objectContaining({ kind: "paper", paperID: "paper_A" }),
    ]);

    const withoutPaper = await store.deleteContentBlock(
      bundle.project.id,
      bundle.defaultBoard.id,
      textNode.id,
      embedded.blocks[1].id,
    );
    expect(withoutPaper.blocks).toEqual([edited.blocks[0]]);

    const listed = await store.listBoardNodes(
      bundle.project.id,
      bundle.defaultBoard.id,
    );
    expect(listed.map((node) => node.kind)).toEqual(["paper", "text"]);
    expect(listed[0]).toEqual(legacyPaper);
    expect(listed[1]).toEqual(withoutPaper);
  });
});
