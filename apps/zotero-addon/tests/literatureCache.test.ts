import {
  CITATIONS_NEGATIVE_CACHE_TTL_MS,
  cacheMatchesIdentifiers,
  citationsCacheIsUsable,
  identifiersGained,
  referencesCacheIsUsable,
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

  it("retries an empty lookup once the item gains an identifier", () => {
    expect(citationsCacheIsUsable(
      cache({ semanticScholarPaperId: undefined }),
      { ...identifiers, semanticScholarPaperId: "a".repeat(40) },
      10_500,
    )).toBe(false);
  });
});

describe("References cache usability", () => {
  const empty = {
    savedAt: 10_000,
    source: "none",
    doi: "",
    semanticScholarPaperId: undefined as string | undefined,
    resolved: true,
    references: [],
  };

  it("retries an empty lookup once the paper gains a DOI", () => {
    expect(referencesCacheIsUsable(empty, { doi: undefined })).toBe(true);
    expect(referencesCacheIsUsable(empty, { doi: "10.1000/example" }))
      .toBe(false);
  });

  it("keeps a completed empty lookup while no identifier has arrived", () => {
    expect(referencesCacheIsUsable(
      { ...empty, doi: "10.1000/example" },
      identifiers,
    )).toBe(true);
  });

  it("keeps a populated list when an identifier arrives", () => {
    expect(referencesCacheIsUsable(
      { ...empty, references: [{ title: "Cited paper" } as any] },
      { doi: "10.1000/example" },
    )).toBe(true);
  });

  it("discards a record whose identifier now names a different paper", () => {
    expect(referencesCacheIsUsable(
      { ...empty, doi: "10.1000/example", references: [{ title: "x" } as any] },
      { doi: "10.1000/other" },
    )).toBe(false);
  });

  it("treats a missing record as unusable", () => {
    expect(referencesCacheIsUsable(undefined, identifiers)).toBe(false);
  });
});

describe("Cache identity", () => {
  const saved = {
    doi: "10.1000/example",
    semanticScholarPaperId: undefined as string | undefined,
  };

  it("keeps a shard when enrichment adds an identifier it was saved without", () => {
    expect(cacheMatchesIdentifiers(saved, {
      doi: "10.1000/example",
      semanticScholarPaperId: "b".repeat(40),
    })).toBe(true);
  });

  it("keeps a shard when an identifier it was saved with is cleared", () => {
    expect(cacheMatchesIdentifiers(saved, { doi: undefined })).toBe(true);
  });

  it("discards a shard whose identifier now names a different paper", () => {
    expect(cacheMatchesIdentifiers(saved, { doi: "10.1000/other" })).toBe(false);
    expect(cacheMatchesIdentifiers(
      { ...saved, semanticScholarPaperId: "b".repeat(40) },
      { doi: "10.1000/example", semanticScholarPaperId: "c".repeat(40) },
    )).toBe(false);
  });

  it("ignores case and surrounding space in a DOI", () => {
    expect(cacheMatchesIdentifiers(saved, { doi: " 10.1000/EXAMPLE " }))
      .toBe(true);
  });

  it("reports an identifier gained since the save", () => {
    expect(identifiersGained(saved, {
      doi: "10.1000/example",
      semanticScholarPaperId: "b".repeat(40),
    })).toBe(true);
    expect(identifiersGained(saved, { doi: "10.1000/example" })).toBe(false);
  });
});
