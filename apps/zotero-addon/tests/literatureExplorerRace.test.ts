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

function emptyReferenceSnapshot(itemKey: string, title: string) {
  return {
    seed: { itemKey, title },
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

function boardNodeView(
  id: string,
  itemKey: string,
  geometry: Record<string, number>,
) {
  return {
    node: {
      id,
      projectID: "project-1",
      boardID: "board-1",
      paperID: `paper-${itemKey}`,
      kind: "paper",
      geometry,
      createdAt: 1,
      updatedAt: 1,
    },
    paper: {
      id: `paper-${itemKey}`,
      title: itemKey === "P1" ? "First Paper" : "Second Paper",
      authors: ["Tester"],
      year: "2026",
      bindings: [{ library: "library", itemKey }],
    },
    itemKey,
  };
}

function boardTextNodeView(
  id: string,
  geometry: Record<string, number>,
  blocks: any[] = [{
    id: `block-${id}-text`,
    kind: "text",
    text: "",
  }],
) {
  return {
    node: {
      id,
      projectID: "project-1",
      boardID: "board-1",
      kind: "text",
      geometry,
      blocks: blocks.map((entry) => entry.block || entry),
      createdAt: 1,
      updatedAt: 1,
    },
    blocks: blocks.map((entry) => {
      if (entry.block) return entry;
      if (entry.kind === "text") return { block: entry };
      const itemKey = entry.itemKey || "P1";
      return {
        block: entry,
        paper: {
          id: entry.paperID,
          title: itemKey === "P1" ? "First Paper" : "Second Paper",
          authors: ["Tester"],
          year: "2026",
          bindings: [{ library: "library", itemKey }],
        },
        itemKey,
      };
    }),
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
  // Collection startup now joins the stable Project/Board bundle with the Zotero
  // snapshot before publishing either one. Drain the small Promise chain rather
  // than assuming the old two-microtask startup shape.
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
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
  let nextBoardNode = 0;
  let nextBoardEdge = 0;
  let nextBoardBlock = 0;
  const textNodes = new Map<string, any>();
  const api = {
    strings: strings(),
    getContext: () => context.current,
    project: async (scope: any) => ({
      project: {
        id: `project-${scope.libraryID}`,
        name: scope.name,
      },
      defaultBoard: {
        id: `board-${scope.libraryID}`,
      },
      nodes: [],
      edges: [],
      relationHints: [],
    }),
    boardRelationHints: vi.fn(async () => []),
    addBoardNode: vi.fn(async (
      itemKey: string,
      geometry: Record<string, number>,
    ) => boardNodeView(`node-${++nextBoardNode}`, itemKey, geometry)),
    addBoardCandidate: vi.fn(async (
      candidate: any,
      geometry: Record<string, number>,
    ) => ({
      node: {
        id: `node-${++nextBoardNode}`,
        projectID: "project-1",
        boardID: "board-1",
        paperID: "paper-external",
        kind: "paper",
        geometry,
        createdAt: 1,
        updatedAt: 1,
      },
      paper: {
        id: "paper-external",
        title: candidate.title,
        authors: candidate.authors,
        year: candidate.year,
        bindings: [],
        retention: "pinned",
      },
    })),
    moveBoardNode: vi.fn(async (
      nodeID: string,
      geometry: Record<string, number>,
    ) => {
      const text = textNodes.get(nodeID);
      if (text) {
        const updated = boardTextNodeView(
          nodeID,
          { ...text.node.geometry, ...geometry },
          text.blocks,
        );
        textNodes.set(nodeID, updated);
        return updated;
      }
      const itemKey = nodeID === "node-2" ? "P2" : "P1";
      return boardNodeView(nodeID, itemKey, geometry);
    }),
    addBoardTextNode: vi.fn(async (geometry: Record<string, number>) => {
      const view = boardTextNodeView(
        `node-${++nextBoardNode}`,
        geometry,
        [{
          id: `block-${++nextBoardBlock}`,
          kind: "text",
          text: "",
        }],
      );
      textNodes.set(view.node.id, view);
      return view;
    }),
    updateBoardTextBlock: vi.fn(async (
      nodeID: string,
      blockID: string,
      text: string,
    ) => {
      const current = textNodes.get(nodeID);
      const blocks = current.blocks.map((entry: any) => ({
        ...entry,
        block: entry.block.id === blockID
          ? { ...entry.block, text }
          : entry.block,
      }));
      const updated = boardTextNodeView(
        nodeID,
        current.node.geometry,
        blocks,
      );
      textNodes.set(nodeID, updated);
      return updated;
    }),
    embedBoardPaper: vi.fn(async (nodeID: string, itemKey: string) => {
      const current = textNodes.get(nodeID);
      const blocks = [...current.blocks, {
        block: {
          id: `block-${++nextBoardBlock}`,
          kind: "paper",
          paperID: `paper-${itemKey}`,
        },
        paper: {
          id: `paper-${itemKey}`,
          title: itemKey === "P1" ? "First Paper" : "Second Paper",
          authors: ["Tester"],
          year: "2026",
          bindings: [{ library: "library", itemKey }],
        },
        itemKey,
      }];
      const updated = boardTextNodeView(
        nodeID,
        current.node.geometry,
        blocks,
      );
      textNodes.set(nodeID, updated);
      return updated;
    }),
    deleteBoardBlock: vi.fn(async (nodeID: string, blockID: string) => {
      const current = textNodes.get(nodeID);
      const updated = boardTextNodeView(
        nodeID,
        current.node.geometry,
        current.blocks.filter((entry: any) => entry.block.id !== blockID),
      );
      textNodes.set(nodeID, updated);
      return updated;
    }),
    addBoardEdge: vi.fn(async (
      sourceNodeID: string,
      targetNodeID: string,
    ) => ({
      id: `edge-${++nextBoardEdge}`,
      projectID: "project-1",
      boardID: "board-1",
      kind: "manual",
      sourceNodeID,
      targetNodeID,
      createdAt: 1,
      updatedAt: 1,
    })),
    deleteBoardNode: vi.fn(async (nodeID: string) => ({
      id: nodeID,
      deletedEdgeIDs: [],
    })),
    deleteBoardEdge: vi.fn(async (edgeID: string) => ({ id: edgeID })),
    collectionSnapshot: async (scope: any) =>
      collection(scope.libraryID, scope.name),
    snapshot: async (itemKey: string) =>
      snapshot(itemKey, itemKey === "P1" ? "First Paper" : "Second Paper"),
    // A cache hit is the default these tests are written against: opening a paper
    // only reaches the providers when the probe reports a miss, and the cases that
    // care about a miss override this.
    snapshotStatus: async () => ({ loaded: true }),
    focusedGraph: async (itemKey: string, scope: any) =>
      graph(scope.libraryID, itemKey),
    graphLayout: async () => ({}),
    saveGraphLayout: async () => undefined,
    graphSettings: async () => ({}),
    saveGraphSettings: async () => undefined,
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

describe("Unizero Home async ownership and Board interaction", () => {
  it("opens a Collection node in the shared split detail view", async () => {
    const harness = createHarness();
    await flush();
    expect(harness.explorer.project.project.id).toBe("project-1");
    expect(harness.win.document.getElementById("explorer-workspace")?.dataset)
      .toMatchObject({
        projectId: "project-1",
        boardId: "board-1",
      });
    await harness.explorer.showCollectionPreview("P1");

    expect(harness.explorer.mode).toBe("split");
    expect(harness.win.document.getElementById("collection-view")?.hidden)
      .toBe(false);
    expect(harness.win.document.getElementById("detail-view")?.hidden)
      .toBe(false);
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("row-of-P1");
    expect(harness.win.document.getElementById("explorer-workspace")
      ?.classList.contains("split-mode")).toBe(true);
    expect(harness.explorer.tabs).toHaveLength(0);
    expect(harness.explorer.activeTab).toBe(-1);
    expect(harness.explorer.collectionPreview.itemKey).toBe("P1");
    harness.win.close();
  });

  it("creates duplicate Board cards from Collection papers and persists movement", async () => {
    const harness = createHarness();
    await flush();
    const surface = harness.win.document.getElementById("project-board-surface")!;
    const drop = async (itemKey: string, x: number, y: number) => {
      await harness.explorer.dropPaperOnBoard({
        preventDefault: () => undefined,
        clientX: x,
        clientY: y,
        dataTransfer: {
          getData: (type: string) =>
            type === "application/x-unizero-paper" ? itemKey : "",
        },
      });
    };

    await drop("P1", 300, 240);
    await drop("P1", 560, 420);

    expect((harness.api.addBoardNode as any).mock.calls).toHaveLength(2);
    expect(harness.explorer.project.nodes).toHaveLength(2);
    expect(surface.querySelectorAll(".board-paper-node")).toHaveLength(2);
    expect([...surface.querySelectorAll(".board-node-title")]
      .map((element) => element.textContent))
      .toEqual(["First Paper", "First Paper"]);

    const firstView = harness.explorer.project.nodes[0];
    const firstCard = surface.querySelector(
      `[data-node-id="${firstView.node.id}"]`,
    );
    harness.explorer.startBoardNodeDrag({
      button: 0,
      preventDefault: () => undefined,
      clientX: 100,
      clientY: 100,
    }, firstView, firstCard);
    harness.explorer.moveBoardNodeDrag({ clientX: 150, clientY: 135 });
    await harness.explorer.finishBoardNodeDrag();

    expect(harness.api.moveBoardNode).toHaveBeenCalledWith(
      firstView.node.id,
      expect.objectContaining({
        x: firstView.node.geometry.x,
        y: firstView.node.geometry.y,
      }),
      expect.any(Object),
    );

    harness.win.dispatchEvent(new harness.win.KeyboardEvent("keydown", {
      key: "Backspace",
    }));
    await flush();
    expect(harness.api.deleteBoardNode).toHaveBeenCalledWith(
      "node-2",
      expect.any(Object),
    );
    expect(harness.explorer.project.nodes).toHaveLength(1);
    expect(surface.querySelectorAll(".board-paper-node")).toHaveLength(1);
    expect(harness.explorer.mode).toBe("collection");
    harness.win.close();
  });

  it("pins a Detail discovery on the Board without importing it into Zotero", async () => {
    const harness = createHarness();
    await flush();
    const candidate = {
      identifiers: { DOI: "10.1000/discovery" },
      title: "External discovery",
      authors: ["Outside Author"],
      year: "2025",
      membership: { inLibrary: false, libraryID: 1 },
    };

    await harness.explorer.dropPaperOnBoard({
      preventDefault: () => undefined,
      clientX: 420,
      clientY: 300,
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-unizero-literature-candidate"
            ? JSON.stringify(candidate)
            : (type === "text/plain" ? candidate.title : ""),
      },
    });

    expect(harness.api.addBoardCandidate).toHaveBeenCalledWith(
      candidate,
      expect.objectContaining({ width: 228, height: 118 }),
      expect.any(Object),
    );
    expect(harness.api.addBoardNode).not.toHaveBeenCalled();
    expect(harness.explorer.project.nodes[0].paper.retention).toBe("pinned");
    expect(harness.explorer.project.nodes[0].itemKey).toBeUndefined();
    expect(harness.win.document.querySelector(".board-node-title")?.textContent)
      .toBe("External discovery");
    harness.win.close();
  });

  it("opens a Board-pinned external paper and offers to fetch its references", async () => {
    const fetched = vi.fn(async () =>
      snapshot("paper:paper-external", "External discovery"));
    const harness = createHarness({
      snapshotStatus: async () => ({ loaded: false }),
      snapshot: fetched,
    });
    await flush();

    await harness.explorer.dropPaperOnBoard({
      preventDefault: () => undefined,
      clientX: 420,
      clientY: 300,
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-unizero-literature-candidate"
            ? JSON.stringify({
                identifiers: { DOI: "10.1000/discovery" },
                title: "External discovery",
                authors: ["Outside Author"],
                membership: { inLibrary: false, libraryID: 1 },
              })
            : "",
      },
    });
    await flush();

    // The card has no Zotero item, so Detail names it by its catalog Paper ID.
    expect(harness.explorer.activeItemKey).toBe("paper:paper-external");
    expect(harness.win.document.getElementById("paper-title")?.textContent)
      .toBe("External discovery");
    // Relation and Graph read library topology and have nothing to say here.
    expect(harness.win.document.getElementById("tab-relation")?.hidden).toBe(true);
    expect(harness.win.document.getElementById("tab-graph")?.hidden).toBe(true);
    expect(harness.win.document.getElementById("tab-references")?.hidden)
      .toBe(false);

    expect(fetched).not.toHaveBeenCalled();
    const prompt = harness.win.document
      .querySelector("#rows .fetch-now") as HTMLButtonElement;
    prompt.click();
    await flush();
    await flush();

    expect(fetched).toHaveBeenCalledWith(
      "paper:paper-external",
      "references",
      true,
      1,
    );
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("row-of-paper:paper-external");
    harness.win.close();
  });

  it("reuses a cached external snapshot instead of fetching it again", async () => {
    const fetched = vi.fn(async () =>
      snapshot("paper:paper-external", "External discovery"));
    const harness = createHarness({
      snapshotStatus: async () => ({ loaded: true }),
      snapshot: fetched,
    });
    await flush();

    await harness.explorer.dropPaperOnBoard({
      preventDefault: () => undefined,
      clientX: 420,
      clientY: 300,
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-unizero-literature-candidate"
            ? JSON.stringify({
                identifiers: { DOI: "10.1000/discovery" },
                title: "External discovery",
                authors: ["Outside Author"],
                membership: { inLibrary: false, libraryID: 1 },
              })
            : "",
      },
    });
    await flush();

    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched).toHaveBeenCalledWith(
      "paper:paper-external",
      "references",
      false,
      1,
    );

    // Reselecting the same card is a redraw from the window's snapshot cache.
    await harness.explorer.showCollectionPreview("P1");
    await flush();
    harness.explorer.selectBoardNode(harness.explorer.project.nodes[0]);
    await flush();

    const externalCalls = fetched.mock.calls
      .filter(([key]) => key === "paper:paper-external");
    expect(externalCalls).toHaveLength(1);
    expect(harness.explorer.activeItemKey).toBe("paper:paper-external");
    harness.win.close();
  });

  it("shows derived relation hints for every Board instance without saving edges", async () => {
    const harness = createHarness();
    await flush();
    const drop = async (itemKey: string, x: number, y: number) => {
      await harness.explorer.dropPaperOnBoard({
        preventDefault: () => undefined,
        clientX: x,
        clientY: y,
        dataTransfer: {
          getData: (type: string) =>
            type === "application/x-unizero-paper" ? itemKey : "",
        },
      });
    };
    await drop("P1", 280, 220);
    await drop("P1", 520, 220);
    await harness.explorer.dropPaperOnBoard({
      preventDefault: () => undefined,
      clientX: 760,
      clientY: 420,
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-unizero-literature-candidate"
            ? JSON.stringify({
                identifiers: { DOI: "10.1000/external" },
                title: "External discovery",
                authors: ["Outside Author"],
                membership: { inLibrary: false, libraryID: 1 },
              })
            : "",
      },
    });
    harness.explorer.project.relationHints = [{
      sourcePaperID: "paper-P1",
      targetPaperID: "paper-external",
      type: "cites",
    }];
    harness.explorer.renderProjectBoard();

    const externalCard = harness.win.document.querySelector(
      `[data-node-id="${harness.explorer.project.nodes[2].node.id}"]`,
    );
    externalCard?.dispatchEvent(new harness.win.MouseEvent("mouseenter"));

    expect(harness.win.document.querySelectorAll(".relation-focus"))
      .toHaveLength(1);
    expect(harness.win.document.querySelectorAll(".relation-related"))
      .toHaveLength(2);
    expect(harness.win.document.querySelectorAll(".board-relation-hint-edge"))
      .toHaveLength(2);
    expect(harness.explorer.project.edges).toHaveLength(0);
    expect(harness.api.addBoardEdge).not.toHaveBeenCalled();

    harness.explorer.clearBoardRelationHints();
    expect(harness.win.document.querySelectorAll(".board-relation-hint-edge"))
      .toHaveLength(0);
    harness.win.close();
  });

  it("creates, selects, and deletes a manual Board connection", async () => {
    const harness = createHarness();
    await flush();
    const drop = async (itemKey: string, x: number, y: number) => {
      await harness.explorer.dropPaperOnBoard({
        preventDefault: () => undefined,
        clientX: x,
        clientY: y,
        dataTransfer: {
          getData: (type: string) =>
            type === "application/x-unizero-paper" ? itemKey : "",
        },
      });
    };

    await drop("P1", 300, 240);
    await drop("P2", 620, 440);
    const [first, second] = harness.explorer.project.nodes;
    harness.explorer.selectBoardNode(first);
    harness.explorer.toggleBoardConnect();
    harness.explorer.selectBoardNode(second);
    await flush();

    expect(harness.api.addBoardEdge).toHaveBeenCalledWith(
      first.node.id,
      second.node.id,
      expect.any(Object),
    );
    expect(harness.explorer.project.edges).toHaveLength(1);
    expect(harness.win.document.querySelectorAll(".board-manual-edge"))
      .toHaveLength(1);

    harness.explorer.selectBoardEdge(harness.explorer.project.edges[0]);
    harness.win.dispatchEvent(new harness.win.KeyboardEvent("keydown", {
      key: "Delete",
    }));
    await flush();

    expect(harness.api.deleteBoardEdge).toHaveBeenCalledWith(
      "edge-1",
      expect.any(Object),
    );
    expect(harness.explorer.project.edges).toHaveLength(0);
    expect(harness.win.document.querySelectorAll(".board-manual-edge"))
      .toHaveLength(0);
    harness.win.close();
  });

  it("creates a connection by dragging a node handle onto another card", async () => {
    const harness = createHarness();
    await flush();
    const drop = async (itemKey: string, x: number, y: number) => {
      await harness.explorer.dropPaperOnBoard({
        preventDefault: () => undefined,
        clientX: x,
        clientY: y,
        dataTransfer: {
          getData: (type: string) =>
            type === "application/x-unizero-paper" ? itemKey : "",
        },
      });
    };
    await drop("P1", 300, 240);
    await drop("P2", 620, 440);
    const [source, target] = harness.explorer.project.nodes;
    const targetCard = harness.win.document.querySelector(
      `[data-node-id="${target.node.id}"]`,
    );

    harness.explorer.startBoardConnection({
      button: 0,
      pointerId: 7,
      preventDefault: () => undefined,
    }, source, "right");
    expect(harness.win.document.querySelector(".board-connection-preview"))
      .not.toBeNull();

    harness.explorer.moveBoardPointer({
      pointerId: 7,
      clientX: 620,
      clientY: 440,
      target: targetCard,
    });
    expect(targetCard?.classList.contains("connection-target")).toBe(true);
    await harness.explorer.finishBoardPointer({
      pointerId: 7,
      target: targetCard,
    });

    expect(harness.api.addBoardEdge).toHaveBeenCalledWith(
      source.node.id,
      target.node.id,
      expect.any(Object),
    );
    const edge = harness.win.document.querySelector(".board-manual-edge");
    expect(edge?.tagName.toLowerCase()).toBe("path");
    expect(edge?.getAttribute("d")).toContain(" C ");
    expect(harness.win.document.querySelector(".board-connection-preview"))
      .toBeNull();
    harness.win.close();
  });

  it("zooms around the pointer, pans the camera, and clears selection on blank click", async () => {
    const harness = createHarness();
    await flush();
    const surface = harness.win.document.getElementById("project-board-surface")!;
    harness.explorer.boardCamera = { x: 10, y: 20, scale: 1 };
    harness.explorer.applyBoardCamera();
    harness.explorer.zoomBoard(2, { x: 100, y: 100 });

    expect(harness.explorer.boardCamera).toEqual({
      x: -80,
      y: -60,
      scale: 2,
    });
    expect(harness.win.document.getElementById("board-zoom-fit")?.textContent)
      .toBe("200%");

    harness.explorer.startBoardPan({
      button: 0,
      pointerId: 9,
      preventDefault: () => undefined,
      clientX: 100,
      clientY: 100,
      target: surface,
    });
    harness.explorer.moveBoardPointer({
      pointerId: 9,
      clientX: 130,
      clientY: 140,
      target: surface,
    });
    await harness.explorer.finishBoardPointer({
      pointerId: 9,
      target: surface,
    });
    expect(harness.explorer.boardCamera).toEqual({
      x: -50,
      y: -20,
      scale: 2,
    });

    harness.explorer.boardSelectedNodeID = "node-1";
    harness.explorer.startBoardPan({
      button: 0,
      pointerId: 10,
      preventDefault: () => undefined,
      clientX: 100,
      clientY: 100,
      target: surface,
    });
    await harness.explorer.finishBoardPointer({
      pointerId: 10,
      target: surface,
    });
    expect(harness.explorer.boardSelectedNodeID).toBeNull();
    harness.win.close();
  });

  it("treats line-mode wheel deltas as a usable pan and zoom", async () => {
    const harness = createHarness();
    await flush();
    const surface = harness.win.document.getElementById("project-board-surface")!;
    harness.explorer.boardCamera = { x: 0, y: 0, scale: 1 };

    // Firefox reports DOM_DELTA_LINE on several platforms, where deltaY is ~3.
    harness.explorer.handleBoardWheel({
      preventDefault: () => undefined,
      deltaMode: 1,
      deltaX: 0,
      deltaY: 3,
      target: surface,
    });
    // Read as pixels this would move the Board 3px, which reads as broken.
    expect(harness.explorer.boardCamera.y).toBe(-48);

    harness.explorer.boardCamera = { x: 0, y: 0, scale: 1 };
    harness.explorer.handleBoardWheel({
      preventDefault: () => undefined,
      ctrlKey: true,
      deltaMode: 1,
      deltaX: 0,
      deltaY: -3,
      clientX: 0,
      clientY: 0,
      target: surface,
    });
    expect(harness.explorer.boardCamera.scale).toBeGreaterThan(1.05);

    // Pixel mode must keep behaving exactly as before.
    harness.explorer.boardCamera = { x: 0, y: 0, scale: 1 };
    harness.explorer.handleBoardWheel({
      preventDefault: () => undefined,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 48,
      target: surface,
    });
    expect(harness.explorer.boardCamera.y).toBe(-48);
    harness.win.close();
  });

  it("moves Board nodes in world coordinates at a non-default zoom", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.dropPaperOnBoard({
      preventDefault: () => undefined,
      clientX: 300,
      clientY: 240,
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-unizero-paper" ? "P1" : "",
      },
    });
    const view = harness.explorer.project.nodes[0];
    const startX = view.node.geometry.x;
    const startY = view.node.geometry.y;
    const card = harness.win.document.querySelector(
      `[data-node-id="${view.node.id}"]`,
    );
    harness.explorer.boardCamera = { x: 0, y: 0, scale: 2 };

    harness.explorer.startBoardNodeDrag({
      button: 0,
      pointerId: 12,
      preventDefault: () => undefined,
      clientX: 100,
      clientY: 100,
    }, view, card);
    harness.explorer.moveBoardPointer({
      pointerId: 12,
      clientX: 140,
      clientY: 120,
      target: card,
    });
    await harness.explorer.finishBoardPointer({
      pointerId: 12,
      target: card,
    });

    expect(harness.api.moveBoardNode).toHaveBeenCalledWith(
      view.node.id,
      expect.objectContaining({
        x: startX + 20,
        y: startY + 10,
      }),
      expect.any(Object),
    );
    harness.win.close();
  });

  it("resizes Board nodes in world coordinates and persists geometry", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.dropPaperOnBoard({
      preventDefault: () => undefined,
      clientX: 300,
      clientY: 240,
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-unizero-paper" ? "P1" : "",
      },
    });
    const view = harness.explorer.project.nodes[0];
    const card = harness.win.document.querySelector(
      `[data-node-id="${view.node.id}"]`,
    ) as HTMLElement;
    harness.explorer.boardCamera = { x: 0, y: 0, scale: 2 };

    harness.explorer.startBoardNodeResize({
      button: 0,
      pointerId: 14,
      preventDefault: () => undefined,
      clientX: 100,
      clientY: 100,
    }, view, card);
    harness.explorer.moveBoardPointer({
      pointerId: 14,
      clientX: 180,
      clientY: 140,
      target: card,
    });

    expect(card?.style.width).toBe("268px");
    expect(card?.style.height).toBe("138px");
    await harness.explorer.finishBoardPointer({
      pointerId: 14,
      target: card,
    });

    expect(harness.api.moveBoardNode).toHaveBeenCalledWith(
      view.node.id,
      expect.objectContaining({
        width: 268,
        height: 138,
      }),
      expect.any(Object),
    );
    expect(harness.win.document.querySelector(
      `[data-node-id="${view.node.id}"]`,
    )?.classList.contains("selected")).toBe(true);
    harness.win.close();
  });

  it("creates an editable Text Node and embeds a Collection paper as a block", async () => {
    const harness = createHarness();
    await flush();

    await harness.explorer.createBoardTextNode();
    expect(harness.api.addBoardTextNode).toHaveBeenCalledWith(
      expect.objectContaining({ width: 320, height: 240 }),
      expect.any(Object),
    );
    expect(harness.explorer.project.nodes).toHaveLength(1);
    expect(harness.explorer.project.nodes[0].node.kind).toBe("text");
    const editor = harness.win.document.querySelector(
      ".board-text-editor",
    ) as HTMLTextAreaElement;
    expect(editor).not.toBeNull();

    editor.value = "Paper as a reusable content block";
    editor.dispatchEvent(new harness.win.Event("input"));
    editor.dispatchEvent(new harness.win.Event("blur"));
    await flush();
    expect(harness.api.updateBoardTextBlock).toHaveBeenCalledWith(
      "node-1",
      "block-1",
      "Paper as a reusable content block",
      expect.any(Object),
    );

    await harness.explorer.dropPaperInTextNode({
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-unizero-paper" ? "P1" : "",
      },
    }, harness.explorer.project.nodes[0]);
    expect(harness.api.embedBoardPaper).toHaveBeenCalledWith(
      "node-1",
      "P1",
      expect.any(Object),
    );
    expect(harness.win.document.querySelector(
      ".board-embedded-paper-title",
    )?.textContent).toBe("First Paper");

    const current = harness.explorer.project.nodes[0];
    const paperBlock = current.blocks.find(
      (entry: any) => entry.block.kind === "paper",
    );
    await harness.explorer.deleteBoardContentBlock(
      current,
      paperBlock.block.id,
    );
    expect(harness.api.deleteBoardBlock).toHaveBeenCalledWith(
      "node-1",
      paperBlock.block.id,
      expect.any(Object),
    );
    expect(harness.win.document.querySelector(".board-embedded-paper")).toBeNull();
    harness.win.close();
  });

  it("keeps a focused Text Node editor alive across a Collection re-render", async () => {
    const harness = createHarness();
    await flush();

    await harness.explorer.createBoardTextNode();
    await flush();
    const editor = harness.win.document.querySelector(
      ".board-text-editor",
    ) as HTMLTextAreaElement;
    editor.focus();
    editor.value = "half-typed";
    editor.dispatchEvent(new harness.win.Event("input"));

    // A background status refresh, a search keystroke, or a Zotero change all
    // land here. None of them may take the caret away mid-sentence.
    harness.explorer.renderCollection();
    harness.explorer.renderProjectBoard();

    const after = harness.win.document.querySelector(
      ".board-text-editor",
    ) as HTMLTextAreaElement;
    expect(after).toBe(editor);
    expect(harness.win.document.activeElement).toBe(editor);
    expect(after.value).toBe("half-typed");

    // Blur releases the deferral and the rebuild happens then.
    editor.blur();
    await flush();
    expect(harness.explorer._boardRenderDeferred).toBe(false);
    harness.win.close();
  });

  it("does not detach the dragged card when a re-render lands mid-gesture", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.dropPaperOnBoard({
      preventDefault: () => undefined,
      clientX: 300,
      clientY: 240,
      dataTransfer: {
        getData: (type: string) =>
          type === "application/x-unizero-paper" ? "P1" : "",
      },
    });
    const view = harness.explorer.project.nodes[0];
    const startX = view.node.geometry.x;
    const startY = view.node.geometry.y;
    const card = harness.win.document.querySelector(
      `[data-node-id="${view.node.id}"]`,
    );

    harness.explorer.startBoardNodeDrag({
      button: 0,
      pointerId: 21,
      preventDefault: () => undefined,
      clientX: 100,
      clientY: 100,
    }, view, card);
    harness.explorer.moveBoardPointer({
      pointerId: 21,
      clientX: 140,
      clientY: 120,
      target: card,
    });

    // A background status refresh lands mid-drag.
    harness.explorer.renderCollection();
    harness.explorer.renderProjectBoard();

    // The element the gesture is still writing to must remain the live one,
    // otherwise the card stops moving while its geometry keeps changing.
    expect(harness.win.document.querySelector(
      `[data-node-id="${view.node.id}"]`,
    )).toBe(card);
    expect(harness.explorer._boardRenderDeferred).toBe(true);

    await harness.explorer.finishBoardPointer({ pointerId: 21, target: card });
    expect(harness.api.moveBoardNode).toHaveBeenCalledWith(
      view.node.id,
      expect.objectContaining({ x: startX + 40, y: startY + 20 }),
      expect.any(Object),
    );
    expect(harness.explorer._boardRenderDeferred).toBe(false);
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

  it("reuses completed snapshots when a Collection preview returns A → B → A", async () => {
    const readSnapshot = vi.fn(async (itemKey: string) =>
      snapshot(itemKey, itemKey === "P1" ? "First Paper" : "Second Paper"));
    const harness = createHarness({ snapshot: readSnapshot });
    await flush();

    await harness.explorer.showCollectionPreview("P1");
    await harness.explorer.showCollectionPreview("P2");
    await harness.explorer.showCollectionPreview("P1");

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(readSnapshot.mock.calls.map((call) => call[0]))
      .toEqual(["P1", "P2"]);
    expect(harness.explorer.collectionPreview.itemKey).toBe("P1");
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("row-of-P1");
    harness.win.close();
  });

  it("keeps provider progress hidden while reading a known disk cache hit", async () => {
    const pending = deferred<any>();
    const snapshotStatus = vi.fn(async () => ({ loaded: true }));
    const harness = createHarness({
      snapshotStatus,
      snapshot: () => pending.promise,
    });
    await flush();

    const opening = harness.explorer.showCollectionPreview("P1");
    await flush();

    expect(snapshotStatus).toHaveBeenCalledWith("P1", "references", 1);
    expect(harness.win.document.getElementById("status")?.textContent)
      .toBe("readingCache");
    expect(harness.win.document.getElementById("progress")?.hidden).toBe(true);

    pending.resolve(snapshot("P1", "First Paper"));
    await opening;
    harness.win.close();
  });

  it("offers to fetch instead of calling providers when the probe confirms a miss", async () => {
    const fetched = vi.fn(async () => snapshot("P1", "First Paper"));
    const harness = createHarness({
      snapshotStatus: async () => ({ loaded: false }),
      snapshot: fetched,
    });
    await flush();

    await harness.explorer.showCollectionPreview("P1");
    await flush();

    expect(fetched).not.toHaveBeenCalled();
    expect(harness.win.document.getElementById("status")?.textContent)
      .toBe("notCached");
    expect(harness.win.document.getElementById("progress")?.hidden).toBe(true);
    expect(harness.explorer.activeTabState().needsFetch).toBe(true);
    harness.win.close();
  });

  it("reaches the providers, with progress, once the fetch prompt is clicked", async () => {
    const pending = deferred<any>();
    const harness = createHarness({
      snapshotStatus: async () => ({ loaded: false }),
      snapshot: () => pending.promise,
    });
    await flush();

    await harness.explorer.showCollectionPreview("P1");
    await flush();

    const prompt = harness.win.document
      .querySelector("#rows .fetch-now") as HTMLButtonElement;
    expect(prompt?.textContent).toBe("fetchNow");
    prompt.click();
    await flush();

    expect(harness.win.document.getElementById("status")?.textContent)
      .toBe("loading");
    expect(harness.win.document.getElementById("progress")?.hidden).toBe(false);

    pending.resolve(snapshot("P1", "First Paper"));
    await flush();
    expect(harness.win.document.getElementById("progress")?.hidden).toBe(true);
    expect(harness.explorer.activeTabState().needsFetch).toBe(false);
    harness.win.close();
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

    await harness.explorer.showCollectionPreview("P1");
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
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("fail to fetch");

    retry.click();
    await flush();
    await flush();

    expect(fetched).toHaveBeenCalledTimes(2);
    expect(harness.explorer.activeTabState().error).toBe("");
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("row-of-P1");
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

  it("keeps paper selection when Detail View is collapsed", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showCollectionPreview("P1");
    expect(harness.explorer.mode).toBe("split");
    expect(harness.win.document.getElementById("detail-view")?.hidden)
      .toBe(false);

    harness.explorer.collapseDetailPane();

    expect(harness.explorer.detailCollapsed).toBe(true);
    expect(harness.explorer.collectionPreview.itemKey).toBe("P1");
    expect(harness.win.document.getElementById("detail-view")?.hidden)
      .toBe(true);
    expect(harness.win.document.getElementById("collection-view")?.hidden)
      .toBe(false);
    expect(harness.win.document.getElementById("explorer-workspace")
      ?.classList.contains("split-mode")).toBe(false);
    expect(harness.win.document.getElementById("toggle-detail-pane")?.hidden)
      .toBe(false);
    expect(harness.win.document.getElementById("toggle-detail-pane")?.textContent)
      .toBe("◀");
    harness.win.close();
  });

  it("does not auto-open Detail View while it is collapsed", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showCollectionPreview("P1");
    harness.explorer.collapseDetailPane();

    await harness.explorer.showCollectionPreview("P2");

    expect(harness.explorer.detailCollapsed).toBe(true);
    expect(harness.explorer.collectionPreview.itemKey).toBe("P2");
    expect(harness.win.document.getElementById("detail-view")?.hidden)
      .toBe(true);
    expect(harness.win.document.getElementById("collection-view")?.hidden)
      .toBe(false);
    harness.win.close();
  });

  it("restores the current selection when Detail View is expanded", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showCollectionPreview("P1");
    harness.explorer.collapseDetailPane();
    await harness.explorer.showCollectionPreview("P2");

    harness.explorer.expandDetailPane();
    await flush();

    expect(harness.explorer.detailCollapsed).toBe(false);
    expect(harness.explorer.mode).toBe("split");
    expect(harness.explorer.collectionPreview.itemKey).toBe("P2");
    expect(harness.win.document.getElementById("detail-view")?.hidden)
      .toBe(false);
    expect(harness.win.document.getElementById("rows")?.textContent)
      .toContain("row-of-P2");
    harness.win.close();
  });

  it("keeps the Detail dock collapsed across Open paper tabs", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showCollectionPreview("P1");
    harness.explorer.collapseDetailPane();

    await harness.explorer.showDetail("P1", "references");

    expect(harness.explorer.detailCollapsed).toBe(true);
    expect(harness.explorer.tabs).toHaveLength(1);
    expect(harness.win.document.getElementById("detail-view")?.hidden)
      .toBe(true);
    expect(harness.win.document.getElementById("collection-view")?.hidden)
      .toBe(false);
    harness.win.close();
  });

  it("exposes a permanent Detail dock toggle on the Board", async () => {
    const harness = createHarness();
    await flush();

    const toggle = harness.win.document.getElementById("toggle-detail-pane");
    expect(toggle?.hidden).toBe(false);
    expect(toggle?.textContent).toBe("▶");

    harness.explorer.collapseDetailPane();
    expect(toggle?.textContent).toBe("◀");

    harness.explorer.expandDetailPane();
    expect(toggle?.textContent).toBe("▶");
    harness.win.close();
  });

  it("keeps all source states visible when every reference source is empty", async () => {
    const harness = createHarness({
      snapshot: async (itemKey: string) =>
        emptyReferenceSnapshot(itemKey, "First Paper"),
    });
    await flush();

    await harness.explorer.showDetail("P1", "references");

    expect(harness.explorer.activeTabState().snapshot.sources).toHaveLength(3);
    expect(harness.explorer.sourceOptionLabel({
      name: "Semantic Scholar",
      status: "unavailable",
    })).toBe("Semantic Scholar · restricted");
    expect(harness.win.document.getElementById("filter-source")
      ?.closest(".filter-field")?.hidden).toBe(false);
    expect(harness.win.document.getElementById("status")?.textContent)
      .toContain("OA 0 / CR 0 / S2 ⚠");
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
    expect(harness.explorer.project.project.id).toBe("project-2");
    expect(harness.win.document.getElementById("explorer-workspace")?.dataset)
      .toMatchObject({
        projectId: "project-2",
        boardId: "board-2",
      });
    expect(harness.win.document.getElementById("paper-title")?.textContent)
      .toBe("Library B");
    harness.win.close();
  });

  it("does not save a settled Library A layout after reloading to Library B", async () => {
    const saveGraphLayout = vi.fn(async () => undefined);
    const harness = createHarness({ saveGraphLayout });
    await flush();
    await harness.explorer.showDetail("P1", "graph");
    const oldView = harness.explorer.graphs.detail;
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

  it("stores graph filters per paper instead of sharing one set", async () => {
    const harness = createHarness();
    await flush();
    await harness.explorer.showDetail("P1", "graph");
    harness.explorer.tabs[0].graphFilters = { links: "cites", minShared: 2 };
    await harness.explorer.activateTab(-1);
    await harness.explorer.showDetail("P2", "graph");
    harness.explorer.tabs[1].graphFilters = { links: "coupled", minShared: 4 };
    await harness.explorer.activateTab(0);

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

    harness.explorer.buildGraphPanel("detail");
    const panel = harness.win.document.getElementById("detail-graph-panel")!;
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

  it("offers exactly one Markdown link-change action, and only when one exists",
    async () => {
      const harness = createHarness({
        openMarkdown: async () => undefined,
        editMarkdownLink: async () => undefined,
      });
      await flush();

      // The node menu is the only surface left that can correct an Obsidian
      // binding, so losing this entry silently strands every existing link.
      harness.explorer.showGraphMenu("detail", {
        itemKey: "P1",
        title: "First Paper",
        hasMarkdown: true,
      }, null);
      const menu = harness.win.document.getElementById("graph-menu")!;
      const relink = Array.from(menu.querySelectorAll("button"))
        .filter((button) => button.textContent === "markdownRelink");
      expect(relink).toHaveLength(1);
      expect(relink[0].disabled).toBe(false);

      // Nothing to relink before a conversion has produced an attachment.
      harness.explorer.showGraphMenu("detail", {
        itemKey: "P2",
        title: "Second Paper",
        hasMarkdown: false,
        hasPDF: true,
      }, null);
      expect(Array.from(menu.querySelectorAll("button"))
        .filter((button) => button.textContent === "markdownRelink")).toHaveLength(0);
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

  it("rebuilds only the visible graph after references change", async () => {
    const relation = deferred<any>();
    const graphCalls = vi.fn(async (itemKey: string, scope: any) =>
      graph(scope.libraryID, itemKey));
    const harness = createHarness({
      focusedGraph: graphCalls,
      loadRelation: () => relation.promise,
    });
    await flush();
    await harness.explorer.showDetail("P1", "graph");
    const before = graphCalls.mock.calls.length;

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
    // New references change the topology, so the cached graph is dropped. The tab
    // the user is looking at then rebuilds once — not once per cached graph.
    expect(graphCalls).toHaveBeenCalledTimes(before + 1);
    harness.win.close();
  });

  it("patches Markdown metadata without rebuilding topology", async () => {
    const graphCalls = vi.fn(async (itemKey: string, scope: any) =>
      graph(scope.libraryID, itemKey));
    const harness = createHarness({ focusedGraph: graphCalls });
    await flush();
    await harness.explorer.showDetail("P1", "graph");
    const before = graphCalls.mock.calls.length;

    await harness.explorer.runGraphAction(
      "P1",
      async () => ({ title: "Converted Paper", hasMarkdown: true }),
      "metadata",
    );

    expect(graphCalls).toHaveBeenCalledTimes(before);
    expect(harness.explorer.graphData.detail.nodes[0]).toMatchObject({
      title: "Converted Paper",
      hasMarkdown: true,
    });
    harness.win.close();
  });

  it("updates citation status without invalidating the cached graph", async () => {
    const graphCalls = vi.fn(async (itemKey: string, scope: any) =>
      graph(scope.libraryID, itemKey));
    const harness = createHarness({ focusedGraph: graphCalls });
    await flush();
    await harness.explorer.showDetail("P1", "graph");
    const cached = harness.explorer.graphData.detail;
    const before = graphCalls.mock.calls.length;

    await harness.explorer.runGraphAction(
      "P1",
      async () => ({ citations: { loaded: true, count: 7, total: 7 } }),
      "citations",
    );

    // Citations do not feed the topology, so the graph must survive untouched.
    expect(graphCalls).toHaveBeenCalledTimes(before);
    expect(harness.explorer.graphData.detail).toBe(cached);
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
    expect(harness.explorer.graphs).toEqual({ detail: null });
    expect(harness.explorer._refitTimers || {}).toEqual({});
    harness.win.close();
  });
});
