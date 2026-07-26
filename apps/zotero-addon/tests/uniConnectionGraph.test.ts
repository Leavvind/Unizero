import { describe, it, expect, vi } from "vitest";

// Same boundary mocks as uniConnection.test.ts (see helpers.ts header).
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

import { UniConnection } from "../src/modules/uniConnection";
import { refCacheFor, sampleLibrary } from "./helpers";

const idSet = (graph: any) => new Set(graph.nodes.map((node: any) => node.id));
const citePairs = (graph: any) =>
  graph.edges
    .filter((edge: any) => edge.type === "cites")
    .map((edge: any) => `${edge.source}->${edge.target}`)
    .sort();
const coupledDetail = (graph: any) =>
  graph.edges
    .filter((edge: any) => edge.type === "coupled")
    .map((edge: any) => `${[edge.source, edge.target].sort().join("|")}@${edge.weight}`)
    .sort();

describe("UniConnection.libraryGraph (whole-library overview)", () => {
  it("emits one node per library item, keyed by scoped identity", async () => {
    const { uc } = sampleLibrary();
    const graph = await (uc as any).libraryGraph(1);
    expect(graph.scope.libraryID).toBe(1);
    expect(idSet(graph)).toEqual(new Set(["1:A", "1:B", "1:C", "1:D", "1:E"]));
  });

  it("emits a directed cites edge exactly for each in-library reference", async () => {
    // A→B, A→C, B→C, D→B are the only reference endpoints owned by a library item;
    // the out-of-library doi:10/x must NOT produce a cites edge.
    const { uc } = sampleLibrary();
    const graph = await (uc as any).libraryGraph(1);
    expect(citePairs(graph)).toEqual(["1:A->1:B", "1:A->1:C", "1:B->1:C", "1:D->1:B"]);
    for (const edge of graph.edges) {
      expect(edge.source).not.toBe(edge.target); // no self loops
      if (edge.type === "cites") { expect(edge.directed).toBe(true); }
    }
  });

  it("weights coupling edges by shared-reference count", async () => {
    // A&D share B; A&B share C; B&C, B&D, C&D each share the out-of-library x.
    const { uc } = sampleLibrary();
    const graph = await (uc as any).libraryGraph(1);
    expect(coupledDetail(graph)).toEqual([
      "1:A|1:B@1",
      "1:A|1:D@1",
      "1:B|1:C@1",
      "1:B|1:D@1",
      "1:C|1:D@1",
    ]);
    for (const edge of graph.edges) {
      if (edge.type === "coupled") { expect(edge.directed).toBe(false); }
    }
  });

  it("skips super-hub references above the hub cap", async () => {
    const { uc } = sampleLibrary();
    const graph = await (uc as any).libraryGraph(1, { couplingHubCap: 1 });
    expect(coupledDetail(graph)).toEqual([]); // every shared ref has >1 citer
    expect(citePairs(graph)).toHaveLength(4); // cites edges are unaffected
  });

  it("filters coupling edges below the minimum weight", async () => {
    const { uc } = sampleLibrary();
    const graph = await (uc as any).libraryGraph(1, { couplingMinWeight: 2 });
    expect(coupledDetail(graph)).toEqual([]); // all coupling weights are 1
  });
  it("memoizes each option set independently", async () => {
    const { uc } = sampleLibrary();
    const first = await uc.libraryGraph(1);
    const second = await uc.libraryGraph(1);
    const filtered = await uc.libraryGraph(1, { couplingMinWeight: 2 });
    const filteredAgain = await uc.libraryGraph(1, { couplingMinWeight: 2 });

    expect(second).toBe(first);
    expect(filteredAgain).toBe(filtered);
    expect(filtered).not.toBe(first);
  });

  it("invalidates cached topology after ingest", async () => {
    const { uc, cache, A } = sampleLibrary();
    const first = await uc.libraryGraph(1);
    cache.records.set("1:A", refCacheFor(A, ["doi:10/b"]));

    await uc.ingestItem(A);
    const next = await uc.libraryGraph(1);

    expect(next).not.toBe(first);
    expect(citePairs(next)).toEqual(["1:A->1:B", "1:B->1:C", "1:D->1:B"]);
  });

  it("invalidates cached topology after scoped and numeric retract", async () => {
    const { uc, B, C } = sampleLibrary();
    const first = await uc.libraryGraph(1);
    uc.retract("1:B");
    const afterScoped = await uc.libraryGraph(1);
    expect(afterScoped).not.toBe(first);
    expect(idSet(afterScoped).has("1:B")).toBe(false);

    uc.retractItemID(C.id);
    const afterNumeric = await uc.libraryGraph(1);
    expect(afterNumeric).not.toBe(afterScoped);
    expect(idSet(afterNumeric).has("1:C")).toBe(false);
  });
});
