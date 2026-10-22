import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openPath: vi.fn(), openExternal: vi.fn() } }));
vi.mock("obsidian", () => {
  class MenuItem {
    title = "";
    click?: () => void;
    setTitle(title: string) { this.title = title; return this; }
    setIcon() { return this; }
    setChecked() { return this; }
    setDisabled() { return this; }
    onClick(run: () => void) { this.click = run; return this; }
  }
  class Menu {
    items: (MenuItem | "separator")[] = [];
    addItem(build: (item: MenuItem) => void) {
      const item = new MenuItem();
      build(item);
      this.items.push(item);
      return this;
    }
    addSeparator() { this.items.push("separator"); return this; }
  }
  class Notice { constructor(readonly message: string) {} }
  class Modal {}
  class Setting {}
  return { Menu, Notice, Modal, Setting };
});

import { Menu } from "obsidian";
import {
  addCanvasItems,
  addManageItems,
  addRawItems,
  artifactState,
  trash,
  type ActionContext,
} from "../src/actions";
import type { BridgeCollectionItem, BridgePaper } from "../src/bridge";
import { PaperStore } from "../src/paperStore";

const paper = {
  libraryID: 1,
  itemKey: "ABCD1234",
  title: "A paper",
  links: {
    zoteroSelect: "zotero://select/library/items/ABCD1234",
    hasMarkdownAttachment: true,
    raw: "zotero://select/library/items/RAW00001",
    rawBackup: "zotero://select/library/items/BAK00001",
  },
} as unknown as BridgePaper;

function context(bridge: Partial<ActionContext["bridge"]> = {}): ActionContext {
  return {
    app: {} as ActionContext["app"],
    bridge: bridge as ActionContext["bridge"],
    defaultTemplate: "",
    changed: vi.fn(),
  };
}

function titles(menu: Menu): string[] {
  return (menu as unknown as { items: ({ title: string } | "separator")[] }).items
    .map((item) => item === "separator" ? "—" : item.title);
}

describe("artifact management", () => {
  it("reads the artifact state from a paper payload and from a library row", () => {
    expect(artifactState(paper)).toEqual({
      hasRaw: true, hasRawBackup: true, hasCanvas: false,
    });
    const row = { hasRaw: false, hasCanvas: true } as BridgeCollectionItem;
    expect(artifactState(row)).toEqual({
      hasRaw: false, hasRawBackup: false, hasCanvas: true,
    });
  });

  it("adds nothing for a paper without Raw, Raw Backup, or Canvas", () => {
    const menu = new Menu();
    addManageItems(menu, context(), paper, {
      hasRaw: false, hasRawBackup: false, hasCanvas: false,
    }, {} as MouseEvent);
    expect(titles(menu)).toEqual([]);
  });

  it("offers re-convert, restore, and both trash actions when everything exists", () => {
    const menu = new Menu();
    addManageItems(menu, context(), paper, {
      hasRaw: true, hasRawBackup: true, hasCanvas: true,
    }, {} as MouseEvent);
    expect(titles(menu)).toEqual([
      "—",
      "Re-convert (keeps Raw, updates Raw Backup)",
      "Re-convert with template…",
      "Restore Raw from Raw Backup",
      "Move Raw to Zotero trash",
      "Move Canvas to Zotero trash",
    ]);
  });

  it("offers restore without trash when only Raw Backup is left", () => {
    const menu = new Menu();
    addManageItems(menu, context(), paper, {
      hasRaw: false, hasRawBackup: true, hasCanvas: false,
    }, {} as MouseEvent);
    expect(titles(menu)).toEqual(["—", "Restore Raw from Raw Backup"]);
  });

  it("puts only the Raw entries on Raw's own menu", () => {
    const menu = new Menu();
    addRawItems(menu, context(), paper, {
      hasRaw: true, hasRawBackup: false, hasCanvas: true,
    }, {} as MouseEvent);
    expect(titles(menu)).toEqual([
      "Re-convert (keeps Raw, updates Raw Backup)",
      "Re-convert with template…",
      "Move Raw to Zotero trash",
    ]);
  });

  it("puts only the trash entry on Canvas's own menu, and nothing without a Canvas", () => {
    const withCanvas = new Menu();
    addCanvasItems(withCanvas, context(), paper, {
      hasRaw: true, hasRawBackup: true, hasCanvas: true,
    });
    expect(titles(withCanvas)).toEqual(["Move Canvas to Zotero trash"]);

    const without = new Menu();
    addCanvasItems(without, context(), paper, {
      hasRaw: true, hasRawBackup: true, hasCanvas: false,
    });
    expect(titles(without)).toEqual([]);
  });

  it("trashes through the bridge and reports the change", async () => {
    const bridgeTrash = vi.fn().mockResolvedValue({ trashed: true });
    const ctx = context({ trash: bridgeTrash });

    await expect(trash(ctx, paper, "canvas")).resolves.toBe(true);
    expect(bridgeTrash).toHaveBeenCalledWith({ libraryID: 1, itemKey: "ABCD1234" }, "canvas");
    expect(ctx.changed).toHaveBeenCalledWith({ libraryID: 1, itemKey: "ABCD1234" });
  });

  it("does not report a change when Zotero refuses the trash", async () => {
    const ctx = context({ trash: vi.fn().mockRejectedValue(new Error("read-only")) });

    await expect(trash(ctx, paper, "raw")).resolves.toBe(false);
    expect(ctx.changed).not.toHaveBeenCalled();
  });
});

describe("paper store reload", () => {
  it("re-reads a cached paper and publishes the fresh payload", async () => {
    const fresh = { ...paper, links: { ...paper.links, canvas: "zotero://x" } };
    const read = vi.fn()
      .mockResolvedValueOnce(paper)
      .mockResolvedValueOnce(fresh);
    const store = new PaperStore({ paper: read } as unknown as ConstructorParameters<typeof PaperStore>[0]);
    const ref = { libraryID: 1, itemKey: "ABCD1234" };
    const seen: string[] = [];
    store.subscribe(ref, (state) => { seen.push(state.status); });
    await store.load(ref);

    const state = await store.reload(ref);

    expect(read).toHaveBeenCalledTimes(2);
    expect(state).toEqual({ status: "ready", paper: fresh });
    expect(seen).toEqual(["loading", "ready", "loading", "ready"]);
  });
});
