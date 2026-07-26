import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const explorerPath = new URL(
  "../addon/chrome/content/literature-explorer.js",
  import.meta.url,
);
const xhtmlPath = new URL(
  "../addon/chrome/content/literature-explorer.xhtml",
  import.meta.url,
);
const explorerSource = readFileSync(explorerPath, "utf8");
const explorerMarkup = readFileSync(xhtmlPath, "utf8")
  .replace(/<\?xml[^>]*>\s*/u, "")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, "");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function paper(itemKey: string, title: string) {
  return {
    itemKey,
    title,
    creators: ["Tester"],
    year: "2026",
    dateAdded: "2026-01-01",
    references: { loaded: false },
    citations: { loaded: false },
    hasPDF: false,
    hasMarkdown: false,
  };
}

function collection(libraryID: number, name: string) {
  return {
    scope: { libraryID, name },
    items: [
      paper("P1", "First Paper"),
      paper("P2", "Second Paper"),
    ],
  };
}

function snapshot(itemKey: string, title: string) {
  return {
    seed: { itemKey, title },
    source: "test",
    items: [
      {
        title: `row-of-${itemKey}`,
        year: "2025",
        authors: ["Tester"],
        identifiers: {},
        membership: { inLibrary: false },
      },
    ],
    bySource: {},
    sources: [],
    loaded: 1,
    total: 1,
    hasMore: false,
  };
}

function graph(libraryID: number, itemKey: string) {
  const center = `${libraryID}:${itemKey}`;
  return {
    scope: { libraryID },
    center,
    nodes: [{
      id: center,
      itemKey,
      itemID: itemKey === "P1" ? 1 : 2,
      title: `${itemKey} graph`,
      creators: [],
      degree: 0,
      hasPDF: false,
      hasMarkdown: false,
      isCenter: true,
    }],
    edges: [],
  };
}

function strings(): Record<string, string> {
  return new Proxy({}, {
    get: (_target, property) => String(property),
  });
}

function rendererStub() {
  const renderer = {
    SETTINGS_DEFAULTS: {},
    sanitizeSettings: (value: unknown) => value || {},
    forceSignature: () => "test",
    create: (container: HTMLElement) => ({ container, data: null }),
    destroy: vi.fn(),
    resize: vi.fn(),
    applySettings: vi.fn(),
    setData: (view: any, data: any) => {
      view.data = data;
      return {
        nodes: data.nodes.length,
        links: data.edges.length,
        warm: false,
      };
    },
    onSettled: vi.fn((view: any, callback: () => void) => {
      view.settleListeners = view.settleListeners || new Set();
      view.settleListeners.add(callback);
      return () => view.settleListeners.delete(callback);
    }),
    emitSettled: (view: any) => {
      Array.from(view.settleListeners || []).forEach((callback: any) => callback());
    },
    snapshotPositions: () => ({}),
    zoomToFit: vi.fn(),
    centerOnFocus: vi.fn(),
    select: vi.fn(),
  };
  return renderer;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const win = new Window({ url: "http://localhost/" });
  win.document.write(explorerMarkup);
  const context = {
    current: {
      mode: "collection",
      scope: { libraryID: 1, name: "Library A" },
    } as any,
  };
  const api = {
    strings: strings(),
    getContext: () => context.current,
    collectionSnapshot: async (scope: any) =>
      collection(scope.libraryID, scope.name),
    snapshot: async (itemKey: string) =>
      snapshot(itemKey, itemKey === "P1" ? "First Paper" : "Second Paper"),
    graph: async (scope: any) => ({
      scope: { libraryID: scope.libraryID },
      nodes: [],
      edges: [],
    }),
    focusedGraph: async (itemKey: string, scope: any) =>
      graph(scope.libraryID, itemKey),
    graphLayout: async () => ({}),
    saveGraphLayout: async () => undefined,
    graphSettings: async () => ({}),
    saveGraphSettings: async () => undefined,
    refreshCollectionStatuses: async () => ({}),
    relationProgress: () => [],
    ...overrides,
  };
  (win as any).arguments = [{ api }];
  (win as any).LiteratureGraph = rendererStub();
  win.eval(`${explorerSource}\nwindow.__testExplorer = LiteratureExplorer;`);
  const explorer = (win as any).__testExplorer;
  explorer.init();
  return { win, explorer, context, api };
}

