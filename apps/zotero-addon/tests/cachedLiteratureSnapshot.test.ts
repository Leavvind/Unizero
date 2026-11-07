import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/modules/localStorage", () => ({ localStorage: { load: vi.fn(), get: vi.fn(), set: vi.fn() } }));
vi.mock("../src/utils/locale", () => ({ initLocale: vi.fn(), getString: vi.fn() }));
vi.mock("../src/modules/utils", () => ({ default: class {} }));
vi.mock("../src/modules/tip", () => ({ default: class {} }));
vi.mock("../src/modules/status", () => ({ PanelStatus: class {} }));
vi.mock("../src/modules/referencesApi", () => ({ fetchReferencesByIdentifiers: vi.fn(), referencesDiagnostics: {} }));
vi.mock("../src/modules/citationsApi", () => ({ fetchCitationsByIdentifiers: vi.fn(), citationsDiagnostics: {} }));
vi.mock("../src/modules/resolve", () => ({ resolveMany: vi.fn() }));
vi.mock("../src/modules/zomReferences", () => ({ readZoMinerReferences: vi.fn() }));
vi.mock("../src/modules/uniConnection", () => ({ uniConnection: { ingestItem: vi.fn(), relationsOf: vi.fn().mockResolvedValue([]), coupledWith: vi.fn().mockResolvedValue([]) } }));
vi.mock("../src/projects/paperCatalog", () => ({ recordCatalogDiscoverySnapshot: vi.fn(), recordCatalogExternalDiscoverySnapshot: vi.fn() }));
vi.mock("../src/zotero/literatureItemAdapter", () => ({}));
vi.mock("../src/features/conversion/commands", () => ({}));
vi.mock("../src/runtime-client/client", () => ({}));
vi.mock("../src/runtime-client/process", () => ({}));
vi.mock("../src/zotero/artifactActions", () => ({}));
vi.mock("../src/zotero/canvasAdapter", () => ({}));
vi.mock("../src/server/citekeys", () => ({ libraryItem: vi.fn(), citekeyForItem: () => "seed",
  registerCitekeyInvalidation: vi.fn(), unregisterCitekeyInvalidation: vi.fn() }));

import Views from "../src/modules/views";
import { localStorage } from "../src/modules/localStorage";
import { CACHE_KEY_REFERENCES, CACHE_KEY_CITATIONS } from "../src/modules/literatureCache";
import { fetchReferencesByIdentifiers } from "../src/modules/referencesApi";
import { fetchCitationsByIdentifiers } from "../src/modules/citationsApi";
import { resolveMany } from "../src/modules/resolve";
import { readZoMinerReferences } from "../src/modules/zomReferences";
import { recordCatalogDiscoverySnapshot } from "../src/projects/paperCatalog";
import { invalidateLibraryMembership } from "../src/modules/literatureRelations";
import { registerBridgeEndpoints, unregisterBridgeEndpoints } from "../src/server/bridge";
import { libraryItem } from "../src/server/citekeys";
import { config } from "../package.json";
import { SESSION_CACHE_CAPACITY } from "../src/modules/sessionCache";

const item = { libraryID: 2, key: "SUBJECT", getField: (field: string) => field === "DOI" ? "10.1000/seed" : "", getCreators: () => [] } as unknown as Zotero.Item;
const entry = { title: "10.1000/target", authors: [], identifiers: { DOI: "10.1000/target" } };
const state = (extra = {}) => ({ savedAt: Date.now(), doi: "10.1000/seed", source: "Crossref", resolved: false, references: [entry], ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  (Zotero as any).Prefs = { get: () => true };
  (Zotero as any).Items.getAll = () => [];
  invalidateLibraryMembership();
});
afterEach(() => { unregisterBridgeEndpoints(); delete (Zotero as any)[config.addonInstance]; });

function expectReadOnly() {
  for (const call of [localStorage.set, fetchReferencesByIdentifiers, fetchCitationsByIdentifiers,
    resolveMany, readZoMinerReferences, recordCatalogDiscoverySnapshot]) { expect(call).not.toHaveBeenCalled(); }
}

