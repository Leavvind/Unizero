import { scanCanvasLinks, scanDocumentLinks, type DocumentLink } from "./documentLinks";
import { targetIdentity, type LinkTarget } from "./linkTarget";

export type SourceDocument =
  | { kind: "vault"; path: string; title: string; vaultID: string; uid?: string; format: "md" | "canvas" }
  | { kind: "zotero"; libraryID: number; itemKey: string; attachmentKey: string; title: string; itemTitle: string;
      path?: string; format: "md" | "canvas"; purpose: string; version: string };
export interface LinkOccurrence extends DocumentLink { source: SourceDocument; stale: boolean }
export interface SourceRecord { source: SourceDocument; links: LinkOccurrence[]; stale: boolean; error?: string; fingerprint?: string }
export type CoverageState = "unbuilt" | "updating" | "complete" | "partial" | "offline" | "failed";
export interface IndexCoverage { state: CoverageState; scope: string; unavailable: number; lastSuccess?: number; error?: string }
export const sourceIdentity = (source: SourceDocument): string => source.kind === "vault" ? `vault:${source.path}`
  : `zotero:${source.libraryID}/${source.itemKey}/${source.attachmentKey}`;

/** Lets a long index pass hand the window a frame between documents. */
export function timeSlicer(budgetMs = 12): () => Promise<void> {
  let started = Date.now();
  return async () => {
    if (Date.now() - started < budgetMs) { return; }
    await new Promise((resolve) => setTimeout(resolve, 0));
    started = Date.now();
  };
}

/** One application index shared by all views. It owns no bibliographic state. */
export class LinkIndex {
  private readonly sourceRecords = new Map<string, SourceRecord>();
  private readonly incoming = new Map<string, Map<string, LinkOccurrence[]>>();
  get records(): ReadonlyMap<string, SourceRecord> { return this.sourceRecords; }
  readonly listeners = new Set<() => void>();
  coverage: IndexCoverage = { state: "unbuilt", scope: "Zotero sources disabled", unavailable: 0 };
  vaultState: CoverageState = "unbuilt";
  disposed = false;
  /** A pass over many documents passes `notify: false` and notifies once when it has news. */
  replace(source: SourceDocument, text: string, fingerprint?: string, notify = true): LinkOccurrence[] {
    if (this.disposed) { return []; }
    return this.replaceParsed(source, source.format === "canvas" ? scanCanvasLinks(text) : scanDocumentLinks(text), fingerprint, notify);
  }
  replaceParsed(source: SourceDocument, parsed: DocumentLink[], fingerprint?: string, notify = true): LinkOccurrence[] {
    if (this.disposed) { return []; }
    const links = parsed.map((link) => ({ ...link, source, stale: false }));
    this.setRecord({ source, links, fingerprint, stale: false }, notify);
    return links;
  }
  stale(source: SourceDocument, error: string, notify = true): void {
    if (this.disposed) { return; }
    const key = sourceIdentity(source), old = this.records.get(key);
    this.setRecord({ source, links: (old?.links || []).map((l) => ({ ...l, source, stale: true })), stale: true, error }, notify);
  }
  /** All writes, including restored external records, keep the reverse index in sync. */
  setRecord(record: SourceRecord, notify = true): void {
    if (this.disposed) { return; }
    const key = sourceIdentity(record.source);
    this.removeIncoming(key);
    this.sourceRecords.set(key, record);
    for (const link of record.links) {
      const target = targetIdentity(link.target);
      let sources = this.incoming.get(target);
      if (!sources) { sources = new Map(); this.incoming.set(target, sources); }
      let links = sources.get(key);
      if (!links) { links = []; sources.set(key, links); }
      links.push(link);
    }
    if (notify) { this.notify(); }
  }
  private removeIncoming(key: string): void {
    for (const link of this.sourceRecords.get(key)?.links || []) {
      const target = targetIdentity(link.target), sources = this.incoming.get(target);
      sources?.delete(key);
      if (sources && !sources.size) { this.incoming.delete(target); }
    }
  }
  remove(key: string, notify = true): void {
    if (this.disposed || !this.sourceRecords.has(key)) { return; }
    this.removeIncoming(key);
    this.sourceRecords.delete(key);
    if (notify) { this.notify(); }
  }
  query(target: LinkTarget): LinkOccurrence[] {
    return [...(this.incoming.get(targetIdentity(target))?.values() || [])].flat();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(): void {
    if (this.disposed) { return; }
    for (const listener of this.listeners) { try { listener(); } catch (error) { console.error("UniZero index listener", error); } }
  }
  dispose(): void { this.disposed = true; this.listeners.clear(); this.sourceRecords.clear(); this.incoming.clear(); }
}
