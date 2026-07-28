/**
 * Phase 2 maintenance for the derived UniConnection graph.
 *
 * Zotero item notifications keep a resident graph aligned with item identity and
 * deletion changes. Missing References caches are filled by a deduplicated,
 * sequential queue; provider access and its global Semantic Scholar gate remain
 * owned by referencesApi.
 */

import { config } from "../../package.json";
import { libraryItemIdentity } from "../zotero/libraryScope";
import { readItemPaperIdentifiers } from "./itemIdentifiers";
import {
  CACHE_KEY_REFERENCES,
  cacheMatchesItem,
  makeReferencesCache,
  type ReferencesCache,
} from "./literatureCache";
import { invalidateLibraryMembership } from "./literatureRelations";
import { localStorage } from "./localStorage";
import {
  fetchReferencesByIdentifiers,
  type ReferencesResult,
} from "./referencesApi";
import { uniConnection } from "./uniConnection";

const DEFAULT_QUEUE_INTERVAL_MS = 1_100;

interface NotifierPort {
  registerObserver(
    observer: { notify: _ZoteroTypes.Notifier.Notify },
    types?: _ZoteroTypes.Notifier.Type[],
    id?: string,
    priority?: number,
  ): string;
  unregisterObserver(id: String): void;
}

interface CachePort {
  readRecordDirect(item: Zotero.Item, key: string): Promise<unknown>;
  set(item: Zotero.Item, key: string, value: unknown): Promise<void>;
}

interface ConnectionPort {
  ingestItem(item: Zotero.Item, buildIfMissing?: boolean): Promise<boolean>;
  retract(scopedKey: string): void;
  retractItemID(itemID: number): number | undefined;
}

interface FillTask {
  itemID: number;
  scopedKey: string;
  fingerprint: string;
  doi?: string;
  semanticScholarPaperId?: string;
}

export interface UniConnectionSyncDiagnostics {
  registered: boolean;
  queued: number;
  attempted: number;
  inFlight?: string;
  lastEvent?: {
    event: string;
    ids: number;
    at: number;
  };
  lastFill?: {
    scopedKey: string;
    status: "saved" | "empty" | "failed" | "discarded";
    count?: number;
    at: number;
    error?: string;
  };
}

export interface UniConnectionSyncOptions {
  notifier?: NotifierPort;
  cache?: CachePort;
  connection?: ConnectionPort;
  fetchReferences?: (
    doi?: string,
    semanticScholarPaperId?: string,
  ) => Promise<ReferencesResult | null>;
  getItem?: (id: number) => Promise<Zotero.Item | undefined>;
  invalidateMembership?: (libraryID?: number) => void;
  cacheEnabled?: () => boolean;
  delay?: (milliseconds: number) => Promise<unknown>;
  now?: () => number;
  queueIntervalMs?: number;
}

function isReferencesCache(value: unknown): value is ReferencesCache {
  return Boolean(
    value &&
    typeof value === "object" &&
    Array.isArray((value as ReferencesCache).references),
  );
}

function itemFingerprint(item: Zotero.Item): {
  fingerprint: string;
  doi?: string;
  semanticScholarPaperId?: string;
} {
  const identifiers = readItemPaperIdentifiers(item);
  const doi = String(identifiers.doi || "").toLowerCase() || undefined;
  const semanticScholarPaperId =
    String(identifiers.semanticScholarPaperId || "").toLowerCase() || undefined;
  return {
    fingerprint: `${doi || ""}|${semanticScholarPaperId || ""}`,
    doi,
    semanticScholarPaperId,
  };
}

function extraForID(extraData: any, itemID: number): any {
  return extraData?.[itemID] ?? extraData?.[String(itemID)];
}

export class UniConnectionSync {
  private readonly notifier: NotifierPort;
  private readonly cache: CachePort;
  private readonly connection: ConnectionPort;
  private readonly fetchReferences: NonNullable<UniConnectionSyncOptions["fetchReferences"]>;
  private readonly getItem: NonNullable<UniConnectionSyncOptions["getItem"]>;
  private readonly invalidateMembership: NonNullable<
    UniConnectionSyncOptions["invalidateMembership"]
  >;
  private readonly cacheEnabled: NonNullable<UniConnectionSyncOptions["cacheEnabled"]>;
  private readonly delay: NonNullable<UniConnectionSyncOptions["delay"]>;
  private readonly now: NonNullable<UniConnectionSyncOptions["now"]>;
  private readonly queueIntervalMs: number;

