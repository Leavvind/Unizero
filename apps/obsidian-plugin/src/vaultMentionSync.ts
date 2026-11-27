/**
 * Sends Zotero the paper links written in this Vault's notes, so Uniconnection can
 * list Vault notes among a paper's Citations (docs/UNICONNECTION.md §3).
 *
 * Zotero cannot read the Vault; this plugin already indexes it. After the Vault
 * index changes, and once it is complete, the plugin builds a snapshot of every
 * `unizero://paper/…` link in a Vault note (render-only `nocite` links are not in
 * the index) and posts it to `POST /vault-mentions`, which replaces this Vault's
 * previous one. An unchanged snapshot is not sent again; a failed send is retried.
 * Links in Zotero's own documents are not sent: the add-on reads those itself.
 */

import { BRIDGE_API, type UnizeroBridge, type VaultMentionEntry, type VaultMentionSnapshot } from "./bridge";
import { unitKey } from "@unizero/links";
import { occurrenceSnippet } from "./documentLinks";
import type { CoverageState, SourceRecord } from "./linkIndex";

/** Wait after the last index change before sending, so typing sends once. */
const SEND_DELAY_MS = 5_000;
/** Retry after a failed send (Zotero closed, add-on too old). */
const RETRY_DELAY_MS = 60_000;

/**
 * The Vault-note mentions of papers among the index's records, one per evidence unit
 * and paper (as in Zotero's own Raw and Canvas index), in a stable order.
 */
export function vaultMentionEntries(records: Iterable<SourceRecord>, mtime: (path: string) => number | undefined): VaultMentionEntry[] {
  const entries: VaultMentionEntry[] = [];
  for (const record of records) {
    const source = record.source;
    if (source.kind !== "vault") { continue; }
    const seen = new Set<string>();
    const time = mtime(source.path);
    for (const link of record.links) {
      const target = link.target;
      if (target.kind !== "paper") { continue; }
      const unit = `${target.libraryID}:${target.itemKey}|${unitKey(link)}`;
      if (seen.has(unit)) { continue; }
      seen.add(unit);
      entries.push({
        libraryID: target.libraryID,
        itemKey: target.itemKey,
        path: source.path,
        title: source.title,
        format: source.format,
        line: link.line,
        ...(link.nodeId !== undefined ? { nodeId: link.nodeId } : {}),
        text: link.unit?.text || occurrenceSnippet(link.lineText, link.ch),
        pdf: link.unit ? [...link.unit.pdf] : [],
        ...(time !== undefined ? { time } : {}),
      });
    }
  }
  return entries.sort(compareEntries);
}

function compareEntries(left: VaultMentionEntry, right: VaultMentionEntry): number {
  return left.path.localeCompare(right.path) || (left.nodeId || "").localeCompare(right.nodeId || "")
    || left.line - right.line || left.itemKey.localeCompare(right.itemKey);
}

/** Only a finished pass describes the whole Vault; a partial one keeps failed notes' last links. */
export function snapshotReady(state: CoverageState): boolean {
  return state === "complete" || state === "partial";
}

export interface VaultMentionSyncHost {
  bridge: UnizeroBridge;
  endpoint(): string;
  enabled(): boolean;
  vaultID(): string;
  vaultName(): string;
  vaultState(): CoverageState;
  records(): Iterable<SourceRecord>;
  mtime(path: string): number | undefined;
  subscribe(listener: () => void): () => void;
}

export class VaultMentionSync {
  private timer?: number;
  private unsubscribe?: () => void;
  /** What Zotero holds for this Vault: the endpoint, the Vault and its name, and the sent mentions. */
  private sent?: { endpoint: string; vaultID: string; vaultName: string; body: string };
  private running = false;
  private stopped = false;

  constructor(private readonly host: VaultMentionSyncHost) {}

  start(): void {
    this.unsubscribe = this.host.subscribe(() => this.schedule());
    this.schedule();
  }

  /** Send after the index settles; settings changes call this too. */
  schedule(delay = SEND_DELAY_MS): void {
    if (this.stopped) { return; }
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.send(); }, delay);
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.unsubscribe?.();
  }

  /**
   * With sharing off, an empty snapshot clears what Zotero still holds for this Vault,
   * once per session; a failure is not retried on a timer, only on the next change.
   */
  private async send(): Promise<void> {
    if (this.stopped) { return; }
    const enabled = this.host.enabled();
    if (enabled && !snapshotReady(this.host.vaultState())) { return; }
    if (this.running) { this.schedule(); return; }
    const endpoint = this.host.endpoint(), vaultID = this.host.vaultID(), vaultName = this.host.vaultName();
    if (!vaultID) { return; }
    const mentions = enabled ? vaultMentionEntries(this.host.records(), (path) => this.host.mtime(path)) : [];
    const body = JSON.stringify(mentions);
    const sent = this.sent;
    if (sent && sent.endpoint === endpoint && sent.vaultID === vaultID && sent.vaultName === vaultName && sent.body === body) { return; }
    this.running = true;
    try {
      const ping = await this.host.bridge.ping();
      if (ping.api !== BRIDGE_API || !ping.capabilities.includes("vault-mentions")) {
        // An add-on without the endpoint: ask again later, it may be updated.
        if (enabled) { this.schedule(RETRY_DELAY_MS); }
        return;
      }
      // A Vault given a new identity leaves no orphan snapshot behind in Zotero.
      if (sent && sent.endpoint === endpoint && sent.vaultID !== vaultID) {
        await this.host.bridge.vaultMentions(this.snapshot(sent.vaultID, []));
      }
      await this.host.bridge.vaultMentions(this.snapshot(vaultID, mentions));
      this.sent = { endpoint, vaultID, vaultName, body };
    } catch (error) {
      console.debug("UniZero: Vault mentions not sent to Zotero", error);
      if (enabled) { this.schedule(RETRY_DELAY_MS); }
    } finally {
      this.running = false;
    }
  }

  private snapshot(vaultID: string, mentions: VaultMentionEntry[]): VaultMentionSnapshot {
    return { vaultID, vaultName: this.host.vaultName(), generatedAt: Date.now(), mentions };
  }
}