describe("bridge cache projection", () => {
  it("routes HTTP cache hits and misses to the read-only path; only fetch opts in", async () => {
    vi.mocked(libraryItem).mockReturnValue(item);
    const views = new Views();
    (Zotero as any)[config.addonInstance] = { views };
    (Zotero as any).Server = { Endpoints: {} };
    registerBridgeEndpoints();
    const endpoint = new (Zotero as any).Server.Endpoints["/unizero/v1/relations"]();
    const cached = vi.spyOn(views, "getCachedLiteratureSnapshot");
    const fetching = vi.spyOn(views, "getLiteratureSnapshot");
    const query = { libraryID: "2", itemKey: "SUBJECT", kind: "references" };
    vi.mocked(localStorage.get).mockReturnValue(state());
    const hit = await endpoint.init({ query });
    expect(hit[0]).toBe(200);
    expect(JSON.parse(hit[2])).toMatchObject({ loaded: true, count: 1, libraryID: 2 });
    vi.mocked(localStorage.get).mockReturnValue(undefined);
    const miss = await endpoint.init({ query });
    expect(JSON.parse(miss[2])).toMatchObject({ loaded: false, count: 0 });
    expect(cached).toHaveBeenCalledTimes(2);
    expect(fetching).not.toHaveBeenCalled();
    expectReadOnly();
    vi.mocked(fetchCitationsByIdentifiers).mockResolvedValue({ citations: [entry], total: 1, source: "OpenAlex" } as any);
    const fetched = await endpoint.init({ query: { ...query, kind: "citations", fetch: "1" } });
    expect(fetched[0]).toBe(200);
    expect(fetching).toHaveBeenCalledWith(item, "citations", false, { recordDiscovery: false });
    expect(fetchCitationsByIdentifiers).toHaveBeenCalledTimes(1);
    expect(recordCatalogDiscoverySnapshot).not.toHaveBeenCalled();
  });
  it("returns DOI-only references without resolving or ingesting them", async () => {
    const cached = state();
    vi.mocked(localStorage.get).mockImplementation((_item, key) => key === CACHE_KEY_REFERENCES ? cached : undefined);
    const snapshot = await new Views().getCachedLiteratureSnapshot(item, "references");
    expect(snapshot?.items[0].title).toBe(entry.title);
    expect(snapshot?.seed.libraryID).toBe(2);
    expect(cached).toEqual(state({ savedAt: cached.savedAt }));
    expectReadOnly();
  });

  it("keeps a completed empty reference cache empty without promoting attachments", async () => {
    vi.mocked(localStorage.get).mockReturnValue(state({ references: [] }));
    expect((await new Views().getCachedLiteratureSnapshot(item, "references"))?.loaded).toBe(0);
    expectReadOnly();
  });

  it("reports missing and identity-mismatched caches as unloaded", async () => {
    for (const cached of [undefined, state({ doi: "10.1000/other" })]) {
      vi.mocked(localStorage.get).mockReturnValue(cached);
      expect(await new Views().getCachedLiteratureSnapshot(item, "references")).toBeUndefined();
    }
    expectReadOnly();
  });

  it("preserves citation paging and the negative-cache boundary", async () => {
    vi.mocked(localStorage.get).mockImplementation((_item, key) => key === CACHE_KEY_CITATIONS
      ? state({ all: [entry], loaded: 1, total: 5 }) : undefined);
    expect(await new Views().getCachedLiteratureSnapshot(item, "citations")).toMatchObject({ loaded: 1, total: 5, hasMore: true });
    vi.mocked(localStorage.get).mockReturnValue(state({ all: [], loaded: 0, total: 0, savedAt: 1 }));
    expect(await new Views().getCachedLiteratureSnapshot(item, "citations")).toBeUndefined();
    expectReadOnly();
  });

  it("uses validated session state when disk caching is disabled", async () => {
    (Zotero as any).Prefs.get = () => false;
    const views = new Views();
    (views as any).explorerReferences.set("2:SUBJECT", state());
    expect((await views.getCachedLiteratureSnapshot(item, "references"))?.loaded).toBe(1);
    expect(localStorage.get).not.toHaveBeenCalled();
    expectReadOnly();
  });

  it.each(["references", "citations"] as const)("bounds session %s by recency and preserves library scope", async (kind) => {
    (Zotero as any).Prefs.get = () => false;
    const views = new Views();
    const cache = (views as any)[kind === "references" ? "explorerReferences" : "explorerCitations"];
    const payload = kind === "references" ? state() : state({ all: [entry], loaded: 1, total: 1 });
    // Same item key in different libraries remains two distinct records.
    cache.set("2:SUBJECT", payload);
    cache.set("1:SUBJECT", { ...payload, doi: "10.1000/other" });
    for (let i = 2; i < SESSION_CACHE_CAPACITY; i++) { cache.set(`2:PAPER${i}`, payload); }
    expect((await views.getCachedLiteratureSnapshot(item, kind))?.loaded).toBe(1);
    cache.set("2:NEW", payload);
    expect(cache.size).toBe(SESSION_CACHE_CAPACITY);
    expect(cache.get("1:SUBJECT")).toBeUndefined();
    expect((await views.getCachedLiteratureSnapshot(item, kind))?.loaded).toBe(1);
    for (let i = 0; i < SESSION_CACHE_CAPACITY; i++) { cache.set(`2:LATER${i}`, payload); }
    expect(await views.getCachedLiteratureSnapshot(item, kind)).toBeUndefined();
    expect(cache.size).toBe(SESSION_CACHE_CAPACITY);
    expectReadOnly();
    // An evicted payload remains available through its saved shard.
    (Zotero as any).Prefs.get = () => true;
    vi.mocked(localStorage.get).mockReturnValue(payload);
    expect((await views.getCachedLiteratureSnapshot(item, kind))?.loaded).toBe(1);
    expectReadOnly();
  });

  it("releases session payloads on shutdown and rejects late async writes", () => {
    const views = new Views();
    const references = (views as any).explorerReferences, citations = (views as any).explorerCitations;
    references.set("2:SUBJECT", state()); citations.set("2:SUBJECT", state({ all: [entry] }));
    views.onDestroy();
    references.set("2:LATE", state()); citations.set("2:LATE", state({ all: [entry] }));
    expect(references.size).toBe(0); expect(citations.size).toBe(0);
  });

  it("projects locally derived relations without ingestion", async () => {
    expect(await new Views().getCachedLiteratureSnapshot(item, "relation")).toMatchObject({ source: "UniConnection", items: [] });
    expectReadOnly();
  });

  it("allows explicit fetching and cache persistence without writing the Paper catalog", async () => {
    vi.mocked(localStorage.get).mockReturnValue(undefined);
    vi.mocked(fetchCitationsByIdentifiers).mockResolvedValue({ citations: [entry], total: 1, source: "OpenAlex" } as any);
    const snapshot = await new Views().getLiteratureSnapshot(item, "citations", false, { recordDiscovery: false });
    expect(snapshot.loaded).toBe(1);
    expect(fetchCitationsByIdentifiers).toHaveBeenCalledTimes(1);
    expect(localStorage.set).toHaveBeenCalledTimes(1);
    expect(recordCatalogDiscoverySnapshot).not.toHaveBeenCalled();
  });

  it("permits explicit DOI repair without catalog ingestion", async () => {
    vi.mocked(localStorage.get).mockReturnValue(state());
    const views = new Views();
    const repair = vi.spyOn(views as any, "fillReferencePlaceholders").mockImplementation(async (...args: any[]) => {
      await args[1]({ ...args[0], references: [{ ...entry, title: "Resolved paper" }] });
    });
    await views.getLiteratureSnapshot(item, "references", false, { recordDiscovery: false });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(localStorage.set).toHaveBeenCalledTimes(1);
    expect(recordCatalogDiscoverySnapshot).not.toHaveBeenCalled();
  });
});
