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

function title(itemKey: string): string {
  return itemKey === "P1" ? "First Paper" : "Second Paper";
}

function snapshot(itemKey: string, paperTitle: string) {
  return {
    seed: { itemKey, title: paperTitle },
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

function emptyReferenceSnapshot(itemKey: string, paperTitle: string) {
  return {
    seed: { itemKey, title: paperTitle },
    source: "none",
    items: [],
    bySource: {
      openAlex: [],
      crossref: [],
      semanticScholar: [],
    },
    sources: [
      {
        key: "openAlex",
        name: "OpenAlex",
        status: "empty",
        count: 0,
        total: 0,
        hasMore: false,
      },
      {
        key: "crossref",
        name: "Crossref",
        status: "empty",
        count: 0,
        total: 0,
        hasMore: false,
      },
      {
        key: "semanticScholar",
        name: "Semantic Scholar",
        status: "unavailable",
        count: 0,
        total: 0,
        hasMore: false,
      },
    ],
    loaded: 0,
    total: 0,
    hasMore: false,
  };
}

function strings(): Record<string, string> {
  return new Proxy({}, {
    get: (_target, property) => String(property),
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const win = new Window({ url: "http://localhost/" });
  win.document.write(explorerMarkup);
  const context = {
    current: { libraryID: 1, itemKey: "P1", kind: "references" } as any,
  };
  const api = {
    strings: strings(),
    getContext: () => context.current,
    snapshot: async (itemKey: string) => snapshot(itemKey, title(itemKey)),
    // A cache hit is the default these tests are written against: opening a paper
    // only reaches the providers when the probe reports a miss, and the cases that
    // care about a miss override this.
    snapshotStatus: async () => ({ loaded: true }),
    relationProgress: () => [],
    ...overrides,
  };
  (win as any).arguments = [{ api }];
  // Closing the last tab closes the window; record that instead of tearing the
  // test document down underneath the assertions.
  const teardown = win.close.bind(win);
  const closeWindow = vi.fn();
  (win as any).close = closeWindow;
  win.eval(`${explorerSource}\nwindow.__testExplorer = LiteratureExplorer;`);
  const explorer = (win as any).__testExplorer;
  explorer.init();
  return { win, explorer, context, api, closeWindow, teardown };
}

function reopen(harness: ReturnType<typeof createHarness>, current: any) {
  harness.context.current = current;
  return harness.explorer.reloadContext();
}

function text(harness: ReturnType<typeof createHarness>, id: string) {
  return harness.win.document.getElementById(id)?.textContent || "";
}

describe("Unizero Home paper tabs", () => {
  it("opens the paper it was opened on as the only tab", async () => {
    const harness = createHarness();
    await flush();

    expect(harness.explorer.tabs).toHaveLength(1);
    expect(harness.explorer.activeTabState().itemKey).toBe("P1");
    expect(text(harness, "paper-title")).toBe("First Paper");
    expect(text(harness, "page-tabs")).toContain("First Paper");
    expect(text(harness, "rows")).toContain("row-of-P1");
    harness.teardown();
  });

  it("opens another paper of the same library beside the open tabs", async () => {
    const harness = createHarness();
    await flush();

    await reopen(harness, { libraryID: 1, itemKey: "P2", kind: "references" });

    expect(harness.explorer.tabs.map((tab: any) => tab.itemKey))
      .toEqual(["P1", "P2"]);
    expect(harness.explorer.activeTab).toBe(1);
    expect(text(harness, "rows")).toContain("row-of-P2");
    harness.teardown();
  });

  it("switches an open paper's tab to the requested kind instead of adding one", async () => {
    const readSnapshot = vi.fn(async (itemKey: string, kind: string) =>
      snapshot(itemKey, `${title(itemKey)} ${kind}`));
    const harness = createHarness({ snapshot: readSnapshot });
    await flush();
    await reopen(harness, { libraryID: 1, itemKey: "P2", kind: "references" });

    await reopen(harness, { libraryID: 1, itemKey: "P1", kind: "citations" });

    expect(harness.explorer.tabs).toHaveLength(2);
    expect(harness.explorer.activeTab).toBe(0);
    expect(harness.explorer.activeTabState().kind).toBe("citations");
    expect(readSnapshot.mock.calls.at(-1)).toEqual(["P1", "citations", false, 1]);
    expect(text(harness, "paper-title")).toBe("First Paper citations");
    harness.teardown();
  });

  it("reuses a completed snapshot when a tab switches back to a kind", async () => {
    const readSnapshot = vi.fn(async (itemKey: string, kind: string) =>
      snapshot(itemKey, `${title(itemKey)} ${kind}`));
    const harness = createHarness({ snapshot: readSnapshot });
    await flush();

    await harness.explorer.switchKind("citations");
    await harness.explorer.switchKind("references");

    expect(readSnapshot.mock.calls.map((call) => call[1]))
      .toEqual(["references", "citations"]);
    expect(text(harness, "paper-title")).toBe("First Paper references");
    harness.teardown();
  });

  it("drops its tabs and their in-flight results when reopened for another library", async () => {
    const oldLibrary = deferred<any>();
    const harness = createHarness({
      snapshot: (itemKey: string, _kind: string, _refresh: boolean, libraryID: number) =>
        libraryID === 1
          ? oldLibrary.promise
          : Promise.resolve(snapshot(itemKey, "Library B paper")),
    });
    await flush();

    await reopen(harness, { libraryID: 2, itemKey: "P1", kind: "references" });
    oldLibrary.resolve(snapshot("P1", "Library A paper"));
    await flush();

    expect(harness.explorer.tabs).toHaveLength(1);
    expect(harness.explorer.activeTabState().snapshot.seed.title)
      .toBe("Library B paper");
    expect(text(harness, "paper-title")).toBe("Library B paper");
    harness.teardown();
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

    const openingSecond = reopen(harness, {
      libraryID: 1,
      itemKey: "P2",
      kind: "references",
    });
    await flush();
    second.resolve(snapshot("P2", "Second Paper"));
    await openingSecond;
    first.resolve(snapshot("P1", "First Paper"));
    await flush();

    expect(calls).toEqual(["P1", "P2"]);
    expect(harness.explorer.activeItemKey).toBe("P2");
    expect(text(harness, "paper-title")).toBe("Second Paper");
    expect(text(harness, "rows")).toContain("row-of-P2");
    expect(harness.explorer.tabs.map((tab: any) => tab.title))
      .toEqual(["First Paper", "Second Paper"]);
    expect(harness.explorer.tabs[0].snapshot.seed.itemKey).toBe("P1");
    expect(harness.explorer.tabs[1].snapshot.seed.itemKey).toBe("P2");
    harness.teardown();
  });

  it("drops a snapshot after its owning tab is closed", async () => {
    const pending = deferred<any>();
    const harness = createHarness({
      snapshot: (itemKey: string) => itemKey === "P1"
        ? pending.promise
        : Promise.resolve(snapshot(itemKey, title(itemKey))),
    });
    await flush();
    await reopen(harness, { libraryID: 1, itemKey: "P2", kind: "references" });

    await harness.explorer.closeTab(0);
    pending.resolve(snapshot("P1", "Closed Paper"));
    await flush();

    expect(harness.explorer.tabs.map((tab: any) => tab.itemKey)).toEqual(["P2"]);
    expect(harness.explorer.activeTab).toBe(0);
    expect(text(harness, "page-tabs")).not.toContain("Closed Paper");
    expect(text(harness, "rows")).toContain("row-of-P2");
    expect(harness.closeWindow).not.toHaveBeenCalled();
    harness.teardown();
  });

  it("closes the window with its last tab", async () => {
    const harness = createHarness();
    await flush();

    harness.win.dispatchEvent(new harness.win.KeyboardEvent("keydown", {
      key: "w",
      ctrlKey: true,
    }));
    await flush();

    expect(harness.explorer.tabs).toHaveLength(0);
    expect(harness.closeWindow).toHaveBeenCalledTimes(1);
    harness.teardown();
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

    const switching = harness.explorer.switchKind("citations");
    citations.resolve(snapshot("P1", "Citations"));
    await switching;
    oldReferences.resolve(snapshot("P1", "References"));
    await flush();

    const paging = harness.explorer.loadMore();
    await flush();
    // The stale references never completed, so returning has nothing cached.
    const backToReferences = harness.explorer.switchKind("references");
    freshReferences.resolve(snapshot("P1", "Fresh References"));
    await backToReferences;
    more.resolve(snapshot("P1", "Stale More"));
    await paging;

    expect(harness.explorer.activeTabState().kind).toBe("references");
    expect(harness.explorer.activeTabState().snapshot.seed.title)
      .toBe("Fresh References");
    harness.teardown();
  });
});

describe("Unizero Home cache-first loading", () => {
  it("keeps provider progress hidden while reading a known disk cache hit", async () => {
    const pending = deferred<any>();
    const snapshotStatus = vi.fn(async () => ({ loaded: true }));
    const harness = createHarness({
      snapshotStatus,
      snapshot: () => pending.promise,
    });
    await flush();

    expect(snapshotStatus).toHaveBeenCalledWith("P1", "references", 1);
    expect(text(harness, "status")).toBe("readingCache");
    expect(harness.win.document.getElementById("progress")?.hidden).toBe(true);

    pending.resolve(snapshot("P1", "First Paper"));
    await flush();
    harness.teardown();
  });

  it("offers to fetch instead of calling providers when the probe confirms a miss", async () => {
    const fetched = vi.fn(async () => snapshot("P1", "First Paper"));
    const harness = createHarness({
      snapshotStatus: async () => ({ loaded: false }),
      snapshot: fetched,
    });
    await flush();

    expect(fetched).not.toHaveBeenCalled();
    expect(text(harness, "status")).toBe("notCached");
    expect(harness.win.document.getElementById("progress")?.hidden).toBe(true);
    expect(harness.explorer.activeTabState().needsFetch).toBe(true);
    harness.teardown();
  });

  it("reaches the providers, with progress, once the fetch prompt is clicked", async () => {
    const pending = deferred<any>();
    const harness = createHarness({
      snapshotStatus: async () => ({ loaded: false }),
      snapshot: () => pending.promise,
    });
    await flush();

    const prompt = harness.win.document
      .querySelector("#rows .fetch-now") as HTMLButtonElement;
    expect(prompt?.textContent).toBe("fetchNow");
    prompt.click();
    await flush();

    expect(text(harness, "status")).toBe("loading");
    expect(harness.win.document.getElementById("progress")?.hidden).toBe(false);

    pending.resolve(snapshot("P1", "First Paper"));
    await flush();
    expect(harness.win.document.getElementById("progress")?.hidden).toBe(true);
    expect(harness.explorer.activeTabState().needsFetch).toBe(false);
    harness.teardown();
  });

  it("offers the fetch again where the rows would be after one fails", async () => {
    let attempt = 0;
    const fetched = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) { throw new Error("fail to fetch"); }
      return snapshot("P1", "First Paper");
    });
    const harness = createHarness({
      snapshotStatus: async () => ({ loaded: false }),
      snapshot: fetched,
    });
    await flush();
    (harness.win.document
      .querySelector("#rows .fetch-now") as HTMLButtonElement).click();
    await flush();

    const status = harness.win.document.getElementById("status");
    expect(status?.textContent).toContain("fail to fetch");
    expect(status?.classList.contains("error")).toBe(true);
    const retry = harness.win.document
      .querySelector("#rows .fetch-now") as HTMLButtonElement;
    expect(retry?.textContent).toBe("fetchNow");
    expect(text(harness, "rows")).toContain("fail to fetch");

    retry.click();
    await flush();
    await flush();

    expect(fetched).toHaveBeenCalledTimes(2);
    expect(harness.explorer.activeTabState().error).toBe("");
    expect(text(harness, "rows")).toContain("row-of-P1");
    harness.teardown();
  });

  it("keeps all source states visible when every reference source is empty", async () => {
    const harness = createHarness({
      snapshot: async (itemKey: string) =>
        emptyReferenceSnapshot(itemKey, "First Paper"),
    });
    await flush();

    expect(harness.explorer.activeTabState().snapshot.sources).toHaveLength(3);
    expect(harness.explorer.sourceOptionLabel({
      name: "Semantic Scholar",
      status: "unavailable",
    })).toBe("Semantic Scholar · restricted");
    expect(harness.win.document.getElementById("filter-source")
      ?.closest(".filter-field")?.hidden).toBe(false);
    expect(text(harness, "status")).toContain("OA 0 / CR 0 / S2 ⚠");
    harness.teardown();
  });
});
