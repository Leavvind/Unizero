import {
  CITATIONS_NEGATIVE_CACHE_TTL_MS,
  citationsCacheIsUsable,
} from "../src/modules/literatureCache";

function cache(overrides: Record<string, unknown> = {}) {
  return {
    savedAt: 10_000,
    doi: "10.1000/example",
    source: "none",
    page: 1,
    loaded: 0,
    total: 0,
    all: [],
    perSource: [{
      key: "openAlex",
      name: "OpenAlex",
      entries: [],
      total: 0,
      status: "empty",
      page: 0,
      hasMore: false,
    }],
    ...overrides,
  } as any;
}

const identifiers = {
  doi: "10.1000/example",
  semanticScholarPaperId: undefined,
};

describe("Citations negative cache", () => {
  it("accepts a recent completed empty lookup", () => {
    expect(citationsCacheIsUsable(cache(), identifiers, 10_500)).toBe(true);
  });

  it("expires an empty lookup after the bounded negative-cache TTL", () => {
    expect(citationsCacheIsUsable(
      cache(),
      identifiers,
      10_000 + CITATIONS_NEGATIVE_CACHE_TTL_MS + 1,
    )).toBe(false);
  });

  it("does not turn an all-provider failure into a zero-citation cache", () => {
    expect(citationsCacheIsUsable(cache({
      perSource: [{
        key: "openAlex",
        name: "OpenAlex",
        entries: [],
        total: 0,
        status: "error: timeout",
        page: 0,
        hasMore: false,
      }],
    }), identifiers, 10_500)).toBe(false);
  });

  it("keeps positive citation caches without applying the negative TTL", () => {
    expect(citationsCacheIsUsable(cache({
      savedAt: 1,
      loaded: 1,
      total: 1,
      all: [{ title: "Citing paper" }],
      perSource: undefined,
    }), identifiers, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
