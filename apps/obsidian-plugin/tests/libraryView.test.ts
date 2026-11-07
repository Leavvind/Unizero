// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeCollectionItem } from "../src/bridge";

vi.mock("obsidian", () => ({
  ItemView: class { contentEl = document.body.appendChild(document.createElement("div")); },
  Menu: class {}, Notice: class {}, setIcon: vi.fn(),
}));
vi.mock("../src/actions", () => ({}));
import { UnizeroLibraryView } from "../src/libraryView";

// Obsidian's DOM conveniences over the real test DOM.
const proto = HTMLElement.prototype as any;
proto.empty = function () { this.replaceChildren(); };
proto.addClass = function (name: string) { this.classList.add(name); };
proto.toggleClass = function (name: string, active: boolean) { this.classList.toggle(name, active); };
proto.setAttr = function (key: string, value: string) { this.setAttribute(key, value); };
proto.createEl = function (tag: string, options: any = {}) {
  const element = document.createElement(tag) as any;
  if (options.cls) { element.className = options.cls; }
  if (options.text) { element.textContent = options.text; }
  for (const field of ["value", "type", "placeholder"]) { if (options[field] !== undefined) { element[field] = options[field]; } }
  for (const [name, value] of Object.entries(options.attr || {})) { element.setAttribute(name, String(value)); }
  this.append(element);
  return element;
};
proto.createDiv = function (options: any) { return this.createEl("div", options); };
proto.createSpan = function (options: any) { return this.createEl("span", options); };
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 630 });

const views: UnizeroLibraryView[] = [];
afterEach(async () => { for (const view of views.splice(0)) { await view.onClose(); } document.body.replaceChildren(); });

async function open() {
  const items: BridgeCollectionItem[] = Array.from({ length: 10000 }, (_, i) => ({
    libraryID: 2, itemKey: `KEY${i}`, title: `Paper ${String(i).padStart(5, "0")}`,
    authors: ["Author"], year: "2026", hasPDF: true, hasRaw: false, hasMarkdown: false,
  }));
  const counts = new Map<string, number>();
  let notify!: () => void;
  const plugin = {
    settings: { lastLibraryID: 2, lastCollectionKey: "", showSubcollectionItems: true },
    bridge: { collections: async () => ({ libraries: [{ libraryID: 2, name: "Group", type: "group" }], collections: [] }),
      collectionItems: async () => ({ items, scope: { name: "Group" } }) },
    saveSettings: vi.fn(), showInDetailView: vi.fn(),
    vaultIndex: { getCount: (ref: { itemKey: string }) => counts.get(ref.itemKey) || 0,
      subscribe: (listener: () => void) => { notify = listener; return vi.fn(); } },
  };
  const view = new UnizeroLibraryView({} as any, plugin as any);
  views.push(view);
  await view.onOpen();
  const host = view.contentEl;
  return { view, host, counts, plugin, notify: () => notify() };
}

describe("Library viewport rendering", () => {
  it("mounts a bounded window for 10,000 records and sorts only once per filter", async () => {
    const { view, host } = await open();
    expect(host.querySelectorAll(".unizero-library__item").length).toBeLessThan(25);
    expect(host.querySelector(".unizero-library__status")?.textContent).toBe("10000/10000 · Group");
    const sort = vi.spyOn(view as any, "sortItems");
    const row = vi.spyOn(view as any, "renderRow");
    const input = host.querySelector<HTMLInputElement>("input")!;
    input.focus(); input.value = "Paper 00"; input.dispatchEvent(new Event("input"));
    expect(sort).toHaveBeenCalledTimes(1);
    expect(row.mock.calls.length).toBeLessThan(25);
    // Search terms match anywhere, including item keys (not just title prefixes).
    expect(host.querySelector(".unizero-library__status")?.textContent).toBe("1171/10000 · Group");
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new Event("input"));
    expect(sort).toHaveBeenCalledTimes(1);
  });

  it("updates only changed visible badges without sorting or replacing rows", async () => {
    const { view, host, counts, notify } = await open();
    const row = host.querySelector<HTMLElement>(".unizero-library__item")!;
    row.click(); row.focus();
    const sort = vi.spyOn(view as any, "sortItems");
    const render = vi.spyOn(view as any, "renderRow");
    counts.set(row.dataset.itemKey!, 3); notify();
    expect(row.querySelector(".unizero-badge--count")?.textContent).toBe("3");
    const badge = row.querySelector(".unizero-badge--count");
    notify();
    expect(row.querySelector(".unizero-badge--count")).toBe(badge);
    expect(document.activeElement).toBe(row);
    expect(row.classList.contains("is-selected")).toBe(true);
    expect(sort).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
    counts.delete(row.dataset.itemKey!); notify();
    expect(row.querySelector(".unizero-badge--count")).toBeNull();
  });

  it("reaches the last record by keyboard and loads current badges for offscreen rows", async () => {
    const { host, counts, notify, plugin } = await open();
    counts.set("KEY9999", 7); notify();
    const first = host.querySelector<HTMLElement>(".unizero-library__item")!;
    first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    const last = document.activeElement as HTMLElement;
    expect(last.dataset.itemKey).toBe("KEY9999");
    expect(last.querySelector(".unizero-badge--count")?.textContent).toBe("7");
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(plugin.showInDetailView).toHaveBeenCalledWith({ libraryID: 2, itemKey: "KEY9999" });
    expect(last.draggable).toBe(true);
    expect(host.querySelectorAll(".unizero-library__item").length).toBeLessThan(25);
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.itemKey).toBe("KEY0");
  });

  it("clamps scrolling after filtering down to one row", async () => {
    const { host } = await open();
    const first = host.querySelector<HTMLElement>(".unizero-library__item")!;
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    const input = host.querySelector<HTMLInputElement>("input")!;
    input.value = "Paper 00001"; input.dispatchEvent(new Event("input"));
    expect(host.querySelectorAll(".unizero-library__item")).toHaveLength(1);
    expect(host.querySelector<HTMLElement>(".unizero-library__list")?.scrollTop).toBe(0);
  });
});
