import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The References OpenAlex path, reduced to the one question these tests ask: which
 * single-work lookups does it actually issue?
 *
 * localStorage is replaced by an in-memory tombstone store, and the HTTP layer by a
 * recorder, so a "load" is just a list of URLs. The real singletons both reach for
 * privileged globals on import, which is the other reason they are mocked.
 */
const tombstoneStore: { ids: Record<string, number> } = { ids: {} };

vi.mock("../src/modules/localStorage", () => ({
  localStorage: {
    readOpenAlexTombstones: async () => ({ ...tombstoneStore.ids }),
    writeOpenAlexTombstones: async (ids: Record<string, number>) => {
      tombstoneStore.ids = { ...ids };
    },
  },
}));

const responses = new Map<string, { status: number; body?: any }>();
const requested: string[] = [];

function respond(url: string): { status: number; body?: any } {
  requested.push(url);
  for (const [fragment, response] of responses) {
    if (url.includes(fragment)) { return response; }
  }
  return { status: 404 };
}

vi.mock("../src/modules/scholarlyHttp", () => ({
  MAILTO: "test@example.com",
  getJSON: async (url: string) => respond(url).body,
  getJSONResult: async (url: string) => respond(url),
  getSemanticScholarJSONStrict: async () => undefined,
  bareDOI: (value: string) => String(value || "").trim().toLowerCase(),
  bareOpenAlexID: (value: string) =>
    String(value || "").replace(/^https?:\/\/openalex\.org\//i, "").trim(),
  unInvertAbstract: () => undefined,
  composeText: () => "",
}));

vi.mock("../src/modules/openAlexCluster", () => ({
  resolveOpenAlexCluster: async () => [{ id: "W1", referencedCount: 3 }],
}));

import {
  fetchReferenceSource,
  resetOpenAlexTombstoneCache,
} from "../src/modules/referencesApi";

/** Single-work lookups only — the cluster, referenced_works, and batch calls aside. */
function singleLookups(): string[] {
  return requested
    .filter((url) => /\/works\/W\d+\?select=id,doi/.test(url))
    .map((url) => url.match(/\/works\/(W\d+)/)![1]);
}

beforeEach(() => {
  tombstoneStore.ids = {};
  responses.clear();
  requested.length = 0;
  resetOpenAlexTombstoneCache();
  // Three referenced works; the batch query returns only the first, so the other
  // two are chased individually and both 404.
  responses.set("select=referenced_works", {
    status: 200,
    body: { referenced_works: ["W10", "W20", "W30"] },
  });
  responses.set("works?filter=openalex:", {
    status: 200,
    body: { results: [{ id: "W10", display_name: "Present work" }] },
  });
});

describe("OpenAlex missing-work lookups", () => {
  it("records the works OpenAlex answers 404 for", async () => {
    await fetchReferenceSource("openAlex", "10.1000/example");

    expect(singleLookups()).toEqual(["W20", "W30"]);
    expect(Object.keys(tombstoneStore.ids).sort()).toEqual(["W20", "W30"]);
  });

  it("does not ask again about a work already answered 404", async () => {
    await fetchReferenceSource("openAlex", "10.1000/example");
    requested.length = 0;
    resetOpenAlexTombstoneCache();

    await fetchReferenceSource("openAlex", "10.1000/example");

    expect(singleLookups()).toEqual([]);
  });

  it("keeps asking about a work whose lookup never reached the API", async () => {
    // Status 0 is the transport failure the debug log showed alongside the 404s:
    // the question was never put, so it is not an answer worth remembering.
    responses.set("/works/W20?select=id,doi", { status: 0 });
    responses.set("/works/W30?select=id,doi", { status: 503 });

    await fetchReferenceSource("openAlex", "10.1000/example");

    expect(tombstoneStore.ids).toEqual({});
    requested.length = 0;
    resetOpenAlexTombstoneCache();
    await fetchReferenceSource("openAlex", "10.1000/example");
    expect(singleLookups()).toEqual(["W20", "W30"]);
  });

  it("asks again once a recorded 404 has expired", async () => {
    const expired = Date.now() - 31 * 24 * 60 * 60 * 1000;
    tombstoneStore.ids = { W20: expired, W30: Date.now() };

    await fetchReferenceSource("openAlex", "10.1000/example");

    expect(singleLookups()).toEqual(["W20"]);
  });
});
