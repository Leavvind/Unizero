import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { shell } from "electron";
import { readFile } from "fs/promises";
import type UnizeroPlugin from "../src/main";
import { openLinkTarget, openZoteroCanvas } from "../src/linkOpening";
import { parseLinkTargetForNavigation } from "../src/linkTarget";

const notices = vi.hoisted(() => vi.fn());
// Both host modules resolve to the same stub file in the test configuration.
vi.mock("obsidian", () => ({
  TFile: class {}, Notice: class { constructor(message: string) { notices(message); } },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));
vi.mock("fs/promises", () => ({ readFile: vi.fn(), stat: vi.fn() }));

function fixture() {
  const file = Object.assign(new TFile(), { path: "file:C:/Zotero/storage/RAW2/paper.md" });
  const openFile = vi.fn();
  const bridge = {
    ping: vi.fn(async () => ({ api: 2, capabilities: ["link-targets"] })),
    linkTarget: vi.fn(async () => ({ source: { path: "C:/Zotero/storage/RAW2/paper.md" } })),
  };
  const plugin = {
    bridge,
    app: { vault: { getAbstractFileByPath: vi.fn(() => file) }, workspace: { getLeaf: vi.fn(() => ({ openFile })) } },
  } as unknown as UnizeroPlugin;
  return { plugin, bridge, file, openFile };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("opening a Markdown attachment with a location", () => {
  it.each(["^", "#^", "#%5E", "#%ZZ"])("opens the explicitly selected file for incomplete %s", async (suffix) => {
    const f = fixture();
    const target = parseLinkTargetForNavigation(`unizero://paper/7/E23A232D.md?attachment=RAW2${suffix}`)!;
    await openLinkTarget(f.plugin, target);
    expect(f.bridge.linkTarget).toHaveBeenCalledWith(target, "markdown", "RAW2");
    expect(f.openFile).toHaveBeenCalledWith(f.file, undefined);
    expect(readFile).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it.each([
    ["No matching ID\n", "missing"],
    ["First^1231312\n\nSecond^1231312\n", "ambiguous"],
  ])("opens the file when the requested block is %s", async (text, status) => {
    const f = fixture();
    vi.mocked(readFile).mockResolvedValue(text);
    await openLinkTarget(f.plugin, parseLinkTargetForNavigation("unizero://paper/7/E23A232D.md#%5E1231312")!);
    expect(f.openFile).toHaveBeenCalledWith(f.file, undefined);
    expect(notices).toHaveBeenCalledWith(`UniZero: opened the file; the original block is ${status}.`);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("navigates to the user's unspaced block ID", async () => {
    const f = fixture();
    vi.mocked(readFile).mockResolvedValue("# Title\n\n我们从未有过这种危机感^1231312\n");
    await openLinkTarget(f.plugin, parseLinkTargetForNavigation("unizero://paper/7/E23A232D.md^1231312")!);
    expect(f.openFile).toHaveBeenCalledWith(f.file, { eState: { line: 2 } });
    expect(notices).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("opening a Zotero Canvas from Uniconnection", () => {
  function canvasFixture(artifacts: Array<{ key: string; kind: string; path?: string }>, outsideFiles = true) {
    const file = Object.assign(new TFile(), { path: "file:/Zotero/storage/EKQC4CPK/paper.canvas", extension: "canvas" });
    const openOccurrence = vi.fn();
    const bridge = { artifacts: vi.fn(async () => ({ libraryID: 1, itemKey: "PAPER", pdfs: [], artifacts })) };
    const getAbstractFileByPath = vi.fn(() => outsideFiles ? file : null);
    const plugin = { bridge, vaultIndex: { openOccurrence }, app: { vault: { getAbstractFileByPath } } } as unknown as UnizeroPlugin;
    return { plugin, bridge, file, openOccurrence, getAbstractFileByPath };
  }
  const params = { libraryID: "1", itemKey: "PAPER", canvas: "EKQC4CPK", node: "5b2c421ea3b7b8af" };

  it("asks the bridge for the Canvas file and selects the card", async () => {
    const f = canvasFixture([{ key: "OTHER", kind: "canvas", path: "/elsewhere.canvas" },
      { key: "EKQC4CPK", kind: "canvas", path: "/Zotero/storage/EKQC4CPK/paper.canvas" }]);
    await openZoteroCanvas(f.plugin, params);
    expect(f.bridge.artifacts).toHaveBeenCalledWith({ libraryID: 1, itemKey: "PAPER" });
    expect(f.getAbstractFileByPath).toHaveBeenCalledWith("file:/Zotero/storage/EKQC4CPK/paper.canvas");
    expect(f.openOccurrence).toHaveBeenCalledWith(expect.objectContaining({ file: f.file, nodeId: "5b2c421ea3b7b8af" }));
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("falls back to the system handler without outside files, naming the card", async () => {
    const f = canvasFixture([{ key: "EKQC4CPK", kind: "canvas", path: "/Zotero/storage/EKQC4CPK/paper.canvas" }], false);
    vi.mocked(shell.openPath).mockResolvedValue("");
    await openZoteroCanvas(f.plugin, params);
    expect(shell.openPath).toHaveBeenCalledWith("/Zotero/storage/EKQC4CPK/paper.canvas");
    expect(notices).toHaveBeenCalledWith("UniZero: opened the original Canvas; select card 5b2c421ea3b7b8af.");
  });

  it("refuses an attachment that is not that paper's Canvas, or has no file here", async () => {
    await expect(openZoteroCanvas(canvasFixture([{ key: "EKQC4CPK", kind: "raw", path: "/x.md" }]).plugin, params))
      .rejects.toThrow("no longer attached");
    await expect(openZoteroCanvas(canvasFixture([{ key: "EKQC4CPK", kind: "canvas" }]).plugin, params))
      .rejects.toThrow("not on this computer");
  });

  it.each([{ ...params, libraryID: "0" }, { ...params, itemKey: "../x" }, { ...params, canvas: "" }])(
    "rejects malformed identities without asking the bridge", async (bad) => {
      const f = canvasFixture([]);
      await expect(openZoteroCanvas(f.plugin, bad)).rejects.toThrow("Invalid Canvas link");
      expect(f.bridge.artifacts).not.toHaveBeenCalled();
    });
});
