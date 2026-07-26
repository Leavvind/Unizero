import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const rendererPath = new URL(
  "../addon/chrome/content/literature-graph.js",
  import.meta.url,
);
const rendererSource = readFileSync(rendererPath, "utf8");

function loadRenderer() {
  const win = new Window({ url: "http://localhost/" });
  win.document.body.innerHTML = '<div id="graph"></div>';
  win.eval(`${rendererSource}\nwindow.__testGraph = LiteratureGraph;`);
  return {
    win,
    renderer: (win as any).__testGraph,
  };
}

function forceGraphStub() {
  const forces = {
    link: {
      distance: vi.fn().mockReturnThis(),
      strength: vi.fn().mockReturnThis(),
    },
    charge: {
      strength: vi.fn().mockReturnThis(),
      distanceMax: vi.fn().mockReturnThis(),
    },
  } as Record<string, any>;
  let onEngineStop: (() => void) | undefined;
  let proxy: any;
  const target = {
    d3Force(name: string, value?: unknown) {
      if (arguments.length > 1) {
        forces[name] = value;
        return proxy;
      }
      return forces[name];
    },
    graphData: vi.fn(() => proxy),
    centerAt: vi.fn(() => proxy),
    onEngineStop(callback: () => void) {
      onEngineStop = callback;
      return proxy;
    },
    _engineStop: () => onEngineStop?.(),
    _destructor: vi.fn(),
  };
  proxy = new Proxy(target, {
    get(object, property) {
      if (property in object) return (object as any)[property];
      return vi.fn(() => proxy);
    },
  });
  return proxy;
}

describe("LiteratureGraph renderer facade", () => {
  it("converts the painted radius to force-graph's area-valued nodeVal", () => {
    const { win, renderer } = loadRenderer();
    const view = {
      centerId: null,
      settings: { nodeSize: 1 },
    };
    const node = { id: "1:A", degree: 49 };

    expect(renderer.drawRadius(view, node)).toBe(40);
    expect(renderer.nodeValue(view, node)).toBe(1600);
    win.close();
  });

  it("multiplexes settle listeners instead of replacing the layout saver", () => {
    const { win, renderer } = loadRenderer();
    const graph = forceGraphStub();
    (win as any).ForceGraph = () => () => graph;
    const container = win.document.getElementById("graph") as HTMLElement;
    const view = renderer.create(container, {});
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = renderer.onSettled(view, first);
    renderer.onSettled(view, second);

    graph._engineStop();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribe();
    graph._engineStop();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    renderer.destroy(view);
    win.close();
  });

  it("clears a surfaced callback error after new data installs successfully", () => {
    const { win, renderer } = loadRenderer();
    const graph = forceGraphStub();
    (win as any).ForceGraph = () => () => graph;
    const onError = vi.fn();
    const onClearError = vi.fn();
    const container = win.document.getElementById("graph") as HTMLElement;
    const view = renderer.create(container, { onError, onClearError });

    renderer.reportError(view, "paint", new Error("boom"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(view.lastError).toContain("boom");

    renderer.setData(view, {
      scope: { libraryID: 1 },
      nodes: [],
      edges: [],
    }, {});
    expect(view.lastError).toBeNull();
    expect(onClearError).toHaveBeenCalledTimes(1);
    renderer.destroy(view);
    win.close();
  });

  it("re-centres the selected node using its existing graph coordinates", () => {
    const { win, renderer } = loadRenderer();
    const graph = forceGraphStub();
    (win as any).ForceGraph = () => () => graph;
    const container = win.document.getElementById("graph") as HTMLElement;
    const view = renderer.create(container, {});
    renderer.setData(view, {
      scope: { libraryID: 1 },
      nodes: [{ id: "1:A", itemKey: "A", degree: 0 }],
      edges: [],
    }, { "1:A": [12, 34] });
    renderer.select(view, "1:A");

    renderer.centerOnSelection(view);

    expect(graph.centerAt).toHaveBeenCalledWith(12, 34, 0);
    renderer.destroy(view);
    win.close();
  });
});
