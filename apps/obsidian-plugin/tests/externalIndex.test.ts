import { describe, expect, it, vi } from "vitest";
import { ExternalIndex, type SourceIO } from "../src/externalIndex";
import { LinkIndex } from "../src/linkIndex";
import type { UnizeroBridge, BridgeLinkSource, BridgeSourcePage } from "../src/bridge";

const source: BridgeLinkSource = { libraryID: 2, itemKey: "PAPER001", attachmentKey: "RAW00001", title: "Raw", itemTitle: "Paper",
  format: "md", purpose: "raw", path: "C:/storage/raw.md", available: true, version: "1" };
const page = (items: BridgeLinkSource[], more?: number): BridgeSourcePage => ({ scan: "scan-1", scope: [2], items, complete: more === undefined, nextOffset: more, total: 2 });
const target = { kind: "note" as const, vaultID: "a", uid: "123" };
function fixture() {
  const index = new LinkIndex();
  const bridge = { ping: vi.fn(async () => ({ api: 2, capabilities: ["link-sources"] })), linkSources: vi.fn(async () => page([source])) };
  const io = { read: vi.fn(async () => "[note](unizero://note/a/123)"), state: vi.fn(async () => "state-1"),
    loadCache: vi.fn(async (): Promise<string | null> => null), saveCache: vi.fn(async (_text: string) => {}) };
  const service = new ExternalIndex(index, bridge as unknown as UnizeroBridge, io, () => [2]);
  return { index, bridge, io, service };
}
describe("external source refresh", () => {
  it("indexes unopened sources, coalesces requests and keeps attachment identity", async () => {
    const f = fixture();
    const first = f.service.refresh(), second = f.service.refresh();
    expect(first).toBe(second); await first;
    expect(f.index.query(target)).toHaveLength(1);
    expect(f.index.query(target)[0].source.kind).toBe("zotero");
    expect(f.index.coverage.state).toBe("complete");
    await f.service.refresh(); expect(f.io.read).toHaveBeenCalledTimes(1);
  });
  it("runs a rebuild requested during a background pass instead of joining it", async () => {
    const f = fixture(); await f.service.refresh();
    const background = f.service.refresh(), rebuild = f.service.refresh(true);
    expect(rebuild).not.toBe(background);
    expect(f.service.refresh(true)).toBe(rebuild);
    await rebuild;
    // The unchanged file is skipped by the background pass and reparsed by the rebuild.
    expect(f.io.read).toHaveBeenCalledTimes(2);
  });
  it("retains old links as stale on missing files and bridge failures", async () => {
    const f = fixture(); await f.service.refresh();
    f.io.state.mockRejectedValueOnce(new Error("not synced")); await f.service.refresh();
    expect(f.index.query(target)[0].stale).toBe(true); expect(f.index.coverage.state).toBe("partial");
    f.bridge.ping.mockRejectedValueOnce(new Error("offline")); await f.service.refresh();
    expect(f.index.query(target)).toHaveLength(1); expect(f.index.coverage.state).toBe("offline");
  });
  it("only clears outlinks after successful empty reads and prunes after complete scans", async () => {
    const f = fixture(); await f.service.refresh();
    f.io.read.mockResolvedValueOnce(""); await f.service.refresh(true);
    expect(f.index.query(target)).toHaveLength(0);
    expect(f.index.records.size).toBe(1);
    f.bridge.linkSources.mockResolvedValueOnce(page([])); await f.service.refresh(); expect(f.index.records.size).toBe(0);
  });
  it("does not prune unseen records when a page fails", async () => {
    const f = fixture(); await f.service.refresh();
    f.bridge.linkSources.mockResolvedValueOnce(page([], 1)).mockRejectedValueOnce(new Error("page interrupted"));
    await f.service.refresh(); expect(f.index.query(target)).toHaveLength(1); expect(f.index.coverage.state).toBe("offline");
  });
  it("ignores in-flight results after unload", async () => {
    const f = fixture();
    let finish!: (text: string) => void;
    f.io.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const running = f.service.refresh();
    await vi.waitFor(() => expect(f.io.read).toHaveBeenCalled());
    f.service.dispose(); finish("[note](unizero://note/a/123)"); await running;
    expect(f.index.records.size).toBe(0); expect(f.io.saveCache).not.toHaveBeenCalled();
  });
  it("reports missing capabilities without claiming complete coverage", async () => {
    const f = fixture(); f.bridge.ping.mockResolvedValueOnce({ api: 2, capabilities: [] });
    await f.service.refresh(); expect(f.index.coverage.state).toBe("partial"); expect(f.bridge.linkSources).not.toHaveBeenCalled();
  });
  it("restores versioned cache as stale and then rebuilds it", async () => {
    const f = fixture(); await f.service.refresh();
    const json = f.io.saveCache.mock.calls[0][0];
    const g = fixture(); g.io.loadCache.mockResolvedValueOnce(json); await g.service.load();
    expect(g.index.coverage.state).toBe("offline"); expect(g.index.query(target)[0].stale).toBe(true);
    await g.service.refresh(); expect(g.index.query(target)[0].stale).toBe(false);
  });
  it("does not parse or save again when a restored file has not changed", async () => {
    const f = fixture(); await f.service.refresh();
    const g = fixture(); g.io.loadCache.mockResolvedValueOnce(f.io.saveCache.mock.calls[0][0]); await g.service.load();
    await g.service.refresh();
    expect(g.io.read).not.toHaveBeenCalled();
    expect(g.index.query(target)).toHaveLength(1);
    g.io.state.mockResolvedValue("state-2");
    await g.service.refresh();
    expect(g.io.read).toHaveBeenCalledTimes(1);
  });
  it("stays silent during a background pass that finds nothing new", async () => {
    const f = fixture(); await f.service.refresh();
    const listener = vi.fn(); f.index.subscribe(listener); const saves = f.io.saveCache.mock.calls.length;
    await f.service.refresh();
    expect(listener).not.toHaveBeenCalled();
    expect(f.io.saveCache.mock.calls.length).toBe(saves);
    await f.service.refresh(true);
    expect(listener).toHaveBeenCalled();
  });
  it("notifies once per page instead of once per document", async () => {
    const f = fixture();
    const two = { ...source, attachmentKey: "RAW00002", path: "C:/storage/two.md" };
    f.bridge.linkSources.mockResolvedValueOnce(page([source, two]));
    const listener = vi.fn(); f.index.subscribe(listener);
    await f.service.refresh();
    expect(f.io.read).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2); // The page, then the changed coverage state.
  });
});
