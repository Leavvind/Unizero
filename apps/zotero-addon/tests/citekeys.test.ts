/**
 * Citekey derivation and resolution.
 *
 * Covers the pure half of `src/server/citekeys.ts`. The index is exercised through
 * a stubbed `Zotero.Items.getAll`, because the properties worth testing — that a
 * pinned key wins, that a collision is reported rather than resolved, and that the
 * cache is dropped on change — are all decisions this module makes, not Zotero.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  citekeyForItem,
  deriveCitekey,
  invalidateCitekeyIndex,
  isValidCitekey,
  pinnedCitekey,
  resolveCitekey,
  suggestCitekeys,
} from "../src/server/citekeys";

interface FakeFields {
  title?: string;
  date?: string;
  extra?: string;
}

function fakeItem(
  libraryID: number,
  key: string,
  fields: FakeFields,
  creators: { lastName?: string; firstName?: string }[] = [],
): any {
  return {
    libraryID,
    key,
    isRegularItem: () => true,
    getField: (name: string) => (fields as Record<string, string>)[name] || "",
    getCreators: () => creators.map((creator) => ({
      lastName: creator.lastName || "",
      firstName: creator.firstName || "",
      creatorTypeID: 1,
    })),
  };
}

const library: Record<number, any[]> = {};

beforeEach(() => {
  invalidateCitekeyIndex();
  for (const key of Object.keys(library)) { delete library[Number(key)]; }

  (globalThis as any).Zotero.Libraries = {
    userLibraryID: 1,
    get: () => undefined,
    getAll: () => Object.keys(library).map((id) => ({ libraryID: Number(id) })),
  };
  (globalThis as any).Zotero.Items = {
    getAll: async (libraryID: number) => library[libraryID] || [],
    getByLibraryAndKey: (libraryID: number, itemKey: string) =>
      (library[libraryID] || []).find((item) => item.key === itemKey) || false,
  };
  (globalThis as any).Zotero.CreatorTypes = { getName: () => "author" };
});

describe("deriveCitekey", () => {
  it("joins first author, significant title words, and year", () => {
    const item = fakeItem(1, "AAA", {
      title: "Short and Long Horizon Behavioral Factors",
      date: "2020-05-01",
    }, [{ lastName: "Daniel" }]);
    expect(deriveCitekey(item)).toBe("danielShortLongHorizonBehavioral2020");
  });

  it("drops function words rather than counting them toward the title", () => {
    const item = fakeItem(1, "AAA", {
      title: "The Effect of a Policy on the Market",
      date: "2019",
    }, [{ lastName: "Smith" }]);
    expect(deriveCitekey(item)).toBe("smithEffectPolicyMarket2019");
  });

  it("folds diacritics instead of dropping the letters", () => {
    const item = fakeItem(1, "AAA", { title: "Über Netzwerke", date: "2021" },
      [{ lastName: "Müller" }]);
    expect(deriveCitekey(item)).toBe("mullerUberNetzwerke2021");
  });

  it("falls back to a name-free key when there is no author", () => {
    const item = fakeItem(1, "AAA", { title: "Untitled Report", date: "2018" });
    expect(deriveCitekey(item)).toBe("anonUntitledReport2018");
  });

  it("produces a usable key when the metadata is empty", () => {
    const item = fakeItem(1, "ABCD1234", {});
    const key = deriveCitekey(item);
    expect(isValidCitekey(key)).toBe(true);
  });

  it("omits a year the item does not have", () => {
    const item = fakeItem(1, "AAA", { title: "No Date Here" }, [{ lastName: "Lee" }]);
    expect(deriveCitekey(item)).toBe("leeNoDateHere");
  });
});

describe("pinnedCitekey", () => {
  it("reads the Extra line Better BibTeX and Zotero both write", () => {
    const item = fakeItem(1, "AAA", { extra: "Citation Key: pinned2020\nDOI: 10.1/x" });
    expect(pinnedCitekey(item)).toBe("pinned2020");
  });

  it("takes precedence over the derived key", () => {
    const item = fakeItem(1, "AAA", {
      title: "Something Else Entirely",
      date: "1999",
      extra: "Citation Key: pinned2020",
    }, [{ lastName: "Other" }]);
    expect(citekeyForItem(item)).toBe("pinned2020");
  });

  it("ignores a pinned key the inline syntax cannot express", () => {
    const item = fakeItem(1, "AAA", {
      title: "Fallback Title Here",
      date: "2020",
      extra: "Citation Key: smith.2020:a",
    }, [{ lastName: "Smith" }]);
    expect(pinnedCitekey(item)).toBeUndefined();
    expect(citekeyForItem(item)).toBe("smithFallbackTitleHere2020");
  });
});

describe("resolveCitekey", () => {
  it("finds an item by its derived key", async () => {
    library[1] = [fakeItem(1, "AAA", { title: "Deep Networks", date: "2020" },
      [{ lastName: "Lecun" }])];
    const resolved = await resolveCitekey("lecunDeepNetworks2020");
    expect(resolved).toMatchObject({ libraryID: 1, itemKey: "AAA", ambiguous: false });
  });

  it("reports a collision instead of picking one silently", async () => {
    library[1] = [
      fakeItem(1, "AAA", { title: "Deep Networks", date: "2020" }, [{ lastName: "Lecun" }]),
      fakeItem(1, "BBB", { title: "Deep Networks", date: "2020" }, [{ lastName: "Lecun" }]),
    ];
    const resolved = await resolveCitekey("lecunDeepNetworks2020");
    expect(resolved?.ambiguous).toBe(true);
    expect(resolved?.candidates.map((entry) => entry.itemKey)).toEqual(["AAA", "BBB"]);
  });

  it("prefers the caller's library when both hold the same key", async () => {
    library[1] = [fakeItem(1, "AAA", { title: "Shared Title", date: "2020" },
      [{ lastName: "Smith" }])];
    library[7] = [fakeItem(7, "GGG", { title: "Shared Title", date: "2020" },
      [{ lastName: "Smith" }])];

    expect((await resolveCitekey("smithSharedTitle2020"))?.libraryID).toBe(1);
    expect((await resolveCitekey("smithSharedTitle2020", 7))?.libraryID).toBe(7);
  });

  it("returns nothing for an unknown key", async () => {
    library[1] = [];
    expect(await resolveCitekey("nobodyHere2020")).toBeUndefined();
  });

  it("rejects a key the syntax cannot express without touching the library", async () => {
    const getAll = vi.fn(async () => []);
    (globalThis as any).Zotero.Items.getAll = getAll;
    expect(await resolveCitekey("smith.2020")).toBeUndefined();
    expect(getAll).not.toHaveBeenCalled();
  });

  it("skips non-regular items", async () => {
    const attachment = fakeItem(1, "ATT", { title: "Some PDF", date: "2020" },
      [{ lastName: "Smith" }]);
    attachment.isRegularItem = () => false;
    library[1] = [attachment];
    expect(await resolveCitekey("smithSomePdf2020")).toBeUndefined();
  });

  it("re-reads the library after invalidation", async () => {
    library[1] = [fakeItem(1, "AAA", { title: "First Title", date: "2020" },
      [{ lastName: "Smith" }])];
    expect(await resolveCitekey("smithFirstTitle2020")).toBeTruthy();

    library[1] = [fakeItem(1, "AAA", { title: "Second Title", date: "2020" },
      [{ lastName: "Smith" }])];
    expect(await resolveCitekey("smithSecondTitle2020")).toBeUndefined();

    invalidateCitekeyIndex();
    expect(await resolveCitekey("smithSecondTitle2020")).toBeTruthy();
    expect(await resolveCitekey("smithFirstTitle2020")).toBeUndefined();
  });
});

describe("suggestCitekeys", () => {
  beforeEach(() => {
    library[1] = [
      fakeItem(1, "AAA", { title: "Deep Networks", date: "2020" }, [{ lastName: "Lecun" }]),
      fakeItem(1, "BBB", { title: "Shallow Trees", date: "2018" }, [{ lastName: "Breiman" }]),
    ];
  });

  it("ranks a citekey prefix above a title match", async () => {
    const results = await suggestCitekeys("le", 10);
    expect(results[0].citekey).toBe("lecunDeepNetworks2020");
  });

  it("matches on the title when the citekey does not", async () => {
    const results = await suggestCitekeys("shallow", 10);
    expect(results.map((entry) => entry.itemKey)).toEqual(["BBB"]);
  });

  it("returns everything for an empty query", async () => {
    expect(await suggestCitekeys("", 10)).toHaveLength(2);
  });

  it("honours the limit", async () => {
    expect(await suggestCitekeys("", 1)).toHaveLength(1);
  });

  it("carries the fields a suggester renders", async () => {
    const [first] = await suggestCitekeys("lecun", 10);
    expect(first).toMatchObject({
      citekey: "lecunDeepNetworks2020",
      title: "Deep Networks",
      authors: ["Lecun"],
      year: "2020",
    });
  });
});
