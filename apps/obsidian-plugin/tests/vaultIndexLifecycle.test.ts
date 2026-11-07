import type { App, TFile } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultIndex } from "../src/vaultIndex";

const ref = { libraryID: 1, itemKey: "ABCD1234" };
const file = (path: string) => ({ path, extension: path.split(".").pop() } as TFile);

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("vault index lifecycle", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("coalesces rapid modifications per file and cancels pending work on deletion/disposal", async () => {
    vi.useFakeTimers();
    const cachedRead = vi.fn().mockResolvedValue("[a](unizero://paper/1/ABCD1234)");
    const index = new VaultIndex({ vault: { cachedRead } } as unknown as App);
    const a = file("a.md"), b = file("b.md");
    for (let i = 0; i < 20; i++) { index.scheduleFile(a); }
    index.scheduleFile(b);
    await vi.advanceTimersByTimeAsync(199);
    expect(cachedRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cachedRead).toHaveBeenCalledTimes(2);
    expect(index.getCount(ref)).toBe(2);
    index.scheduleFile(a);
    index.removeFile(a.path);
    index.scheduleFile(b);
    index.dispose();
    await vi.runAllTimersAsync();
    expect(cachedRead).toHaveBeenCalledTimes(2);
  });
  it("invalidates an in-flight read as soon as a modification is scheduled", async () => {
    vi.useFakeTimers();
    const request = deferred();
    const cachedRead = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValue("plain");
    const index = new VaultIndex({ vault: { cachedRead } } as unknown as App);
    const note = file("Note.md");
    const pending = index.indexFile(note);
    index.scheduleFile(note);
    request.resolve("[a](unizero://paper/1/ABCD1234)");
    await pending;
    expect(index.getCount(ref)).toBe(0);
    await vi.runAllTimersAsync();
    expect(index.getCount(ref)).toBe(0);
  });
  it("does not publish a background parse after its file is deleted", async () => {
    const index = new VaultIndex({ vault: { cachedRead: async () => "text" } } as unknown as App);
    let finish!: (links: any[]) => void;
    const parse = vi.spyOn((index as any).scanner, "scan").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const note = file("Note.md");
    const pending = index.indexFile(note);
    await Promise.resolve();
    expect(parse).toHaveBeenCalledTimes(1);
    index.removeFile(note.path);
    finish([]);
    await pending;
    expect(index.links.records.has("vault:Note.md")).toBe(false);
  });
  it("retains stale links and partial coverage when a rebuild cannot read a source", async () => {
    const note = file("Note.md");
    const index = new VaultIndex({ vault: { getFiles: () => [note], cachedRead: async () => { throw new Error("offline file"); } } } as unknown as App);
    index.indexFileContent(note, "[a](unizero://paper/1/ABCD1234)");
    await index.initialize();
    expect(index.getCount(ref)).toBe(1);
    expect(index.links.vaultState).toBe("partial");
    expect(index.links.query({ kind: "paper", ...ref, action: "detail" })[0].stale).toBe(true);
  });
  it("refreshes only changed files and notifies once for a whole pass", async () => {
    const stamped = (path: string) => ({ ...file(path), stat: { mtime: 1, size: 1 } } as TFile);
    const a = stamped("a.md"), b = stamped("b.md");
    let reads = 0;
    const index = new VaultIndex({ vault: { getFiles: () => [a, b], cachedRead: async () => { reads += 1; return "[a](unizero://paper/1/ABCD1234)"; } } } as unknown as App);
    let notified = 0; index.links.subscribe(() => { notified += 1; });
    await index.initialize();
    expect(reads).toBe(2); expect(notified).toBe(2); // Updating, then complete.
    await index.initialize({ changedOnly: true });
    expect(reads).toBe(2);
    a.stat.mtime = 2;
    await index.initialize({ changedOnly: true });
    expect(reads).toBe(3);
    await index.initialize();
    expect(reads).toBe(5);
    expect(index.links.vaultState).toBe("complete");
  });
  it("does not restore citations after deletion during a read", async () => {
    const request = deferred();
    const index = new VaultIndex({ vault: { cachedRead: () => request.promise } } as unknown as App);
    const note = file("Note.md");
    const reading = index.indexFile(note);
    index.removeFile(note.path);
    request.resolve("[a](unizero://paper/1/ABCD1234)");
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
    old.resolve("[a](unizero://paper/1/ABCD1234)");
    await first;
    expect(index.getCount(ref)).toBe(0);
  });

  it("ignores reads and deferred initialization after disposal", async () => {
    const request = deferred();
    const index = new VaultIndex({ vault: { cachedRead: () => request.promise } } as unknown as App);
    const reading = index.indexFile(file("Note.md"));
    index.dispose();
    request.resolve("[a](unizero://paper/1/ABCD1234)");
    await reading;
    await index.initialize();
    expect(index.getCount(ref)).toBe(0);
  });

  it("moves folder descendants and removes them when the folder is deleted", async () => {
    const note = file("Notes/Sub/Note.md");
    const other = file("Notes Extra/Other.md");
    const index = new VaultIndex({ vault: {
      getFiles: () => [note, other], cachedRead: async () => "[a](unizero://paper/1/ABCD1234)",
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
    const index = new VaultIndex({ vault: { cachedRead: async () => "[a](unizero://paper/1/ABCD1234)" } } as unknown as App);
    await index.indexFile(note);
    note.path = "Note.txt";
    note.extension = "txt";
    await index.renameFile("Note.md", note);
    expect(index.getCount(ref)).toBe(0);
  });
});

describe("vault index notifications", () => {
  it("commits a thousand folder moves or deletions with one notification per subscriber", async () => {
    const files = Array.from({ length: 1000 }, (_, i) => file(`Notes/${i}.md`));
    const text = "[note](unizero://note/vault/123)";
    const vault = new VaultIndex({ vault: { getFiles: () => files, cachedRead: async () => text } } as unknown as App);
    for (const note of files) { vault.indexFileContent(note, text, false); }
    const links = vi.fn(), badges = vi.fn();
    vault.links.subscribe(links); vault.subscribe(badges);
    for (const note of files) { note.path = note.path.replace("Notes/", "Archive/"); }
    await vault.renameFolder("Notes", "Archive");
    const target = { kind: "note" as const, vaultID: "vault", uid: "123" };
    expect(vault.links.query(target)).toHaveLength(1000);
    expect(vault.links.query(target).every((entry) => entry.source.kind === "vault" && entry.source.path.startsWith("Archive/"))).toBe(true);
    expect(links).toHaveBeenCalledTimes(1); expect(badges).toHaveBeenCalledTimes(1);
    vault.removeFolder("Archive");
    expect(vault.links.query(target)).toEqual([]);
    expect(links).toHaveBeenCalledTimes(2); expect(badges).toHaveBeenCalledTimes(2);
    vault.dispose();
  });

  it("silences individual removals in a batch and clears reverse links on rebuild", () => {
    const vault = new VaultIndex({} as App), links = vi.fn();
    vault.indexFileContent(file("a.md"), "[a](unizero://paper/1/ABCD1234)");
    vault.indexFileContent(file("b.md"), "[a](unizero://paper/1/ABCD1234)");
    vault.links.subscribe(links);
    vault.removeFile("a.md", false);
    expect(links).not.toHaveBeenCalled();
    expect(vault.links.query({ kind: "paper", ...ref, action: "detail" })).toHaveLength(1);
    vault.clear();
    expect(vault.links.query({ kind: "paper", ...ref, action: "detail" })).toEqual([]);
  });

  function index() {
    const vault = new VaultIndex({} as App);
    let notified = 0;
    vault.subscribe(() => { notified += 1; });
    return { vault, notified: () => notified };
  }

  it("stays quiet when an edit leaves the citations unchanged", () => {
    const { vault, notified } = index();
    vault.indexFileContent(file("a.md"), "x [a](unizero://paper/1/ABCD1234)\nplain");
    expect(notified()).toBe(1);

    vault.indexFileContent(file("a.md"), "x [a](unizero://paper/1/ABCD1234)\nplain, edited");
    vault.indexFileContent(file("b.md"), "no citations here");
    vault.removeFile("c.md");
    expect(notified()).toBe(1);
    expect(vault.getCount(ref)).toBe(1);
  });

  it("updates one file's share without touching the others", () => {
    const { vault, notified } = index();
    vault.indexFileContent(file("a.md"), "[a](unizero://paper/1/ABCD1234) [a](unizero://paper/1/ABCD1234)");
    vault.indexFileContent(file("b.canvas"), JSON.stringify({
      nodes: [{ id: "n", type: "text", text: "[a](unizero://paper/1/ABCD1234)" }],
    }));
    expect(vault.getCount(ref)).toBe(3);

    vault.indexFileContent(file("a.md"), "[a](unizero://paper/1/ABCD1234)");
    expect(vault.getCount(ref)).toBe(2);
    expect(vault.getOccurrences(ref).map((o) => o.filePath).sort()).toEqual(["a.md", "b.canvas"]);

    vault.removeFile("b.canvas");
    expect(vault.getOccurrences(ref).map((o) => o.filePath)).toEqual(["a.md"]);
    expect(notified()).toBe(4);
  });
});
