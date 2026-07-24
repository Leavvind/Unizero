import { describe, it, expect, vi } from "vitest";

// The three module boundaries that must be neutralised before the source graph is
// imported (see helpers.ts header for why each one).
vi.mock("../src/modules/localStorage", () => ({ localStorage: {} }));
vi.mock("../src/modules/scholarlyHttp", () => ({
  bareDOI: (value: string) =>
    String(value || "")
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .trim()
      .toLowerCase(),
}));
vi.mock("../src/modules/itemIdentifiers", () => ({
  readItemPaperIdentifiers: (item: any) => item.__ids || {},
}));

import {
  fakeItem,
  makeConnection,
  sampleLibrary,
  scoped,
} from "./helpers";

const keys = (hits: Array<{ scopedKey: string }>) => hits.map((hit) => hit.scopedKey);

describe("UniConnection.relationsOf (reverse citation, library-scoped)", () => {
  it("returns every library item whose references cite the paper", async () => {
    const { uc, B, C } = sampleLibrary();
    expect(keys(await uc.relationsOf(B))).toEqual(["1:A", "1:D"]);
    expect(keys(await uc.relationsOf(C))).toEqual(["1:A", "1:B"]);
  });

  it("is empty for a paper nobody in the library cites", async () => {
    const { uc, A } = sampleLibrary();
    expect(await uc.relationsOf(A)).toEqual([]);
  });

  it("is empty for a paper with no resolvable self identity", async () => {
    const { uc, E } = sampleLibrary();
    expect(await uc.relationsOf(E)).toEqual([]);
  });

  it("resolves a self identity that is only a Semantic Scholar id", async () => {
    // D is cited by nobody, but its S2-only identity must still index cleanly
    // rather than throw or collapse into another paper.
    const { uc, D } = sampleLibrary();
    expect(await uc.relationsOf(D)).toEqual([]);
  });
});

describe("UniConnection.coupledWith (bibliographic coupling)", () => {
  it("counts shared references, including out-of-library endpoints", async () => {
    // B shares doi:10/c with A, and the out-of-library doi:10/x with C and D. That
    // the out-of-library endpoint still couples B–C and B–D is the key invariant:
    // the index spans all edges, not only library members.
    const { uc, B } = sampleLibrary();
    expect(await uc.coupledWith(B)).toEqual([
      { scopedKey: "1:A", shared: 1 },
      { scopedKey: "1:C", shared: 1 },
      { scopedKey: "1:D", shared: 1 },
    ]);
  });

  it("never couples a paper with itself", async () => {
    const { uc, C } = sampleLibrary();
    const hits = await uc.coupledWith(C);
    expect(keys(hits)).not.toContain("1:C");
    expect(hits).toEqual([
      { scopedKey: "1:B", shared: 1 },
      { scopedKey: "1:D", shared: 1 },
    ]);
  });

  it("honours the limit", async () => {
    const { uc, B } = sampleLibrary();
    expect(await uc.coupledWith(B, 1)).toEqual([{ scopedKey: "1:A", shared: 1 }]);
  });
});

describe("UniConnection.stats (diagnostics)", () => {
  it("reports items, edges, skipped anonymous rows, and items-with-refs", async () => {
    const { uc, B } = sampleLibrary();
    await uc.relationsOf(B); // force the lazy build
    const stats = uc.stats(1);
    expect(stats.items).toBe(5); // A B C D E
    expect(stats.itemsWithRefs).toBe(4); // E has an empty reference list
    expect(stats.skippedAnon).toBe(1); // A's third (anonymous) reference
    expect(stats.edges).toBe(7); // forward sizes: A2 + B2 + C1 + D2
  });

  it("reports an empty index for a library that was never built", () => {
    const { uc } = sampleLibrary();
    expect(uc.stats(1)).toEqual({ items: 0, edges: 0, skippedAnon: 0, itemsWithRefs: 0 });
  });
});

describe("UniConnection.retract (ingest is exactly reversible)", () => {
  it("removes a citer's contribution and restores it on re-ingest", async () => {
    const { uc, A, B, C } = sampleLibrary();
    expect(keys(await uc.relationsOf(B))).toEqual(["1:A", "1:D"]);

    uc.retract(scoped(A));
    expect(keys(await uc.relationsOf(B))).toEqual(["1:D"]);
    expect(keys(await uc.relationsOf(C))).toEqual(["1:B"]);

    await uc.ingestItem(A);
    expect(keys(await uc.relationsOf(B))).toEqual(["1:A", "1:D"]);
  });

  it("leaves stats identical after retract + re-ingest of the same item", async () => {
    const { uc, A, B } = sampleLibrary();
    await uc.relationsOf(B);
    const before = uc.stats(1);

    uc.retract(scoped(A));
    await uc.ingestItem(A);

    expect(uc.stats(1)).toEqual(before);
  });

  it("retracts by numeric item id (delete after the item object is gone)", async () => {
    const { uc, A, B } = sampleLibrary();
    await uc.relationsOf(B); // build so the id → scoped map is populated
    expect(uc.retractItemID(A.id)).toBe(1);
    expect(keys(await uc.relationsOf(B))).toEqual(["1:D"]);
  });
});

describe("UniConnection multi-library isolation", () => {
  it("keeps per-library indexes separate even when two libraries share a DOI", async () => {
    const A = fakeItem(1, "A", { doi: "10/a" });
    const B = fakeItem(1, "B", { doi: "10/b" });
    const F = fakeItem(2, "F", { doi: "10/f" }); // group library, cites doi:10/b
    const G = fakeItem(2, "G", { doi: "10/b" }); // group paper sharing B's DOI
    const { uc } = makeConnection([
      { item: A, edges: ["doi:10/b"] },
      { item: B, edges: [] },
      { item: F, edges: ["doi:10/b"] },
      { item: G, edges: [] },
    ]);

    // B (lib 1) is cited only by A — never by F, which lives in library 2.
    expect(keys(await uc.relationsOf(B))).toEqual(["1:A"]);
    // G (lib 2) shares B's DOI but resolves against its own index: cited by F only.
    expect(keys(await uc.relationsOf(G))).toEqual(["2:F"]);
  });
});