  private observerID?: string;
  private generation = 0;
  private queue: FillTask[] = [];
  private queued = new Map<string, string>();
  private attempted = new Map<string, string>();
  private draining?: Promise<void>;
  private lastStartedAt = 0;
  private current?: FillTask;
  private lastEvent?: UniConnectionSyncDiagnostics["lastEvent"];
  private lastFill?: UniConnectionSyncDiagnostics["lastFill"];

  private readonly observer = {
    notify: (
      event: _ZoteroTypes.Notifier.Event,
      type: _ZoteroTypes.Notifier.Type,
      ids: string[] | number[],
      extraData: any,
    ) => this.notify(event, type, ids, extraData),
  };

  public constructor(options: UniConnectionSyncOptions = {}) {
    this.notifier = options.notifier || Zotero.Notifier;
    this.cache = options.cache || localStorage;
    this.connection = options.connection || uniConnection;
    this.fetchReferences = options.fetchReferences || fetchReferencesByIdentifiers;
    this.getItem = options.getItem || (async (id) => {
      try {
        return await (Zotero.Items.getAsync(id) as Promise<Zotero.Item | undefined>);
      } catch {
        return undefined;
      }
    });
    this.invalidateMembership =
      options.invalidateMembership || invalidateLibraryMembership;
    this.cacheEnabled = options.cacheEnabled || (() =>
      Zotero.Prefs.get(`${config.addonRef}.saveAPIReferences`) !== false);
    this.delay = options.delay || ((milliseconds) => Zotero.Promise.delay(milliseconds));
    this.now = options.now || Date.now;
    this.queueIntervalMs = Math.max(
      0,
      options.queueIntervalMs ?? DEFAULT_QUEUE_INTERVAL_MS,
    );
  }

  public register(): void {
    if (this.observerID) { return; }
    this.generation += 1;
    this.queue = [];
    this.queued.clear();
    this.attempted.clear();
    this.current = undefined;
    this.lastStartedAt = 0;
    this.observerID = this.notifier.registerObserver(
      this.observer,
      ["item"],
      `${config.addonRef}-connection`,
    );
  }

  public unregister(): void {
    if (this.observerID) {
      this.notifier.unregisterObserver(this.observerID);
      this.observerID = undefined;
    }
    this.generation += 1;
    this.queue = [];
    this.queued.clear();
    this.current = undefined;
  }

  public diagnostics(): UniConnectionSyncDiagnostics {
    return {
      registered: Boolean(this.observerID),
      queued: this.queue.length,
      attempted: this.attempted.size,
      inFlight: this.current?.scopedKey,
      lastEvent: this.lastEvent,
      lastFill: this.lastFill,
    };
  }

  /** Test/debug seam: resolves when the current queue drain finishes. */
  public async waitForIdle(): Promise<void> {
    while (this.draining) {
      await this.draining;
    }
  }

  private async notify(
    event: _ZoteroTypes.Notifier.Event,
    type: _ZoteroTypes.Notifier.Type,
    ids: string[] | number[],
    extraData: any,
  ): Promise<void> {
    if (!this.observerID || type !== "item") { return; }
    if (!["add", "modify", "delete", "trash"].includes(event)) { return; }
    const itemIDs = ids.map(Number).filter(Number.isFinite);
    this.lastEvent = { event, ids: itemIDs.length, at: this.now() };

    if (event === "delete") {
      for (const itemID of itemIDs) {
        const indexedLibraryID = this.connection.retractItemID(itemID);
        const extra = extraForID(extraData, itemID);
        const libraryID = Number(extra?.libraryID ?? indexedLibraryID);
        const itemKey = String(extra?.key || extra?.itemKey || "");
        if (Number.isFinite(libraryID) && itemKey) {
          this.connection.retract(`${libraryID}:${itemKey}`);
        }
        this.invalidateMembership(
          Number.isFinite(libraryID) ? libraryID : undefined,
        );
      }
      return;
    }

    for (const itemID of itemIDs) {
      try {
        const item = await this.getItem(itemID);
        if (!item?.isRegularItem?.()) { continue; }
        this.invalidateMembership(item.libraryID);
        if (event === "trash" || item.deleted) {
          this.connection.retract(libraryItemIdentity(item));
          continue;
        }

        // Updating an unbuilt graph would defeat lazy construction. If it is
        // resident, ingestItem retracts its old identity/edges before re-reading.
        await this.connection.ingestItem(item, false);

        const record = await this.cache.readRecordDirect(
          item,
          CACHE_KEY_REFERENCES,
        );
        if (
          isReferencesCache(record) &&
          cacheMatchesItem(record, item)
        ) {
          continue;
        }
        this.enqueue(item);
      } catch (error) {
        ztoolkit.log(`[uniConnection] notifier ${event} failed for ${itemID}`, error);
      }
    }
  }

