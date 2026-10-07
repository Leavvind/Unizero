import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { canvasBasename, createCanvasForPaper } from "../src/canvasCreation";

const paper = { libraryID: 2, itemKey: "ABCD1234", title: "Paper title" };

function setup(folder = "Notes") {
  const files = new Map<string, { path: string }>();
  const create = vi.fn(async (path: string, content: string) => {
    expect(JSON.parse(content)).toEqual({ nodes: [], edges: [] });
    const file = { path };
    files.set(path, file);
    return file;
  });
  const getNewFileParent = vi.fn(() => ({ path: folder }));
  const app = {
    vault: { create, getAbstractFileByPath: (path: string) => files.get(path) },
    fileManager: { getNewFileParent },
    workspace: { getActiveFile: () => ({ path: "Notes/Active.md" }) },
  } as unknown as App;
  const links = { get: () => undefined, set: vi.fn(async () => {}) };
  return { app, links, files, create, getNewFileParent };
}

describe("first-click Canvas creation", () => {
  it("creates valid empty Canvas in the configured location and saves its binding", async () => {
    const { app, links, getNewFileParent } = setup();
    const file = await createCanvasForPaper(app, paper, links);
    expect(file.path).toBe("Notes/Paper title.canvas");
    expect(getNewFileParent).toHaveBeenCalledWith("Notes/Active.md");
    expect(links.set).toHaveBeenCalledWith("2/ABCD1234", file.path);
  });

  it("preserves existing files and coalesces rapid clicks for the same paper", async () => {
    const { app, links, files, create } = setup("/");
    files.set("Paper title.canvas", { path: "Paper title.canvas" });
    files.set("Paper title (1).canvas", { path: "Paper title (1).canvas" });
    const [first, second] = await Promise.all([
      createCanvasForPaper(app, paper, links), createCanvasForPaper(app, paper, links),
    ]);
    expect(first).toBe(second);
    expect(first.path).toBe("Paper title (2).canvas");
    expect(create).toHaveBeenCalledTimes(1);
    expect(links.set).toHaveBeenCalledTimes(1);
  });

  it("does not bind failed creations and allows retry", async () => {
    const { app, links, create } = setup();
    create.mockRejectedValueOnce(new Error("Cannot write"));
    await expect(createCanvasForPaper(app, paper, links)).rejects.toThrow("Cannot write");
    expect(links.set).not.toHaveBeenCalled();
    expect((await createCanvasForPaper(app, paper, links)).path).toBe("Notes/Paper title.canvas");
  });

  it("reserves distinct paths for different papers with the same title", async () => {
    const { app, links, create } = setup();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    create.mockImplementation(async (path: string) => {
      await waiting;
      return { path };
    });
    const first = createCanvasForPaper(app, paper, links);
    const second = createCanvasForPaper(app, { ...paper, libraryID: 3 }, links);
    release();
    expect((await first).path).toBe("Notes/Paper title.canvas");
    expect((await second).path).toBe("Notes/Paper title (1).canvas");
  });

  it("sanitizes titles and bounds Unicode filename length", () => {
    expect(canvasBasename({ ...paper, title: ' A/B: C? "D". ' })).toBe("A B C D");
    expect(canvasBasename({ ...paper, title: "..." })).toBe("Paper 2-ABCD1234");
    expect(canvasBasename({ ...paper, title: "CON" })).toBe("Paper 2-ABCD1234");
    expect(canvasBasename({ ...paper, title: undefined })).toBe("Paper 2-ABCD1234");
    const longName = canvasBasename({ ...paper, title: "研究😀".repeat(100) });
    expect(new TextEncoder().encode(longName).length).toBeLessThanOrEqual(180);
    expect(longName).not.toContain("\ufffd");
  });
});
