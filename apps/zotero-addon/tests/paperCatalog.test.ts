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
    getChildren: vi.fn(async (directory: string) => {
      const prefix = `${directory}/`;
      const children = [...files.keys()].filter((path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
      if (!children.length) { throw missingFile(); }
      return children;
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
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
  doi = "10.1000/example",
  semanticScholarID = "ABC123",
): Zotero.Item {
  const fields: Record<string, string | number> = {
    title,
    DOI: doi,
    extra: `Semantic Scholar Paper ID: ${semanticScholarID}`,
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

  it("upgrades a legacy binding-only index without changing Paper identity", async () => {
    const root = "/data/unizero/literature";
    const firstCatalog = new PaperCatalog(root, {
      createID: () => "paper_legacy",
    });
    const source = item(1, "LEGACY", "Legacy paper");
    const first = await firstCatalog.ensureZoteroPaper(source);
    const indexPath = `${root}/index.json`;
    const legacy = JSON.parse(files.get(indexPath) || "{}");
    delete legacy.aliases;
    delete legacy.provisionals;
    files.set(indexPath, JSON.stringify(legacy));

    const reopened = new PaperCatalog(root, {
      createID: () => "paper_should_not_replace",
    });
    const restored = await reopened.ensureZoteroPaper(source);

    expect(restored.id).toBe(first.id);
    expect(await reopened.listCitationObservations()).toEqual([]);
    const upgraded = JSON.parse(files.get(indexPath) || "{}");
    expect(upgraded.aliases["doi:10.1000/example"]).toBe(first.id);
    expect(upgraded.provisionals).toEqual({});
  });

  it("pins an external paper without creating a Zotero binding", async () => {
    let next = 0;
    const catalog = new PaperCatalog("/data/unizero/literature", {
      now: () => 1000 + next,
      createID: () => `paper_external_${++next}`,
    });
    const seed = {
      identifiers: { doi: "https://doi.org/10.1000/EXAMPLE" },
      title: "Discovered title",
      authors: ["Grace Hopper"],
      year: "2025",
    };

    const first = await catalog.ensureExternalPaper(seed);
    const repeated = await catalog.ensureExternalPaper({
      ...seed,
      title: "Discovered title, corrected",
    });

    expect(first.id).toBe("paper_external_1");
    expect(repeated.id).toBe(first.id);
    expect(repeated.retention).toBe("pinned");
    expect(repeated.bindings).toEqual([]);
    expect(repeated.title).toBe("Discovered title, corrected");
    const index = JSON.parse(
      files.get("/data/unizero/literature/index.json") || "{}",
    );
    expect(index.aliases["doi:10.1000/example"]).toBe(first.id);
  });

  it("adds a Zotero binding to the same Paper after an external paper is imported", async () => {
    let next = 0;
    const catalog = new PaperCatalog("/data/unizero/literature", {
      createID: () => `paper_${++next}`,
    });
    const external = await catalog.ensureExternalPaper({
      identifiers: {
        doi: "10.1000/example",
        openAlexId: "W123456",
      },
      title: "Provider title",
      authors: ["Provider Author"],
    });
    const bound = await catalog.ensureZoteroPaper(
      item(1, "IMPORTED", "Zotero title"),
    );

    expect(bound.id).toBe(external.id);
    expect(bound.retention).toBe("zotero");
    expect(bound.identifiers.openAlexId).toBe("W123456");
    expect(bound.bindings).toEqual([{
      library: "library",
      itemKey: "IMPORTED",
    }]);
  });

  it("stores References and Citations as observations of one directed edge", async () => {
    let next = 0;
    const catalog = new PaperCatalog("/data/unizero/literature", {
      now: () => 2000 + next,
      createID: (kind) => `${kind}_${++next}`,
    });
    const paperA = item(1, "A", "Paper A", "10.1000/a", "S2A");
    const paperB = item(1, "B", "Paper B", "10.1000/b", "S2B");
    const seed = (
      doi: string,
      title: string,
    ) => ({
      identifiers: { doi },
      title,
      authors: ["Researcher"],
    });

    const references = await catalog.recordDiscoverySnapshot(paperA, {
      kind: "references",
      retrievedAt: 100,
      merged: [seed("10.1000/b", "Paper B")],
      sources: [{
        provider: "openAlex",
        entries: [seed("10.1000/b", "Paper B")],
      }],
    });
    expect((await catalog.readPaper(references.mergedPaperIDs[0])).retention)
      .toBe("cache");

    const citations = await catalog.recordDiscoverySnapshot(paperB, {
      kind: "citations",
      retrievedAt: 200,
      merged: [seed("10.1000/a", "Paper A")],
      sources: [{
        provider: "openAlex",
        entries: [seed("10.1000/a", "Paper A")],
      }],
    });

    expect(citations.seedPaperID).toBe(references.mergedPaperIDs[0]);
    expect(citations.mergedPaperIDs[0]).toBe(references.seedPaperID);
    expect((await catalog.readPaper(citations.seedPaperID)).retention)
      .toBe("zotero");
    expect(await catalog.listCitationObservations()).toEqual([
      expect.objectContaining({
        citingPaperID: references.seedPaperID,
        citedPaperID: references.mergedPaperIDs[0],
        provider: "openAlex",
        queryKind: "references",
        retrievedAt: 100,
      }),
      expect.objectContaining({
        citingPaperID: references.seedPaperID,
        citedPaperID: references.mergedPaperIDs[0],
        provider: "openAlex",
        queryKind: "citations",
        retrievedAt: 200,
      }),
    ]);
  });

  it("reuses query-scoped provisional Papers and observations", async () => {
    let next = 0;
    const catalog = new PaperCatalog("/data/unizero/literature", {
      createID: (kind) => `${kind}_${++next}`,
    });
    const seedItem = item(1, "A", "Paper A", "10.1000/a");
    const anonymous = {
      identifiers: {},
      title: "Unresolved bibliography entry",
      authors: ["Unknown Author"],
      year: "1999",
    };
    const snapshot = (retrievedAt: number) => ({
      kind: "references" as const,
      retrievedAt,
      merged: [anonymous],
      sources: [{ provider: "crossref", entries: [anonymous] }],
    });

    const first = await catalog.recordDiscoverySnapshot(
      seedItem,
      snapshot(100),
    );
    const repeated = await catalog.recordDiscoverySnapshot(
      seedItem,
      snapshot(200),
    );

    expect(repeated.mergedPaperIDs).toEqual(first.mergedPaperIDs);
    expect(repeated.observations[0].id).toBe(first.observations[0].id);
    expect(repeated.observations[0].retrievedAt).toBe(200);
    const pinned = await catalog.pinPaper(first.mergedPaperIDs[0]);
    expect(pinned.retention).toBe("pinned");
    await catalog.recordDiscoverySnapshot(seedItem, snapshot(300));
    expect((await catalog.readPaper(pinned.id)).retention).toBe("pinned");
  });

  it("replaces a complete provider route and garbage-collects orphan cache Papers", async () => {
    let next = 0;
    const catalog = new PaperCatalog("/data/unizero/literature", {
      createID: (kind) => `${kind}_${++next}`,
    });
    const seedItem = item(1, "A", "Paper A", "10.1000/a", "S2A");
    const paper = (doi: string) => ({
      identifiers: { doi },
      title: `Paper ${doi}`,
      authors: ["Researcher"],
    });
    const paperB = paper("10.1000/b");
    const paperC = paper("10.1000/c");

    const first = await catalog.recordDiscoverySnapshot(seedItem, {
      kind: "references",
      retrievedAt: 100,
      merged: [paperB, paperC],
      sources: [{
        provider: "openAlex",
        entries: [paperB, paperC],
        complete: true,
      }],
    });
    const removedPaperID = first.mergedPaperIDs[1];
    const refreshed = await catalog.recordDiscoverySnapshot(seedItem, {
      kind: "references",
      retrievedAt: 200,
      merged: [paperB],
      sources: [{
        provider: "openAlex",
        entries: [paperB],
        complete: true,
      }],
    });

    expect(refreshed.removedObservationIDs).toHaveLength(1);
    expect(refreshed.garbageCollectedPaperIDs).toEqual([removedPaperID]);
    expect(await catalog.listCitationObservations()).toHaveLength(1);
    await expect(catalog.readPaper(removedPaperID)).rejects.toThrow();
  });

  it("does not compact an incomplete paged provider snapshot", async () => {
    let next = 0;
    const catalog = new PaperCatalog("/data/unizero/literature", {
      createID: (kind) => `${kind}_${++next}`,
    });
    const seedItem = item(1, "A", "Paper A", "10.1000/a", "S2A");
    const paper = (doi: string) => ({
      identifiers: { doi },
      title: `Paper ${doi}`,
      authors: ["Researcher"],
    });
    const paperB = paper("10.1000/b");
    const paperC = paper("10.1000/c");

    const first = await catalog.recordDiscoverySnapshot(seedItem, {
      kind: "citations",
      retrievedAt: 100,
      merged: [paperB, paperC],
      sources: [{
        provider: "semanticScholar",
        entries: [paperB, paperC],
        complete: true,
      }],
    });
    const partial = await catalog.recordDiscoverySnapshot(seedItem, {
      kind: "citations",
      retrievedAt: 200,
      merged: [paperB],
      sources: [{
        provider: "semanticScholar",
        entries: [paperB],
        complete: false,
      }],
    });

    expect(partial.removedObservationIDs).toEqual([]);
    expect(partial.garbageCollectedPaperIDs).toEqual([]);
    expect(await catalog.listCitationObservations()).toHaveLength(2);
    expect(await catalog.readPaper(first.mergedPaperIDs[1])).toBeTruthy();
  });

  it("reviews identifier conflicts and explicitly merges Papers through a redirect", async () => {
    let next = 0;
    const catalog = new PaperCatalog("/data/unizero/literature", {
      now: () => 1000 + next,
      createID: (kind) => `${kind}_${++next}`,
    });
    const seedItem = item(1, "A", "Paper A", "10.1000/a", "S2A");
    const paperB = {
      identifiers: { doi: "10.1000/b" },
      title: "Paper B",
      authors: ["Researcher B"],
    };
    const paperC = {
      identifiers: { doi: "10.1000/c" },
      title: "Paper C",
      authors: ["Researcher C"],
    };
    const discovered = await catalog.recordDiscoverySnapshot(seedItem, {
      kind: "references",
      retrievedAt: 100,
      merged: [paperB, paperC],
      sources: [{
        provider: "crossref",
        entries: [paperB, paperC],
        complete: true,
      }],
    });
    const preferredID = discovered.mergedPaperIDs[0];
    const duplicateID = discovered.mergedPaperIDs[1];
    await catalog.ensureZoteroPaper(
      item(1, "B", "Paper B from Zotero", "10.1000/b", "S2B"),
    );
    await catalog.ensureZoteroPaper(
      item(1, "C", "Paper C from Zotero", "10.1000/c", "S2C"),
    );

    expect(await catalog.inspectIdentifiers({
      doi: "10.1000/b",
      openAlexId: undefined,
      semanticScholarPaperId: undefined,
      arxiv: undefined,
    })).toMatchObject({
      status: "matched",
      paperIDs: [preferredID],
    });
    expect(await catalog.inspectIdentifiers({
      doi: "10.1000/b",
      semanticScholarPaperId: "not-indexed",
    })).toMatchObject({
      status: "matched",
      paperIDs: [preferredID],
    });
    const indexPath = "/data/unizero/literature/index.json";
    const index = JSON.parse(files.get(indexPath) || "{}");
    index.aliases["s2:conflicting"] = duplicateID;
    files.set(indexPath, JSON.stringify(index));
    const reopened = new PaperCatalog("/data/unizero/literature", {
      now: () => 5000,
      createID: (kind) => `${kind}_unused`,
    });
    expect(await reopened.inspectIdentifiers({
      doi: "10.1000/b",
      semanticScholarPaperId: "conflicting",
    })).toMatchObject({
      status: "conflict",
      paperIDs: [duplicateID, preferredID].sort(),
    });

    const merged = await reopened.mergePapers(preferredID, duplicateID);
    expect(merged.redirect).toMatchObject({
      sourcePaperID: duplicateID,
      targetPaperID: preferredID,
    });
    expect(merged.removedObservationIDs).toHaveLength(1);
    expect((await reopened.readPaper(duplicateID)).id).toBe(preferredID);
    expect(await reopened.resolvePaperID(duplicateID)).toBe(preferredID);
    expect(await reopened.listPaperRedirects()).toEqual([merged.redirect]);
    const refreshedDuplicateBinding = await reopened.ensureZoteroPaper(
      item(1, "C", "Changed duplicate title", "10.1000/c", "S2C"),
    );
    expect(refreshedDuplicateBinding.title).toBe("Paper B from Zotero");
    expect(refreshedDuplicateBinding.canonicalBinding).toEqual({
      library: "library",
      itemKey: "B",
    });
    expect(await reopened.listCitationObservations()).toEqual([
      expect.objectContaining({
        citingPaperID: discovered.seedPaperID,
        citedPaperID: preferredID,
      }),
    ]);
    const mergedIndex = JSON.parse(files.get(indexPath) || "{}");
    expect(mergedIndex.aliases["doi:10.1000/c"]).toBe(preferredID);
    expect(mergedIndex.aliases["s2:conflicting"]).toBe(preferredID);
  });
});
