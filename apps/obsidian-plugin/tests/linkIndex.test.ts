import { describe, expect, it, vi } from "vitest";
import { LinkIndex, type SourceDocument } from "../src/linkIndex";

const source = (path: string): SourceDocument => ({ kind: "vault", path, title: path, vaultID: "vault", format: "md" });
const target = { kind: "paper" as const, libraryID: 1, itemKey: "ABCD1234", action: "detail" as const };
const link = "[paper](unizero://paper/1/ABCD1234)";

describe("incoming link index", () => {
  it("looks up only the requested target and retains duplicate occurrences", () => {
    const index = new LinkIndex();
    index.replace(source("a.md"), `${link} ${link}`);
    index.replace(source("b.md"), "[pdf](unizero://paper/1/ABCD1234.pdf?page=2)");
    index.replace(source("other.md"), "[paper](unizero://paper/2/ABCD1234)");
    const walk = vi.spyOn(index.records, "values").mockImplementation(() => { throw new Error("full scan"); });
    expect(index.query(target)).toHaveLength(3);
    expect(index.query({ ...target, libraryID: 3 })).toEqual([]);
    walk.mockRestore();
  });

  it("updates replacement, stale and removal buckets without retaining old occurrences", () => {
    const index = new LinkIndex(), a = source("a.md"), b = source("b.md");
    index.replace(a, `${link} ${link}`); index.replace(b, link);
    index.stale(a, "offline");
    expect(index.query(target).filter((entry) => entry.stale)).toHaveLength(2);
    index.replace(a, "[note](unizero://note/vault/123)");
    expect(index.query(target).map((entry) => entry.source)).toEqual([b]);
    index.remove("vault:b.md");
    expect(index.query(target)).toEqual([]);
    expect(index.query({ kind: "note", vaultID: "vault", uid: "123" })).toHaveLength(1);
    index.dispose();
    expect(index.query({ kind: "note", vaultID: "vault", uid: "123" })).toEqual([]);
    index.replace(a, link);
    expect(index.records.size).toBe(0);
  });
});
