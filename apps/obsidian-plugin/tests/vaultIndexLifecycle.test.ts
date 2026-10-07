import type { App, TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { VaultIndex } from "../src/vaultIndex";

const ref = { libraryID: 1, itemKey: "ABCD1234" };
const file = (path: string) => ({ path, extension: path.split(".").pop() } as TFile);

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("vault index lifecycle", () => {
  it("does not restore citations after deletion during a read", async () => {
    const request = deferred();
    const index = new VaultIndex({ vault: { cachedRead: () => request.promise } } as unknown as App);
    const note = file("Note.md");
    const reading = index.indexFile(note);
    index.removeFile(note.path);
    request.resolve("@1/ABCD1234");
    await reading;
    expect(index.getCount(ref)).toBe(0);
  });

  it("keeps the newest modification when reads finish out of order", async () => {
    const old = deferred();
    const fresh = deferred();
    let calls = 0;
    const index = new VaultIndex({ vault: {
      cachedRead: () => ++calls === 1 ? old.promise : fresh.promise,
    } } as unknown as App);
    const note = file("Note.md");
    const first = index.indexFile(note);
    const second = index.indexFile(note);
    fresh.resolve("No citations now");
    await second;
    old.resolve("@1/ABCD1234");
    await first;
    expect(index.getCount(ref)).toBe(0);
  });

  it("ignores reads and deferred initialization after disposal", async () => {
    const request = deferred();
    const index = new VaultIndex({ vault: { cachedRead: () => request.promise } } as unknown as App);
    const reading = index.indexFile(file("Note.md"));
    index.dispose();
    request.resolve("@1/ABCD1234");
    await reading;
    await index.initialize();
    expect(index.getCount(ref)).toBe(0);
  });

  it("moves folder descendants and removes them when the folder is deleted", async () => {
    const note = file("Notes/Sub/Note.md");
    const other = file("Notes Extra/Other.md");
    const index = new VaultIndex({ vault: {
      getFiles: () => [note, other], cachedRead: async () => "@1/ABCD1234",
    } } as unknown as App);
    await index.initialize();
    note.path = "Archive/Sub/Note.md";
    await index.renameFolder("Notes", "Archive");
    expect(index.getOccurrences(ref).map((occ) => occ.filePath).sort()).toEqual([
      "Archive/Sub/Note.md", "Notes Extra/Other.md",
    ]);
    index.removeFolder("Archive");
    expect(index.getOccurrences(ref).map((occ) => occ.filePath)).toEqual([other.path]);
  });

  it("drops citations when a file no longer has a supported extension", async () => {
    const note = file("Note.md");
    const index = new VaultIndex({ vault: { cachedRead: async () => "@1/ABCD1234" } } as unknown as App);
    await index.indexFile(note);
    note.path = "Note.txt";
    note.extension = "txt";
    await index.renameFile("Note.md", note);
    expect(index.getCount(ref)).toBe(0);
  });
});
