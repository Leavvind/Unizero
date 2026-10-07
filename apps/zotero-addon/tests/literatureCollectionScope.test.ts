import { selectedLiteratureScope } from "../src/zotero/literatureCollectionAdapter";

function paneWindow(pane: object): Window {
  return { ZoteroPane: pane } as Window;
}

function collection(partial: {
  libraryID: number;
  id: number;
  key: string;
  name: string;
}): Zotero.Collection {
  return partial as Zotero.Collection;
}

/** Zotero 10 behaviour: singular getters throw and name the plural replacement. */
function zotero10Pane(overrides: {
  collections?: Zotero.Collection[];
  libraryIDs?: number[];
}): object {
  return {
    getSelectedCollection: () => {
      throw new Error("Use getSelectedCollections()");
    },
    getSelectedLibraryID: () => {
      throw new Error("Use getSelectedLibraryIDs()");
    },
    getSelectedCollections: () => overrides.collections || [],
    getSelectedLibraryIDs: () => overrides.libraryIDs || [],
  };
}

describe("selectedLiteratureScope", () => {
  const papers = collection({
    libraryID: 1,
    id: 12,
    key: "ABCD2345",
    name: "Papers",
  });

  it("uses Zotero 10 plural collection selection without calling the throwing getters", () => {
    expect(selectedLiteratureScope(paneWindow(zotero10Pane({
      collections: [papers],
    })))).toEqual({
      libraryID: 1,
      collectionID: 12,
      collectionKey: "ABCD2345",
      name: "Papers",
    });
  });

  it("falls back to the selected library when no Collection is selected", () => {
    expect(selectedLiteratureScope(paneWindow(zotero10Pane({
      libraryIDs: [2],
    })))).toEqual({
      libraryID: 2,
      name: "Library 2",
    });
  });

  it("takes the first Collection of a multi-row selection", () => {
    const drafts = collection({
      libraryID: 1,
      id: 13,
      key: "EFGH6789",
      name: "Drafts",
    });
    expect(selectedLiteratureScope(paneWindow(zotero10Pane({
      collections: [papers, drafts],
    }))).collectionID).toBe(12);
  });

  it("ignores a Collection from another library when opening from an item", () => {
    const group = collection({
      libraryID: 3,
      id: 40,
      key: "GROUPKEY",
      name: "Group papers",
    });
    expect(selectedLiteratureScope(paneWindow(zotero10Pane({
      collections: [group],
      libraryIDs: [1, 3],
    })), 1)).toEqual({
      libraryID: 1,
      name: "Library 1",
    });
  });

  it("still reads the Zotero 8/9 singular getters", () => {
    expect(selectedLiteratureScope(paneWindow({
      getSelectedCollection: () => papers,
      getSelectedLibraryID: () => 1,
    }))).toEqual({
      libraryID: 1,
      collectionID: 12,
      collectionKey: "ABCD2345",
      name: "Papers",
    });
  });
});
