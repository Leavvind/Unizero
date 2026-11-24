import { describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/localStorage", () => ({ localStorage: {} }));
vi.mock("../src/modules/scholarlyHttp", () => ({
  bareDOI: (value: string) => String(value || "").trim().toLowerCase(),
}));
vi.mock("../src/modules/itemIdentifiers", () => ({
  readItemPaperIdentifiers: (item: any) => item.__ids || {},
}));

import { addExcerptToNote, EXCERPT_NOTE_TAG, type ExcerptInput } from "../src/zotero/excerptNoteFormat";
import { sampleLibrary } from "./helpers";

const input = (annotationKey: string, text: string): ExcerptInput => ({
  annotationKey,
  attachmentURI: "http://zotero.org/users/local/abcd/items/PDFA0001",
  citingItemURI: "http://zotero.org/users/local/abcd/items/A",
  text,
  pageLabel: "7",
  citationLabel: "A, 2020, p. 7",
});

/** A's note: B (already in A's provider References) and E (identity-less, not in them). */
function noteHTML(sections: Array<[string, string[]]>, scope = "library"): string {
  let html = "";
  for (const [itemKey, keys] of sections) {
    for (const key of keys) {
      html = addExcerptToNote(html, { scope, itemKey }, itemKey, input(key, `${key} text`));
    }
  }
  return html;
}

function fakeNote(id: number, parent: any, html: string, tagged = true): any {
  return {
    id,
    libraryID: parent.libraryID,
    key: `NOTE${id}`,
    deleted: false,
    parentItem: parent,
    isNote: () => true,
    isRegularItem: () => false,
    getTags: () => (tagged ? [{ tag: EXCERPT_NOTE_TAG, type: 1 }] : []),
    getNote: () => html,
  };
}

const keys = (hits: Array<{ scopedKey: string }>) => hits.map((hit) => hit.scopedKey);

describe("UniConnection excerpt layer", () => {
  function library() {
    const fixture = sampleLibrary();
    fixture.excerpts.records.push({
      noteID: 900,
      libraryID: 1,
      scope: "library",
      citingKey: "A",
      html: noteHTML([["B", ["K1", "K2"]], ["E", ["K3"]], ["GONE", ["K4"]]]),
    });
    return fixture;
  }

  it("lists A's passages per cited paper in note order, flagging papers not in the library", async () => {
    const { uc, A } = library();
    const groups = await uc.excerptsFrom(A);
    expect(groups.map((group) => [group.scopedKey, group.missing, group.excerpts.map((e) => e.annotationKey)]))
      .toEqual([["1:B", false, ["K1", "K2"]], ["1:E", false, ["K3"]], ["1:GONE", true, ["K4"]]]);
    expect(groups[0].excerpts[0]).toMatchObject({ text: "K1 text", pageLabel: "7", attachmentKey: "PDFA0001" });
  });

  it("answers who quotes a paper, and counts that as citing it in relationsOf", async () => {
    const { uc, B, E } = library();
    expect((await uc.excerptsAbout(E)).map((group) => [group.scopedKey, group.excerpts.length]))
      .toEqual([["1:A", 1]]);
    // E has no identifiers, so no provider edge can ever reach it; the excerpt does.
    expect(keys(await uc.relationsOf(E))).toEqual(["1:A"]);
    // B was already cited by A and D through References; the excerpt adds no duplicate.
    expect(keys(await uc.relationsOf(B))).toEqual(["1:A", "1:D"]);
  });

  it("lists no group for a heading whose highlights are all gone, but still counts the citer", async () => {
    const { uc, excerpts, A, E } = sampleLibrary();
    excerpts.records.push({
      noteID: 903, libraryID: 1, scope: "library", citingKey: "A",
      html: noteHTML([["B", ["K1"]]]).replace("</div>",
        '<h2><a href="zotero://select/library/items/E">E</a></h2>\n<p>Only my own remark.</p>\n</div>'),
    });
    expect((await uc.excerptsFrom(A)).map((group) => group.scopedKey)).toEqual(["1:B"]);
    expect(await uc.excerptsAbout(E)).toEqual([]);
    expect(keys(await uc.relationsOf(E))).toEqual(["1:A"]);
  });

  it("ignores sections that point into another library", async () => {
    const { uc, excerpts, C } = sampleLibrary();
    excerpts.records.push({
      noteID: 901, libraryID: 1, scope: "library", citingKey: "D",
      html: noteHTML([["C", ["K9"]]], "groups/5"),
    });
    expect(await uc.excerptsAbout(C)).toEqual([]);
  });

  it("re-reads an edited note and retracts one that loses its tag", async () => {
    const { uc, A, E } = sampleLibrary();
    await uc.build(1);
    await uc.ingestExcerptNote(fakeNote(902, A, noteHTML([["E", ["K1"]]])));
    expect(keys(await uc.relationsOf(E))).toEqual(["1:A"]);

    await uc.ingestExcerptNote(fakeNote(902, A, noteHTML([["B", ["K1"]]])));
    expect(await uc.excerptsAbout(E)).toEqual([]);
    expect(keys(await uc.relationsOf(E))).toEqual([]);

    await uc.ingestExcerptNote(fakeNote(902, A, noteHTML([["E", ["K1"]]]), false));
    expect(await uc.excerptsFrom(A)).toEqual([]);
  });

  it("drops a deleted note by ID and leaves an unbuilt library alone", async () => {
    const { uc, A, E } = sampleLibrary();
    expect(await uc.ingestExcerptNote(fakeNote(903, A, noteHTML([["E", ["K1"]]])), false)).toBe(false);
    await uc.build(1);
    await uc.ingestExcerptNote(fakeNote(903, A, noteHTML([["E", ["K1"]]])));
    uc.retractExcerptNote(903);
    expect(await uc.excerptsAbout(E)).toEqual([]);
  });

  it("hides a trashed citing paper's passages and restores them with the paper", async () => {
    const { uc, A, E } = library();
    expect(keys(await uc.excerptsAbout(E))).toEqual(["1:A"]);
    uc.retract("1:A");
    expect(await uc.excerptsAbout(E)).toEqual([]);
    expect(keys(await uc.relationsOf(E))).toEqual([]);
    // Restoring the item re-indexes it; its note was never discarded.
    await uc.ingestItem(A, false);
    expect(keys(await uc.excerptsAbout(E))).toEqual(["1:A"]);
  });
});
