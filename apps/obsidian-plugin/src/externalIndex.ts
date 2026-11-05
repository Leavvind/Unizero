import { readFile, stat } from "fs/promises";
import { createHash } from "crypto";
import type { BridgeLinkSource, UnizeroBridge } from "./bridge";
import { BRIDGE_API } from "./bridge";
import { LinkIndex, sourceIdentity, timeSlicer, type SourceDocument, type SourceRecord } from "./linkIndex";

export const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const externalSource = (source: BridgeLinkSource): SourceDocument & { kind: "zotero" } => ({ ...source, kind: "zotero" });
export const normalizeLocalPath = (path: string): string => path.replace(/^file:\/\//, "").replace(/^file:/, "").replace(/\\/g, "/").replace(/^\/([A-Za-z]:)/, "$1");

export interface SourceIO {
  read(path: string): Promise<string>;
  state(path: string): Promise<string>;
  loadCache(): Promise<string | null>;
  saveCache(text: string): Promise<void>;
}
export const localFileIO = {
  read: (path: string) => readFile(path, "utf8"),
  state: async (path: string) => { const s = await stat(path); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; },
};

/** Single-flight, cancelable directory refresh; interrupted scans never prune sources. */
export class ExternalIndex {
  private generation = 0;
  private running?: Promise<void>;
  private runningForced = false;
  private queuedRebuild?: Promise<void>;
  private stopped = false;
  constructor(private readonly index: LinkIndex, private readonly bridge: UnizeroBridge,
    private readonly io: SourceIO, private readonly libraries: () => number[]) {}

  async load(): Promise<void> {
    const generation = this.generation;
    try {
      const text = await this.io.loadCache();
      if (!text || this.stopped || generation !== this.generation) { return; }
      const cache = JSON.parse(text);
      if (cache.schema !== 1 || !Array.isArray(cache.records)) { return; }
      for (const record of cache.records as SourceRecord[]) {
        if (record.source?.kind !== "zotero" || !Array.isArray(record.links)) { continue; }
        this.index.records.set(sourceIdentity(record.source), { ...record, stale: true,
          links: record.links.map((l) => ({ ...l, source: record.source, stale: true })) });
      }
      this.index.coverage = { state: "offline", scope: cache.scope || "Cached Zotero sources", unavailable: cache.records.length,
        lastSuccess: cache.lastSuccess };
      this.index.notify();
    } catch (error) { console.warn("UniZero: cannot read derived link cache", error); }
  }
  refresh(force = false): Promise<void> {
    if (this.stopped) { return Promise.resolve(); }
    if (this.running && (this.runningForced || !force)) { return this.running; }
    if (this.running) {
      // A rebuild asked for during a background pass runs once that pass ends;
      // handing back the pass would skip every unchanged file it was meant to reparse.
      this.queuedRebuild ??= this.running.catch(() => undefined).then(() => {
        this.queuedRebuild = undefined;
        return this.refresh(true);
      });
      return this.queuedRebuild;
    }
    this.runningForced = force;
    this.running = this.scan(force).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async scan(force: boolean): Promise<void> {
    const generation = this.generation;
    const alive = () => !this.stopped && generation === this.generation && !this.index.disposed;
    const stateBefore = this.index.coverage.state, hadSuccess = this.index.coverage.lastSuccess !== undefined;
    // A background pass that finds nothing new must not repaint open panes.
    if (force) {
      this.index.coverage = { ...this.index.coverage, state: "updating", error: undefined };
      this.index.notify();
    }
    const seen = new Set<string>(), slice = timeSlicer();
    let unavailable = 0, changed = false, unannounced = false;
    const mark = () => { changed = true; unannounced = true; };
    try {
      const ping = await this.bridge.ping();
      if (!alive()) { return; }
      if (ping.api !== BRIDGE_API || !ping.capabilities.includes("link-sources")) {
        this.index.coverage = { ...this.index.coverage, state: "partial", error: "Update the Zotero add-on to index Zotero documents." };
        this.index.notify(); return;
      }
      let scan: string | undefined, offset: number | undefined;
      while (alive()) {
        const page = await this.bridge.linkSources({ libraries: this.libraries(), scan, offset });
        if (!alive()) { return; }
        if (!page.scan || (scan && page.scan !== scan) || !Array.isArray(page.items)) { throw new Error("Invalid source scan response"); }
        scan = page.scan;
        this.index.coverage.scope = `Zotero libraries: ${page.scope.join(", ")}`;
        for (const entry of page.items) {
          if (!alive()) { return; }
          const source = externalSource(entry), key = sourceIdentity(source);
          if (seen.has(key)) { throw new Error("Duplicate attachment in source directory"); }
          seen.add(key);
          const previous = this.index.records.get(key);
          try {
            if (!entry.available || !entry.path) { throw new Error("File unavailable on this machine"); }
            const fingerprint = `${entry.version}:${await this.io.state(entry.path)}`;
            if (!alive()) { return; }
            if (!force && previous?.fingerprint === fingerprint) {
              // A cached record of a file that has not changed is current again without a parse.
              if (previous.stale) {
                this.index.records.set(key, { ...previous, source, stale: false, error: undefined,
                  links: previous.links.map((link) => ({ ...link, source, stale: false })) });
                mark();
              }
              continue;
            }
            const text = await this.io.read(entry.path);
            if (!alive()) { return; }
            // Always parse a successful empty read, never substitute empty for errors.
            this.index.replace(source, text, fingerprint, false);
            mark();
            await slice();
            if (!alive()) { return; }
          } catch (error) {
            if (!alive()) { return; }
            unavailable += 1;
            const message = (error as Error).message;
            this.index.stale(source, message, false);
            if (!previous?.stale || previous.error !== message) { mark(); }
          }
        }
        if (unannounced) { unannounced = false; this.index.notify(); }
        if (page.complete) { break; }
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset! <= (offset || 0)) { throw new Error("Invalid source continuation"); }
        offset = page.nextOffset;
      }
      if (!alive()) { return; }
      for (const [key, record] of this.index.records) {
        if (record.source.kind === "zotero" && !seen.has(key)) { this.index.records.delete(key); mark(); }
      }
      const state = unavailable ? "partial" : "complete";
      this.index.coverage = { ...this.index.coverage, state, unavailable, error: undefined, lastSuccess: Date.now() };
      if (force || unannounced || state !== stateBefore) { this.index.notify(); }
      if (!changed && hadSuccess) { return; }
      const records = [...this.index.records.values()].filter((r) => r.source.kind === "zotero");
      await this.io.saveCache(JSON.stringify({ schema: 1, records, scope: this.index.coverage.scope, lastSuccess: this.index.coverage.lastSuccess }));
    } catch (error) {
      if (!alive()) { return; }
      for (const record of this.index.records.values()) {
        if (record.source.kind === "zotero") { this.index.stale(record.source, (error as Error).message, false); }
      }
      const hasCache = [...this.index.records.values()].some((r) => r.source.kind === "zotero");
      this.index.coverage = { ...this.index.coverage, state: hasCache ? "offline" : "failed", error: (error as Error).message };
      this.index.notify();
    }
  }
  findPath(path: string): SourceDocument | undefined {
    const normalized = normalizeLocalPath(path);
    return [...this.index.records.values()].find((r) => r.source.kind === "zotero" && r.source.path
      && normalizeLocalPath(r.source.path) === normalized)?.source;
  }
  dispose(): void { this.stopped = true; this.generation += 1; }
}
