import { describe, expect, it, vi } from "vitest";
import { MentionScanner, MENTION_CONCURRENCY } from "../src/mentionScanner";

const source = (path: string) => ({ path, stat: { mtime: 1, size: 20 } });
const deferred = () => {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("mention scanning", () => {
  it("starts only four reads in a 2000-note vault and stops superseded work", async () => {
    const scanner = new MentionScanner(), pending = deferred();
    const read = vi.fn(() => pending.promise);
    let current = true;
    const scan = scanner.scan(Array.from({ length: 2000 }, (_, i) => source(`${i}.md`)), ["Paper"], read, () => current);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(MENTION_CONCURRENCY));
    current = false; pending.resolve("Paper");
    expect(await scan).toEqual([]);
    expect(read).toHaveBeenCalledTimes(MENTION_CONCURRENCY);
  });

  it("shares in-flight source reads when switching target terms", async () => {
    const scanner = new MentionScanner(), pending = deferred(), files = [source("a.md"), source("b.md")];
    const read = vi.fn(() => pending.promise);
    let firstCurrent = true;
    const first = scanner.scan(files, ["Old"], read, () => firstCurrent);
    firstCurrent = false;
    const second = scanner.scan(files, ["New"], read, () => true);
    pending.resolve("Old New");
    expect(await first).toEqual([]);
    const result = await second;
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.map((group) => group.mentions[0].text)).toEqual(["New", "New"]);
    await scanner.scan(files, ["New"], read, () => true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bounds reads across overlapping scans with different sources", async () => {
    const scanner = new MentionScanner(), pending = deferred();
    const read = vi.fn(() => pending.promise);
    let current = true;
    const first = scanner.scan(Array.from({ length: 4 }, (_, i) => source(`a${i}.md`)), ["Paper"], read, () => current);
    const second = scanner.scan(Array.from({ length: 4 }, (_, i) => source(`b${i}.md`)), ["Paper"], read, () => current);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    current = false; pending.resolve("Paper");
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("does not share changed versions or let old reads overwrite fresh results", async () => {
    const scanner = new MentionScanner(), old = deferred(), file = source("a.md");
    const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue("New Paper");
    const first = scanner.scan([file], ["Paper"], read, () => true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    file.stat.size++;
    const second = await scanner.scan([file], ["Paper"], read, () => true);
    expect(second[0].mentions[0].lineText).toBe("New Paper");
    old.resolve("Old Paper"); expect(await first).toEqual([]);
    expect((await scanner.scan([file], ["Paper"], read, () => true))[0].mentions[0].lineText).toBe("New Paper");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("scans subsequent batches, caches unchanged results and retries failures", async () => {
    const scanner = new MentionScanner(), files = Array.from({ length: 9 }, (_, i) => source(`${i}.md`));
    const read = vi.fn(async () => "Paper [Paper](link) `Paper`");
    const found = await scanner.scan(files, ["Paper"], read, () => true);
    expect(found).toHaveLength(9); expect(found.every((group) => group.mentions.length === 1)).toBe(true);
    await scanner.scan(files, ["Paper"], read, () => true);
    expect(read).toHaveBeenCalledTimes(9);
    files[0].stat.mtime++;
    read.mockRejectedValueOnce(new Error("offline"));
    await expect(scanner.scan(files, ["Paper"], read, () => true)).rejects.toThrow("offline");
    expect(await scanner.scan(files, ["Paper"], read, () => true)).toHaveLength(9);
    expect(read).toHaveBeenCalledTimes(11);
  });

  it("cancels on close and discards cache entries even when reads finish later", async () => {
    const scanner = new MentionScanner(), pending = deferred(), files = [source("a.md")];
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue("New Paper");
    const scan = scanner.scan(files, ["Paper"], read, () => true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    scanner.clear(); pending.resolve("Old Paper");
    expect(await scan).toEqual([]);
    expect((await scanner.scan(files, ["Paper"], read, () => true))[0].mentions[0].lineText).toBe("New Paper");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
