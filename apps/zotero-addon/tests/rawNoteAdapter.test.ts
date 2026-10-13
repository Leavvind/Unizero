import {
  NOTE_SOFT_LIMIT_BYTES,
  RawNoteUnavailableError,
  betterNotesConverter,
  betterNotesNoteLink,
  noteBytes,
  publishRawNote,
  wrapNoteHtml,
} from "../src/zotero/rawNoteAdapter";

class FakeNote {
  static saved: FakeNote[] = [];
  libraryID = 0;
  parentID = 0;
  html = "";
  tags: Array<{ tag: string; type?: number }> = [];
  saves = 0;
  setNote(html: string) { this.html = html; return true; }
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
  delete (globalThis as any).Zotero.BetterNotes;
});

describe("Raw note", () => {
  it("wraps the rendered HTML in the note-editor document", () => {
    expect(wrapNoteHtml("<p>x</p>")).toBe(
      '<div data-schema-version="9"><p>x</p></div>',
    );
  });

  it("measures the note in UTF-8 bytes, which is what Chinese text costs", () => {
    expect(noteBytes("ab")).toBe(2);
    expect(noteBytes("中文")).toBe(6);
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

  it("flags a note past the sync-size margin but still creates it", async () => {
    const big = "字".repeat(Math.ceil(NOTE_SOFT_LIMIT_BYTES / 3) + 10);
    const result = await publishRawNote(parentWith(), big, "skip", converter);

    expect(result.outcome).toBe("created");
    expect(result.oversize).toBe(true);
  });

  it("fails clearly when Better Notes is missing", () => {
    expect(() => betterNotesConverter()).toThrow(RawNoteUnavailableError);
    expect(() => betterNotesConverter()).toThrow(/Better Notes/);
  });

  it("uses Better Notes' converter when it is installed", async () => {
    (globalThis as any).Zotero.BetterNotes = {
      api: { convert: { md2html: async (md: string) => `<h1>${md}</h1>` } },
    };
    expect(await betterNotesConverter().md2html("T")).toBe("<h1>T</h1>");
  });
});

describe("Better Notes note link", () => {
  const libraries: Record<number, { libraryType: string }> = {
    1: { libraryType: "user" },
    5: { libraryType: "group" },
    9: { libraryType: "feed" },
  };
  const note = (libraryID: number): any => ({ libraryID, key: "IQQ6S4FN" });

  beforeEach(() => {
    (globalThis as any).Zotero.Libraries = { get: (id: number) => libraries[id] };
  });

  it("is absent without Better Notes", () => {
    expect(betterNotesNoteLink(note(1))).toBeUndefined();
  });

  it("uses u for the user library and the libraryID for a group", () => {
    (globalThis as any).Zotero.BetterNotes = {};
    expect(betterNotesNoteLink(note(1))).toBe("zotero://note/u/IQQ6S4FN/");
    expect(betterNotesNoteLink(note(5))).toBe("zotero://note/5/IQQ6S4FN/");
    expect(betterNotesNoteLink(note(9))).toBeUndefined();
  });
});
