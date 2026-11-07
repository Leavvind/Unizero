import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { shell } from "electron";
import { readFile } from "fs/promises";
import type UnizeroPlugin from "../src/main";
import { openLinkTarget } from "../src/linkOpening";
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
