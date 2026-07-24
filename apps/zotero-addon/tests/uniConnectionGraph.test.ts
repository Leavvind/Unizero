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
import { sampleLibrary } from "./helpers";

/**
 * Phase 4 graph builders (docs/UNICONNECTION_GRAPH.md §5, §10).
 *
 * Guarded by feature detection so this file also serves as the acceptance net
 * before the methods exist: if a builder is missing the specs report as `todo`
 * instead of failing.
 */
const probe = new UniConnection() as any;
const itLibrary = typeof probe.libraryGraph === "function" ? it : it.todo;
const itEgo = typeof probe.egoGraph === "function" ? it : it.todo;

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
  itLibrary("emits one node per library item, keyed by scoped identity", async () => {
    const { uc } = sampleLibrary();
    const graph = await (uc as any).libraryGraph(1);
    expect(graph.scope.libraryID).toBe(1);
    expect(idSet(graph)).toEqual(new Set(["1:A", "1:B", "1:C", "1:D", "1:E"]));
  });

  itLibrary("emits a directed cites edge exactly for each in-library reference", async () => {
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

  itLibrary("weights coupling edges by shared-reference count", async () => {
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

  itLibrary("skips super-hub references above the hub cap", async () => {
    const { uc } = sampleLibrary();
    const graph = await (uc as any).libraryGraph(1, { couplingHubCap: 1 });
    expect(coupledDetail(graph)).toEqual([]); // every shared ref has >1 citer
    expect(citePairs(graph)).toHaveLength(4); // cites edges are unaffected
  });

  itLibrary("filters coupling edges below the minimum weight", async () => {
    const { uc } = sampleLibrary();
    const graph = await (uc as any).libraryGraph(1, { couplingMinWeight: 2 });
    expect(coupledDetail(graph)).toEqual([]); // all coupling weights are 1
  });
});

describe("UniConnection.egoGraph (single-paper neighbourhood, in-library only)", () => {
  itEgo("centres on the paper and includes citers, citations, and coupled peers", async () => {
    // Around B: citers A, D; B cites C; coupled with A, C, D → nodes {A,B,C,D}.
    const { uc, B } = sampleLibrary();
    const graph = await (uc as any).egoGraph(B);
    expect(graph.center).toBe("1:B");
    expect(idSet(graph)).toEqual(new Set(["1:A", "1:B", "1:C", "1:D"]));
    const center = graph.nodes.find((node: any) => node.id === "1:B");
    expect(center.isCenter).toBe(true);
    expect(citePairs(graph)).toEqual(
      expect.arrayContaining(["1:A->1:B", "1:D->1:B", "1:B->1:C"]),
    );
  });

  itEgo("excludes out-of-library ghost nodes in this phase", async () => {
    const { uc, B } = sampleLibrary();
    const graph = await (uc as any).egoGraph(B);
    const inLibrary = ["1:A", "1:B", "1:C", "1:D", "1:E"];
    expect(graph.nodes.every((node: any) => inLibrary.includes(node.id))).toBe(true);
  });

  itEgo("drops coupled peers at couplingLimit 0 without losing cites neighbours", async () => {
    const { uc, B } = sampleLibrary();
    const graph = await (uc as any).egoGraph(B, { couplingLimit: 0 });
    expect(coupledDetail(graph)).toEqual([]);
    // A, D (citers) and C (cited) survive because they are cites-derived, not coupled.
    expect(idSet(graph)).toEqual(new Set(["1:A", "1:B", "1:C", "1:D"]));
    expect(citePairs(graph)).toEqual(["1:A->1:B", "1:B->1:C", "1:D->1:B"]);
  });
});
