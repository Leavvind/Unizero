import {
  NOTE_MAX_CHARS,
  NOTE_PART_CHARS,
  partNumber,
  publishRawNote,
  rawNotes,
  rawNoteLinks,
  wrapNoteHtml,
} from "../src/zotero/rawNoteAdapter";

class FakeNote {
  static saved: FakeNote[] = [];
  libraryID = 0;
  parentID = 0;
  html = "";
  tags: Array<{ tag: string; type?: number }> = [];
  saves = 0;
  deleted = false;
  setNote(html: string) { this.html = html; return true; }
  getNote() { return this.html; }
  addTag(tag: string, type?: number) { this.tags.push({ tag, type }); }
  getTags() { return this.tags; }
  async saveTx() { this.saves++; FakeNote.saved.push(this); }
}

const library = new Map<number, FakeNote>();
const converter = { md2html: async (md: string) => `<p>${md}</p>` };

function parentWith(...notes: FakeNote[]): any {
  notes.forEach((note, index) => library.set(index + 100, note));
  return {
    id: 7,
    libraryID: 3,
    getNotes: () => notes.map((_note, index) => index + 100),
  };
}

function owned(html: string): FakeNote {
  const note = new FakeNote();
  note.html = html;
  note.tags.push({ tag: "unizero:raw-note" });
  return note;
}

beforeEach(() => {
  library.clear();
  FakeNote.saved = [];
  (globalThis as any).Zotero.Item = FakeNote;
  (globalThis as any).Zotero.Items.get = (id: number) => library.get(id);
});