describe("Literature Explorer async ownership", () => {
  it("keeps slow snapshot results on their owning inactive tab", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    const calls: string[] = [];
    const harness = createHarness({
      snapshot: (itemKey: string) => {
        calls.push(itemKey);
        return itemKey === "P1" ? first.promise : second.promise;
      },
    });
    await flush();

    const openingFirst = harness.explorer.showDetail("P1", "references");
    await flush();
    await harness.explorer.activateTab(-1);
    const openingSecond = harness.explorer.showDetail("P2", "references");
    await flush();

    second.resolve(snapshot("P2", "Second Paper"));
    await openingSecond;
    first.resolve(snapshot("P1", "First Paper"));
    await openingFirst;

    expect(calls).toEqual(["P1", "P2"]);
    expect(harness.explorer.activeItemKey).toBe("P2");
    expect(harness.win.document.getElementById("paper-title")?.textContent)
      .toBe("Second Paper");
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("row-of-P2");
    expect(harness.explorer.tabs.map((tab: any) => tab.title))
      .toEqual(["First Paper", "Second Paper"]);
    expect(harness.explorer.tabs[0].snapshot.seed.itemKey).toBe("P1");
    expect(harness.explorer.tabs[1].snapshot.seed.itemKey).toBe("P2");
    harness.win.close();
  });

  it("keeps out-of-order focused graphs on their owning tabs", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    const calls: string[] = [];
    const harness = createHarness({
      focusedGraph: (itemKey: string) => {
        calls.push(itemKey);
        return itemKey === "P1" ? first.promise : second.promise;
      },
    });
    await flush();

    const openingFirst = harness.explorer.showDetail("P1", "graph");
    await flush();
    await harness.explorer.activateTab(-1);
    const openingSecond = harness.explorer.showDetail("P2", "graph");
    await flush();

    second.resolve(graph(1, "P2"));
    await openingSecond;
    first.resolve(graph(1, "P1"));
    await openingFirst;

    expect(calls).toEqual(["P1", "P2"]);
    expect(harness.explorer.graphData.detail.center).toBe("1:P2");
    expect(harness.explorer.tabs[0].graphData.center).toBe("1:P1");
    expect(harness.explorer.tabs[1].graphData.center).toBe("1:P2");
    harness.win.close();
  });

  it("drops an old Collection result after the window changes library", async () => {
    const oldCollection = deferred<any>();
    let calls = 0;
    const harness = createHarness({
      collectionSnapshot: (scope: any) => {
        calls += 1;
        return calls === 1
          ? oldCollection.promise
          : Promise.resolve(collection(scope.libraryID, scope.name));
      },
    });
    await flush();

    harness.context.current = {
      mode: "collection",
      scope: { libraryID: 2, name: "Library B" },
    };
    harness.explorer.reloadContext();
    await flush();
    oldCollection.resolve(collection(1, "Library A"));
    await flush();

    expect(harness.explorer.collectionSnapshot.scope.libraryID).toBe(2);
    expect(harness.win.document.getElementById("paper-title")?.textContent)
      .toBe("Library B");
    harness.win.close();
  });

  it("stores detail graph filters per paper instead of inheriting Collection", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showDetail("P1", "graph");
    harness.explorer.tabs[0].graphFilters = { links: "cites", minShared: 2 };
    await harness.explorer.activateTab(-1);
    await harness.explorer.showDetail("P2", "graph");
    harness.explorer.tabs[1].graphFilters = { links: "coupled", minShared: 4 };
    await harness.explorer.activateTab(0);

    expect(harness.explorer.graphFilters).toEqual({ links: "all", minShared: 1 });
    expect(harness.explorer.graphFiltersFor("detail"))
      .toEqual({ links: "cites", minShared: 2 });
    expect((harness.win.document.getElementById("detail-min-shared") as HTMLInputElement)
      .value).toBe("2");
    harness.win.close();
  });

  it("keeps layout saving and final fit as separate settle listeners", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showDetail("P1", "graph");
    const renderer = (harness.win as any).LiteratureGraph;
    const view = harness.explorer.graphs.detail;

    expect(view.settleListeners.size).toBe(2);
    renderer.emitSettled(view);
    expect(renderer.zoomToFit).toHaveBeenCalledTimes(1);
    expect(view.settleListeners.size).toBe(1);

    harness.explorer.applyGraphData("detail", graph(1, "P1"));
    expect(view.settleListeners.size).toBe(2);
    renderer.emitSettled(view);
    expect(renderer.zoomToFit).toHaveBeenCalledTimes(2);
    expect(view.settleListeners.size).toBe(1);
    harness.win.close();
  });
});
