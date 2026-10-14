import { noteLink, parseNoteLink } from "../src/zotero/noteLinks";

describe("zotero://note links", () => {
  const libraries: Record<number, { libraryType: string }> = {
    1: { libraryType: "user" },
    5: { libraryType: "group" },
    9: { libraryType: "feed" },
  };
  let original: { Libraries: unknown; Groups: unknown };

  beforeEach(() => {
    const zotero = (globalThis as any).Zotero;
    original = { Libraries: zotero.Libraries, Groups: zotero.Groups };
    zotero.Libraries = { userLibraryID: 1, get: (id: number) => libraries[id] };
    zotero.Groups = {
      getGroupIDFromLibraryID: (id: number) => (id === 5 ? 77 : false),
      getLibraryIDFromGroupID: (id: number) => (id === 77 ? 5 : false),
    };
  });

  afterEach(() => {
    Object.assign((globalThis as any).Zotero, original);
  });

  it("uses u for the user library and the group ID for a group", () => {
    expect(noteLink({ libraryID: 1, key: "IQQ6S4FN" } as any)).toBe("zotero://note/u/IQQ6S4FN/");
    expect(noteLink({ libraryID: 5, key: "IQQ6S4FN" } as any)).toBe("zotero://note/77/IQQ6S4FN/");
    expect(noteLink({ libraryID: 9, key: "IQQ6S4FN" } as any)).toBeUndefined();
  });

  it("round-trips through the parser", () => {
    expect(parseNoteLink("zotero://note/u/IQQ6S4FN/")).toEqual({ libraryID: 1, key: "IQQ6S4FN" });
    expect(parseNoteLink("zotero://note/77/IQQ6S4FN/")).toEqual({ libraryID: 5, key: "IQQ6S4FN" });
  });

  it("accepts the query parameters Better Notes wrote", () => {
    expect(parseNoteLink("zotero://note/u/IQQ6S4FN/?line=12")).toEqual({ libraryID: 1, key: "IQQ6S4FN" });
    expect(parseNoteLink("zotero://note/u/IQQ6S4FN?section=Intro")).toEqual({ libraryID: 1, key: "IQQ6S4FN" });
  });

  it("rejects other links and unknown groups", () => {
    expect(parseNoteLink("zotero://select/library/items/IQQ6S4FN")).toBeUndefined();
    expect(parseNoteLink("zotero://note/u/")).toBeUndefined();
    expect(parseNoteLink("zotero://note/12/IQQ6S4FN/")).toBeUndefined();
  });
});
