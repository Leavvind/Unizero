/**
 * Fixture harness for UniConnection unit tests.
 *
 * Builds fake Zotero items and cache shards so the derived graph can be exercised
 * without a live Zotero. Test files must `vi.mock` the three side-effectful module
 * boundaries (localStorage / scholarlyHttp / itemIdentifiers) before importing this
 * file — see the header of each *.test.ts. The mocks make:
 *   - `readItemPaperIdentifiers(item)` return `item.__ids`
 *   - `bareDOI` a pure normaliser (so the real `edgeIdentity` runs)
 *   - `localStorage` an inert stub (its real singleton self-constructs on import)
 */

import { UniConnection } from "../src/modules/uniConnection";

export interface Ids {
  doi?: string;
  arxiv?: string;
  semanticScholarPaperId?: string;
}

let nextId = 1;

/** A stand-in for Zotero.Item carrying just what UniConnection reads. */
export function fakeItem(libraryID: number, key: string, ids: Ids = {}): any {
  return {
    libraryID,
    key,
    id: nextId++,
    __ids: ids,
    isRegularItem: () => true,
    deleted: false,
  };
}

/** A References-Resolved-v4 shard whose identity matches the item (so cacheMatchesItem passes). */
export function refCacheFor(item: any, edges: string[]): any {
  const ids: Ids = item.__ids || {};
  return {
    savedAt: 1,
    source: "test",
    doi: ids.doi || "",
    semanticScholarPaperId: ids.semanticScholarPaperId,
    resolved: true,
    references: edges.map((edge) => ({ edge, title: "" })),
  };
}

/** Direct-read cache backed by an in-memory map keyed by scoped identity. */
export class FakeCache {
  records = new Map<string, any>();
  async readRecordDirect(item: any, _key: string): Promise<any> {
    return this.records.get(`${item.libraryID}:${item.key}`);
  }
}

export interface Paper {
  item: any;
  edges: string[];
}

/** Point Zotero.Items.getAll at this fixture's items, scoped by library. */
export function installLibrary(items: any[]): void {
  const zotero = ((globalThis as any).Zotero = (globalThis as any).Zotero || {});
  zotero.Libraries = zotero.Libraries || { userLibraryID: 1 };
  zotero.Items = {
    getAll: (libraryID: number) => items.filter((item) => item.libraryID === libraryID),
  };
}

export function makeConnection(papers: Paper[]): { uc: UniConnection; cache: FakeCache } {
  installLibrary(papers.map((paper) => paper.item));
  const cache = new FakeCache();
  for (const paper of papers) {
    cache.records.set(
      `${paper.item.libraryID}:${paper.item.key}`,
      refCacheFor(paper.item, paper.edges),
    );
  }
  return { uc: new UniConnection(cache), cache };
}

export const scoped = (item: any): string => `${item.libraryID}:${item.key}`;

/**
 * Canonical 5-paper library (all in libraryID 1). Edges are endpoint keys.
 *
 *   A(doi:10/a) → B, C, [anon]      B(doi:10/b) → C, x
 *   C(doi:10/c) → x                 D(s2:dsha)  → B, x
 *   E()         → (no ids, no refs)
 *
 * where x = doi:10/x is an out-of-library endpoint. This exercises: cites within
 * the library (A→B/C, B→C, D→B), coupling through a shared out-of-library
 * reference (B/C/D all cite x), an anonymous edge (A's third ref), a non-DOI self
 * identity (D via S2), and a node with neither identity nor references (E).
 */
export function sampleLibrary() {
  const A = fakeItem(1, "A", { doi: "10/a" });
  const B = fakeItem(1, "B", { doi: "10/b" });
  const C = fakeItem(1, "C", { doi: "10/c" });
  const D = fakeItem(1, "D", { semanticScholarPaperId: "dsha" });
  const E = fakeItem(1, "E", {});
  const eb = "doi:10/b";
  const ec = "doi:10/c";
  const ex = "doi:10/x";
  const { uc, cache } = makeConnection([
    { item: A, edges: [eb, ec, ""] },
    { item: B, edges: [ec, ex] },
    { item: C, edges: [ex] },
    { item: D, edges: [eb, ex] },
    { item: E, edges: [] },
  ]);
  return { uc, cache, A, B, C, D, E };
}
