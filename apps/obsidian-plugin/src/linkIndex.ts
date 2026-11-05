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
  readonly records = new Map<string, SourceRecord>();
  readonly listeners = new Set<() => void>();
  coverage: IndexCoverage = { state: "unbuilt", scope: "Zotero sources disabled", unavailable: 0 };
  vaultState: CoverageState = "unbuilt";
  disposed = false;
  /** A pass over many documents passes `notify: false` and notifies once when it has news. */
  replace(source: SourceDocument, text: string, fingerprint?: string, notify = true): LinkOccurrence[] {
    if (this.disposed) { return []; }
    const links = (source.format === "canvas" ? scanCanvasLinks(text) : scanDocumentLinks(text))
      .map((link) => ({ ...link, source, stale: false }));
    this.records.set(sourceIdentity(source), { source, links, fingerprint, stale: false });
    if (notify) { this.notify(); }
    return links;
  }
  stale(source: SourceDocument, error: string, notify = true): void {
    if (this.disposed) { return; }
    const key = sourceIdentity(source), old = this.records.get(key);
    this.records.set(key, { source, links: (old?.links || []).map((l) => ({ ...l, source, stale: true })), stale: true, error });
    if (notify) { this.notify(); }
  }
  remove(key: string): void { this.records.delete(key); this.notify(); }
  query(target: LinkTarget): LinkOccurrence[] {
    const key = targetIdentity(target);
    return [...this.records.values()].flatMap((r) => r.links).filter((l) => targetIdentity(l.target) === key);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(): void {
    if (this.disposed) { return; }
    for (const listener of this.listeners) { try { listener(); } catch (error) { console.error("UniZero index listener", error); } }
  }
  dispose(): void { this.disposed = true; this.listeners.clear(); this.records.clear(); }
}
