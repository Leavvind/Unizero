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
    centerOnSelection: vi.fn(),
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
  it("opens a Collection node in the shared split detail view", async () => {
    const harness = createHarness();
    await flush();
    const renderer = (harness.win as any).LiteratureGraph;
    renderer.resize.mockClear();
    renderer.centerOnSelection.mockClear();

    await harness.explorer.showCollectionPreview("P1");

    expect(harness.explorer.mode).toBe("split");
    expect(harness.win.document.getElementById("collection-view")?.hidden)
      .toBe(false);
    expect(harness.win.document.getElementById("detail-view")?.hidden)
      .toBe(false);
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("row-of-P1");
    expect(harness.win.document.getElementById("collection-table-panel")
      ?.querySelector("summary")).toBeNull();
    expect(harness.win.document.getElementById("explorer-workspace")
      ?.classList.contains("split-mode")).toBe(true);
    expect(harness.explorer.tabs).toHaveLength(0);
    expect(harness.explorer.activeTab).toBe(-1);
    expect(harness.explorer.collectionPreview.itemKey).toBe("P1");
    expect(renderer.resize).toHaveBeenCalledWith(
      harness.explorer.graphs.collection,
    );
    expect(renderer.centerOnSelection).toHaveBeenCalledWith(
      harness.explorer.graphs.collection,
      0,
    );
    expect(renderer.resize.mock.invocationCallOrder[0])
      .toBeLessThan(renderer.centerOnSelection.mock.invocationCallOrder[0]);
    harness.win.close();
  });

  it("replaces the Collection preview when another node is selected", async () => {
    const harness = createHarness();
    await flush();

    await harness.explorer.showCollectionPreview("P1");
    await harness.explorer.showCollectionPreview("P2");

    expect(harness.explorer.tabs).toHaveLength(0);
    expect(harness.explorer.activeTab).toBe(-1);
    expect(harness.explorer.collectionPreview.itemKey).toBe("P2");
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("row-of-P2");
    expect(harness.win.document.querySelectorAll(".page-tab")).toHaveLength(1);
    harness.win.close();
  });

  it("drops a slow result after its Collection preview is replaced", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    const harness = createHarness({
      snapshot: (itemKey: string) =>
        itemKey === "P1" ? first.promise : second.promise,
    });
    await flush();

    const openingFirst = harness.explorer.showCollectionPreview("P1");
    await flush();
    const openingSecond = harness.explorer.showCollectionPreview("P2");
    second.resolve(snapshot("P2", "Second Paper"));
    await openingSecond;
    first.resolve(snapshot("P1", "First Paper"));
    await openingFirst;

    expect(harness.explorer.tabs).toHaveLength(0);
    expect(harness.explorer.collectionPreview.itemKey).toBe("P2");
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("row-of-P2");
    expect(harness.win.document.getElementById("rows")?.textContent)
      .not.toContain("row-of-P1");
    harness.win.close();
  });

  it("promotes the split preview to the full paper tab through Open", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showCollectionPreview("P1");

    await harness.explorer.showDetail("P1", "references");

    expect(harness.explorer.mode).toBe("detail");
    expect(harness.win.document.getElementById("collection-view")?.hidden)
      .toBe(true);
    expect(harness.win.document.getElementById("detail-view")?.hidden)
      .toBe(false);
    expect(harness.explorer.tabs).toHaveLength(1);
    expect(harness.explorer.tabs[0].itemKey).toBe("P1");
    expect(harness.explorer.collectionPreview).toBeNull();
    harness.win.close();
  });

  it("returns to the full management table when Table mode is selected", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showCollectionPreview("P1");

    harness.explorer.setCollectionMode("table");

    expect(harness.explorer.mode).toBe("collection");
    expect(harness.explorer.activeTab).toBe(-1);
    expect(harness.explorer.collectionPreview).toBeNull();
    expect(harness.win.document.getElementById("detail-view")?.hidden).toBe(true);
    expect(harness.win.document.getElementById("collection-view")
      ?.classList.contains("table-mode")).toBe(true);
    harness.win.close();
  });

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

  it("drops a snapshot after its owning tab is closed", async () => {
    const pending = deferred<any>();
    const harness = createHarness({ snapshot: () => pending.promise });
    await flush();

    const opening = harness.explorer.showDetail("P1", "references");
    await flush();
    await harness.explorer.closeTab(0);
    pending.resolve(snapshot("P1", "Closed Paper"));
    await opening;

    expect(harness.explorer.tabs).toHaveLength(0);
    expect(harness.explorer.activeTab).toBe(-1);
    expect(harness.explorer.mode).toBe("collection");
    expect(harness.win.document.getElementById("paper-title")?.textContent)
      .toBe("Library A");
    harness.win.close();
  });

  it("supersedes an old kind and load-more request on the same tab", async () => {
    const oldReferences = deferred<any>();
    const freshReferences = deferred<any>();
    const citations = deferred<any>();
    const more = deferred<any>();
    let referenceCalls = 0;
    const harness = createHarness({
      snapshot: (_itemKey: string, kind: string) =>
        kind === "references"
          ? (++referenceCalls === 1 ? oldReferences.promise : freshReferences.promise)
          : citations.promise,
      loadMoreCitations: () => more.promise,
    });
    await flush();

    const opening = harness.explorer.showDetail("P1", "references");
    await flush();
    const switching = harness.explorer.switchKind("citations");
    citations.resolve(snapshot("P1", "Citations"));
    await switching;
    oldReferences.resolve(snapshot("P1", "References"));
    await opening;

    const paging = harness.explorer.loadMore();
    await flush();
    const backToReferences = harness.explorer.switchKind("references");
    freshReferences.resolve(snapshot("P1", "Fresh References"));
    await backToReferences;
    more.resolve(snapshot("P1", "Stale More"));
    await paging;

    expect(harness.explorer.activeTabState().kind).toBe("references");
    expect(harness.explorer.activeTabState().snapshot.seed.title)
      .toBe("Fresh References");
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

  it("does not save a settled Library A layout after reloading to Library B", async () => {
    const saveGraphLayout = vi.fn(async () => undefined);
    const harness = createHarness({ saveGraphLayout });
    await flush();
    await harness.explorer.loadCollectionGraph(true);
    const oldView = harness.explorer.graphs.collection;
    const renderer = (harness.win as any).LiteratureGraph;
    renderer.snapshotPositions = () => ({ "1:P1": [10, 20] });

    harness.context.current = {
      mode: "collection",
      scope: { libraryID: 2, name: "Library B" },
    };
    harness.explorer.reloadContext();
    renderer.emitSettled(oldView);
    await flush();

    expect(saveGraphLayout).not.toHaveBeenCalled();
    expect(renderer.destroy).toHaveBeenCalledWith(oldView);
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

  it("uses the chrome-safe dropdown for graph colour settings", async () => {
    const harness = createHarness();
    await flush();
    harness.explorer.graphSettings = { colourBy: "none" };

    harness.explorer.buildGraphPanel("collection");
    const panel = harness.win.document.getElementById("collection-graph-panel")!;
    expect(panel.querySelector("select")).toBeNull();
    expect(panel.querySelector(".dropdown-label")?.textContent)
      .toBe("graphColourNone");

    const year = Array.from(panel.querySelectorAll<HTMLButtonElement>(
      ".dropdown-option",
    )).find((option) => option.dataset.value === "year");
    year?.click();
    expect(harness.explorer.graphSettings.colourBy).toBe("year");
    expect(panel.querySelector(".dropdown-label")?.textContent)
      .toBe("graphColourYear");
    harness.win.close();
  });

  it("shows the stored Obsidian URL and one link-change action", async () => {
    const uri = "obsidian://adv-uri?vault=Academic&uid=P1";
    const harness = createHarness({
      markdownLink: async () => ({ url: uri }),
      openMarkdown: async () => undefined,
      editMarkdownLink: async () => undefined,
    });
    await flush();

    await harness.explorer.showMarkdownMenu(paper("P1", "First Paper"), null);
    const menu = harness.win.document.getElementById("graph-menu")!;
    expect(menu.querySelector(".graph-menu-note")?.textContent).toBe(uri);
    const linkActions = Array.from(menu.querySelectorAll("button"))
      .filter((button) => button.textContent === "markdownRelink");
    expect(linkActions).toHaveLength(1);
    expect(linkActions[0].disabled).toBe(false);
    harness.win.close();
  });

  it("never presents an absolute attachment path as the Markdown link", async () => {
    const harness = createHarness({
      markdownLink: async () => ({
        url: "obsidian://adv-uri?uid=P1",
      }),
      openMarkdown: async () => undefined,
      editMarkdownLink: async () => undefined,
    });
    await flush();

    await harness.explorer.showMarkdownMenu(paper("P1", "Legacy"), null);
    const menu = harness.win.document.getElementById("graph-menu")!;
    expect(menu.textContent).not.toContain("D:\\");
    expect(menu.textContent).toContain("obsidian://adv-uri");
    const linkActions = Array.from(menu.querySelectorAll("button"))
      .filter((button) => button.textContent === "markdownRelink");
    expect(linkActions).toHaveLength(1);
    expect(linkActions[0].disabled).toBe(false);
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

  it("reloads topology only after a References action resolves", async () => {
    const relation = deferred<any>();
    const graphCalls = vi.fn(async (scope: any) => ({
      scope: { libraryID: scope.libraryID },
      nodes: [],
      edges: [],
    }));
    const harness = createHarness({
      graph: graphCalls,
      loadRelation: () => relation.promise,
    });
    await flush();
    await harness.explorer.loadCollectionGraph(true);
    const before = graphCalls.mock.calls.length;

    harness.explorer._menuWhich = "collection";
    const action = harness.explorer.runGraphAction(
      "P1",
      () => (harness.api as any).loadRelation("P1", "references"),
      "references",
    );
    await flush();
    expect(graphCalls).toHaveBeenCalledTimes(before);

    relation.resolve({
      references: { loaded: true, count: 3, total: 3 },
    });
    await action;
    await flush();
    expect(graphCalls).toHaveBeenCalledTimes(before + 1);
    harness.win.close();
  });

  it("patches Markdown metadata without rebuilding topology", async () => {
    const graphCalls = vi.fn(async () => graph(1, "P1"));
    const harness = createHarness({ graph: graphCalls });
    await flush();
    await harness.explorer.loadCollectionGraph(true);
    const before = graphCalls.mock.calls.length;

    harness.explorer._menuWhich = "collection";
    await harness.explorer.runGraphAction(
      "P1",
      async () => ({ title: "Converted Paper", hasMarkdown: true }),
      "metadata",
    );

    expect(graphCalls).toHaveBeenCalledTimes(before);
    expect(harness.explorer.graphData.collection.nodes[0]).toMatchObject({
      title: "Converted Paper",
      hasMarkdown: true,
    });
    harness.win.close();
  });

  it("updates citation status without invalidating cached graphs", async () => {
    const graphCalls = vi.fn(async () => graph(1, "P1"));
    const harness = createHarness({ graph: graphCalls });
    await flush();
    await harness.explorer.loadCollectionGraph(true);
    const cached = harness.explorer.graphData.collection;
    const before = graphCalls.mock.calls.length;

    harness.explorer._menuWhich = "collection";
    await harness.explorer.runGraphAction(
      "P1",
      async () => ({ citations: { loaded: true, count: 7, total: 7 } }),
      "citations",
    );

    expect(graphCalls).toHaveBeenCalledTimes(before);
    expect(harness.explorer.graphData.collection).toBe(cached);
    expect(harness.explorer.collectionSnapshot.items[0].citations)
      .toMatchObject({ loaded: true, count: 7 });
    harness.win.close();
  });

  it("destroys simulations and pending refits on window teardown", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showDetail("P1", "graph");
    const renderer = (harness.win as any).LiteratureGraph;
    const detailView = harness.explorer.graphs.detail;

    harness.explorer.destroy();

    expect(renderer.destroy).toHaveBeenCalledWith(detailView);
    expect(harness.explorer.graphs).toEqual({ collection: null, detail: null });
    expect(harness.explorer._refitTimers || {}).toEqual({});
    harness.win.close();
  });
});
