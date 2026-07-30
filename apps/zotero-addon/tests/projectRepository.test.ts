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
});