describe("Raw note", () => {
  it("wraps the rendered HTML in the note-editor document", () => {
    expect(wrapNoteHtml("<p>x</p>")).toBe(
      '<div data-schema-version="9"><p>x</p></div>',
    );
  });

  it("creates a tagged child note under the paper", async () => {
    const result = await publishRawNote(parentWith(), "hello", "skip", converter);

    expect(result.outcome).toBe("created");
    const [note] = FakeNote.saved;
    expect(note.parentID).toBe(7);
    expect(note.libraryID).toBe(3);
    expect(note.html).toBe('<div data-schema-version="9"><p>hello</p></div>');
    expect(note.tags.map((entry) => entry.tag)).toEqual(["unizero:raw-note"]);
  });

  it("keeps an existing note without rendering anything", async () => {
    const existing = owned("<p>my edits</p>");
    let rendered = false;
    const result = await publishRawNote(parentWith(existing), "new", "skip", {
      md2html: async () => { rendered = true; return ""; },
    });

    expect(result.outcome).toBe("kept");
    expect(rendered).toBe(false);
    expect(existing.html).toBe("<p>my edits</p>");
    expect(FakeNote.saved).toHaveLength(0);
  });

  it("replaces only the first owned note when told to", async () => {
    const first = owned("<p>old</p>");
    const second = owned("<p>another</p>");
    const result = await publishRawNote(
      parentWith(first, second), "new", "replace", converter,
    );

    expect(result.outcome).toBe("replaced");
    expect(first.html).toBe('<div data-schema-version="9"><p>new</p></div>');
    expect(second.html).toBe("<p>another</p>");
  });

  it("never mistakes the user's own note for the Raw note", async () => {
    const mine = new FakeNote();
    mine.html = "<p>my own note</p>";
    const result = await publishRawNote(parentWith(mine), "x", "skip", converter);

    expect(result.outcome).toBe("created");
    expect(mine.html).toBe("<p>my own note</p>");
  });

  it("measures characters, not bytes: long Chinese text stays one note", async () => {
    const chinese = "字".repeat(NOTE_MAX_CHARS - 100);
    const result = await publishRawNote(parentWith(), chinese, "skip", converter);

    expect(result.parts).toBe(1);
    expect(result.oversize).toBe(false);
    expect(partNumber(FakeNote.saved[0].html)).toBe(0);
  });

  it("splits a note past the limit into runs of top-level sections", async () => {
    const chapter = (n: number) => `# Chapter ${n}\n\n${"x".repeat(100_000)}`;
    const markdown = [1, 2, 3, 4, 5, 6].map(chapter).join("\n\n");
    const result = await publishRawNote(parentWith(), markdown, "skip", converter);

    expect(result.outcome).toBe("created");
    expect(result.parts).toBe(2);
    expect(result.oversize).toBe(false);
    const [first, second] = FakeNote.saved;
    expect(first.html).toMatch(/^<div[^>]*><p>Part 1\/2 · Chapter 1<\/p>/);
    expect(second.html).toMatch(/^<div[^>]*><p>Part 2\/2 · Chapter 4<\/p>/);
    for (const note of FakeNote.saved) {
      expect(note.html.length).toBeLessThanOrEqual(NOTE_PART_CHARS + 200);
      expect(note.tags.map((entry) => entry.tag)).toEqual(["unizero:raw-note"]);
    }
    expect(second.html).toContain("# Chapter 6");
  });

  it("falls back to paragraphs when there are no headings", async () => {
    const markdown = Array(10).fill("y".repeat(60_000)).join("\n\n");
    const result = await publishRawNote(parentWith(), markdown, "skip", converter);

    expect(result.parts).toBe(2);
    expect(FakeNote.saved[0].html).toMatch(/<p>Part 1\/2<\/p>/);
  });

  it("flags a single block that cannot be split, but still creates it", async () => {
    const result = await publishRawNote(
      parentWith(), "z".repeat(NOTE_MAX_CHARS + 10), "skip", converter,
    );

    expect(result.outcome).toBe("created");
    expect(result.parts).toBe(1);
    expect(result.oversize).toBe(true);
  });

  it("orders split parts by their part line", () => {
    const second = owned('<div data-schema-version="9"><p>Part 2/2 · B</p></div>');
    const first = owned('<div data-schema-version="9"><p>Part 1/2 · A</p></div>');
    expect(rawNotes(parentWith(second, first))).toEqual([first, second]);
  });

  it("replaces parts in place and trashes only the stale parts", async () => {
    const part = (n: number) =>
      owned(`<div data-schema-version="9"><p>Part ${n}/3</p></div>`);
    const [one, two, three] = [part(1), part(2), part(3)];
    const userCopy = owned("<p>my copy</p>");
    const result = await publishRawNote(
      parentWith(three, userCopy, one, two), "short", "replace", converter,
    );

    expect(result.outcome).toBe("replaced");
    expect(result.parts).toBe(1);
    expect(one.html).toBe('<div data-schema-version="9"><p>short</p></div>');
    expect([two.deleted, three.deleted]).toEqual([true, true]);
    expect(userCopy.deleted).toBe(false);
    expect(userCopy.html).toBe("<p>my copy</p>");
  });

  it("renders with the built-in converter by default", async () => {
    await publishRawNote(parentWith(), "# T", "skip");
    expect(FakeNote.saved[0].html).toBe('<div data-schema-version="9"><h1>T</h1></div>');
  });
});

describe("Raw note links", () => {
  const libraries: Record<number, { libraryType: string }> = {
    1: { libraryType: "user" },
    5: { libraryType: "group" },
  };
  const note = (libraryID: number): any => ({ libraryID, key: "IQQ6S4FN" });
  let original: { Libraries: unknown; Groups: unknown };

  beforeEach(() => {
    const zotero = (globalThis as any).Zotero;
    original = { Libraries: zotero.Libraries, Groups: zotero.Groups };
    zotero.Libraries = { ...(zotero.Libraries as object), get: (id: number) => libraries[id] };
    zotero.Groups = { getGroupIDFromLibraryID: (id: number) => (id === 5 ? 77 : false) };
  });

  afterEach(() => {
    Object.assign((globalThis as any).Zotero, original);
  });

  it("gives the bridge both links for a note, and neither without one", () => {
    expect(rawNoteLinks(note(5), "groups/77")).toEqual({
      rawNote: "zotero://select/groups/77/items/IQQ6S4FN",
      rawNoteOpen: "zotero://note/77/IQQ6S4FN/",
    });
    expect(rawNoteLinks(note(1), "library")).toEqual({
      rawNote: "zotero://select/library/items/IQQ6S4FN",
      rawNoteOpen: "zotero://note/u/IQQ6S4FN/",
    });
    expect(rawNoteLinks(undefined, "library")).toEqual({});
  });
});