  private enqueue(item: Zotero.Item): void {
    if (!this.observerID || !this.cacheEnabled()) { return; }
    const identity = itemFingerprint(item);
    if (!identity.doi && !identity.semanticScholarPaperId) { return; }
    const scopedKey = libraryItemIdentity(item);
    if (
      this.queued.get(scopedKey) === identity.fingerprint ||
      this.attempted.get(scopedKey) === identity.fingerprint
    ) {
      return;
    }
    this.queued.set(scopedKey, identity.fingerprint);
    this.queue.push({
      itemID: item.id,
      scopedKey,
      fingerprint: identity.fingerprint,
      doi: identity.doi,
      semanticScholarPaperId: identity.semanticScholarPaperId,
    });
    this.startDrain();
  }

  private startDrain(): void {
    if (this.draining || !this.observerID || !this.queue.length) { return; }
    const generation = this.generation;
    const run = this.drain(generation).catch((error) => {
      ztoolkit.log("[uniConnection] queue drain failed", error);
    });
    this.draining = run;
    // Queue entries can arrive as a drain is settling. Re-check after clearing the
    // exact completed promise so no task is stranded in that narrow handoff.
    void run.then(() => {
      if (this.draining !== run) { return; }
      this.draining = undefined;
      this.startDrain();
    });
  }

  private async drain(generation: number): Promise<void> {
    while (this.observerID && generation === this.generation && this.queue.length) {
      const task = this.queue.shift()!;
      if (this.queued.get(task.scopedKey) === task.fingerprint) {
        this.queued.delete(task.scopedKey);
      }
      if (this.attempted.get(task.scopedKey) === task.fingerprint) { continue; }
      this.attempted.set(task.scopedKey, task.fingerprint);
      this.current = task;

      const wait = this.queueIntervalMs - (this.now() - this.lastStartedAt);
      if (this.lastStartedAt && wait > 0) { await this.delay(wait); }
      if (!this.observerID || generation !== this.generation) { break; }
      this.lastStartedAt = this.now();

      try {
        const item = await this.getCurrentItem(task);
        if (!item) {
          this.noteFill(task, "discarded");
          continue;
        }
        const existing = await this.cache.readRecordDirect(
          item,
          CACHE_KEY_REFERENCES,
        );
        if (
          isReferencesCache(existing) &&
          cacheMatchesItem(existing, item)
        ) {
          await this.connection.ingestItem(item, false);
          this.noteFill(task, "discarded");
          continue;
        }

        const result = await this.fetchReferences(
          task.doi,
          task.semanticScholarPaperId,
        );
        if (!result) {
          this.noteFill(task, "empty");
          continue;
        }
        const current = await this.getCurrentItem(task);
        if (
          !current ||
          !this.observerID ||
          generation !== this.generation
        ) {
          this.noteFill(task, "discarded");
          continue;
        }
        const payload = makeReferencesCache(
          current,
          result.source,
          result.references,
          false,
          result.perSource,
        );
        await this.cache.set(current, CACHE_KEY_REFERENCES, payload);
        await this.connection.ingestItem(current, false);
        this.noteFill(
          task,
          result.references.length ? "saved" : "empty",
          result.references.length,
        );
      } catch (error) {
        this.noteFill(task, "failed", undefined, error);
        ztoolkit.log(`[uniConnection] reference fill failed for ${task.scopedKey}`, error);
      } finally {
        if (this.current === task) { this.current = undefined; }
      }
    }
    this.current = undefined;
  }

  private async getCurrentItem(task: FillTask): Promise<Zotero.Item | undefined> {
    const item = await this.getItem(task.itemID);
    if (
      !item?.isRegularItem?.() ||
      item.deleted ||
      libraryItemIdentity(item) !== task.scopedKey ||
      itemFingerprint(item).fingerprint !== task.fingerprint
    ) {
      return undefined;
    }
    return item;
  }

  private noteFill(
    task: FillTask,
    status: NonNullable<UniConnectionSyncDiagnostics["lastFill"]>["status"],
    count?: number,
    error?: unknown,
  ): void {
    this.lastFill = {
      scopedKey: task.scopedKey,
      status,
      count,
      at: this.now(),
      error: error ? String(error).slice(0, 200) : undefined,
    };
  }
}

export const uniConnectionSync = new UniConnectionSync({
  connection: uniConnection,
});
