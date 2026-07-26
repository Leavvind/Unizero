/**
 * Per-item cache storage.
 *
 * The cache used to be one JSON document holding every item in the library. Each
 * `set()` re-serialised that whole document, and the whole thing stayed resident in
 * memory for the lifetime of the session — for a store whose per-item payload is a
 * fully resolved reference list plus a paged citation list, i.e. hundreds of
 * kilobytes per paper. It also had no removal path at all: an entry outlived the
 * item it described.
 *
 * So one file per item now:
 *
 *     <Zotero data directory>/unizero/cache/<libraryID>/<itemKey>.json
 *
 * A write touches one item's bytes; only the items actually looked at are held in
 * memory; and a shard whose item no longer exists can simply be deleted. File mtime
 * doubles as a per-item dirty marker, which is what a future cross-item index would
 * need to stay incremental instead of rebuilding from scratch.
 *
 * `get()` stays synchronous, because its callers include a sync render path
 * (views.ts selectTab). Reading is therefore a two-step: `await load(item)` first —
 * the item pane's async render phase is the natural place — and every `get()` after
 * that is a memory hit.
 */

import { config } from "../../package.json";
import {
  effectiveLibraryID,
  libraryItemIdentity,
  type LibraryScopedItem,
} from "../zotero/libraryScope";

/**
 * Shard file format version.
 *
 * Version 1 was the single-document cache. The records inside a shard keep their own
 * versioned keys (`References-Resolved-v1`), so this number describes the envelope
 * only.
 */
const SHARD_SCHEMA = 2;

/**
 * How many shards stay in memory.
 *
 * Sized for "the items one reading session touches", not for the library: the point
 * of sharding was to stop holding all of it. A miss costs one small file read.
 */
const RESIDENT_SHARDS = 32;

interface Shard {
  schema: number;
  libraryID: number;
  key: string;
  updatedAt: number;
  records: Record<string, any>;
}

function emptyShard(item: LibraryScopedItem): Shard {
  return {
    schema: SHARD_SCHEMA,
    libraryID: effectiveLibraryID(item),
    key: item.key,
    updatedAt: 0,
    records: {},
  };
}

export class LocalStorage {
  /** Root of the shard tree; surfaced by UniZeroDebug(). */
  public directory!: string;
  /** The add-on's data directory: parent of both the shard tree and graph layouts. */
  public root!: string;
  public lock: any;
  /** Resident shards, most-recently-used last (Map preserves insertion order). */
  private resident = new Map<string, Shard>();
  /** Serialises writes per shard, so two saves for one item cannot interleave. */
  private writes = new Map<string, Promise<void>>();
  /** One writer per layout file; both graph views share the same file and tmp path. */
  private graphWrites = new Map<number, Promise<void>>();

  constructor(name: string) {
    this.lock = Zotero.Promise.defer();
    this.init(name);
  }

  private async init(name: string) {
    try {
      this.root = PathUtils.join(dataDirectory(), name);
      this.directory = PathUtils.join(this.root, "cache");
      await IOUtils.makeDirectory(this.directory, {
        createAncestors: true,
        ignoreExisting: true,
      });
      await this.importSingleDocumentCache(name);
    } catch (error) {
      ztoolkit.log(`cache directory unavailable: ${error}`);
    }
    this.lock.resolve();
    // Sweeping reads every shard's filename and asks Zotero whether the item still
    // exists. Deliberately after the lock: it is housekeeping, and no read should
    // wait behind it.
    this.sweep().catch((error) => ztoolkit.log(`cache sweep failed: ${error}`));
  }

  // --------------------------------------------------------------- Reading

  /**
   * Bring one item's shard into memory. Safe to call repeatedly; a missing file is a
   * normal outcome and produces an empty shard rather than an error.
   */
  async load(item: LibraryScopedItem): Promise<void> {
    await this.lock.promise;
    const scopedKey = libraryItemIdentity(item);
    if (this.resident.has(scopedKey)) {
      // Re-insert so this shard counts as most recently used.
      const shard = this.resident.get(scopedKey)!;
      this.resident.delete(scopedKey);
      this.resident.set(scopedKey, shard);
      return;
    }

    let shard = emptyShard(item);
    try {
      const parsed = JSON.parse(await IOUtils.readUTF8(this.pathFor(item)) as string);
      if (parsed && typeof parsed === "object" && parsed.records) {
        shard = { ...emptyShard(item), ...parsed, records: parsed.records };
      }
    } catch (error) {
      // No shard yet, or an unreadable one. Either way the item simply has no cache;
      // an unreadable file is overwritten by the next successful save.
      if (!isMissingFile(error)) {
        ztoolkit.log(`cache shard unreadable for ${scopedKey}: ${error}`);
      }
    }
    this.resident.set(scopedKey, shard);
    this.evict();
  }

  /**
   * Read one record. Requires a prior `load()` for this item — an unloaded item
   * reads as a miss, which degrades to re-fetching rather than to wrong data.
   */
  get(item: LibraryScopedItem, key: string): any {
    const shard = this.resident.get(libraryItemIdentity(item));
    if (!shard) {
      ztoolkit.log(`cache read before load for ${libraryItemIdentity(item)}`);
      return undefined;
    }
    return shard.records[key];
  }

  /**
   * Read one record straight from its shard without admitting that shard to the
   * resident LRU.
   *
   * Whole-library derived indexes use this path: cycling hundreds of items through
   * `load()` would evict the small working set kept for the item pane. A pending
   * write for this item is awaited first so a build started immediately after a
   * save cannot observe the previous file contents.
   */
  async readRecordDirect(item: LibraryScopedItem, key: string): Promise<any> {
    await this.lock.promise;
    const scopedKey = libraryItemIdentity(item);
    const pending = this.writes.get(scopedKey);
    if (pending) {
      try {
        await pending;
      } catch {
        // The direct read below is still useful after a failed write: it returns
        // the last complete shard, or a normal cache miss.
      }
    }
    try {
      const shard = JSON.parse(await IOUtils.readUTF8(this.pathFor(item)) as string);
      return shard?.records?.[key];
    } catch (error) {
      if (!isMissingFile(error)) {
        ztoolkit.log(`cache shard unreadable for ${scopedKey}: ${error}`);
      }
      return undefined;
    }
  }

  // ------------------------------------------------------- Library-wide records

  /**
   * Graph layout coordinates, one file per library.
   *
   * Deliberately outside the shard tree: those files are keyed by item and swept
   * when their item disappears, which would delete a layout on every startup.
   * Layout is also disposable — a miss costs one force simulation, never data —
   * so it is read and written best-effort and never blocks a render.
   */
  private layoutPath(libraryID: number): string {
    return PathUtils.join(this.root, "graph", `${libraryID}.json`);
  }

  async readGraphLayout(libraryID: number): Promise<any> {
    await this.lock.promise;
    try {
      return JSON.parse(await IOUtils.readUTF8(this.layoutPath(libraryID)) as string);
    } catch (error) {
      if (!isMissingFile(error)) {
        ztoolkit.log(`graph layout unreadable for ${libraryID}: ${error}`);
      }
      return undefined;
    }
  }

  async writeGraphLayout(libraryID: number, payload: any): Promise<void> {
    await this.lock.promise;
    const write = (this.graphWrites.get(libraryID) || Promise.resolve())
      .catch(() => undefined)
      .then(() => this.persistGraphLayout(libraryID, payload));
    this.graphWrites.set(libraryID, write);
    try {
      await write;
    } finally {
      if (this.graphWrites.get(libraryID) === write) {
        this.graphWrites.delete(libraryID);
      }
    }
  }

  private async persistGraphLayout(libraryID: number, payload: any): Promise<void> {
    try {
      // Inside the try: a failed init leaves no root, and a missing layout must
      // stay a silent miss rather than break the caller's render.
      const path = this.layoutPath(libraryID);
      await IOUtils.makeDirectory(PathUtils.parent(path)!, {
        createAncestors: true,
        ignoreExisting: true,
      });
      await IOUtils.writeUTF8(path, JSON.stringify(payload), {
        tmpPath: `${path}.tmp`,
      });
    } catch (error) {
      ztoolkit.log(`graph layout unwritable for ${libraryID}: ${error}`);
    }
  }

  /**
   * Graph display and force settings — one file for every library, because they
   * describe how the user wants graphs drawn, not anything about a library's
   * contents. Disposable in the same way layouts are: a miss means defaults.
   */
  private settingsPath(): string {
    return PathUtils.join(this.root, "graph", "settings.json");
  }

  async readGraphSettings(): Promise<any> {
    await this.lock.promise;
    try {
      return JSON.parse(await IOUtils.readUTF8(this.settingsPath()) as string);
    } catch (error) {
      if (!isMissingFile(error)) {
        ztoolkit.log(`graph settings unreadable: ${error}`);
      }
      return undefined;
    }
  }

  async writeGraphSettings(payload: any): Promise<void> {
    await this.lock.promise;
    try {
      const path = this.settingsPath();
      await IOUtils.makeDirectory(PathUtils.parent(path)!, {
        createAncestors: true,
        ignoreExisting: true,
      });
      await IOUtils.writeUTF8(path, JSON.stringify(payload), { tmpPath: `${path}.tmp` });
    } catch (error) {
      ztoolkit.log(`graph settings unwritable: ${error}`);
    }
  }

  // --------------------------------------------------------------- Writing

  async set(item: LibraryScopedItem, key: string, value: any): Promise<void> {
    await this.load(item);
    const scopedKey = libraryItemIdentity(item);
    const shard = this.resident.get(scopedKey)!;
    shard.records[key] = value;
    shard.updatedAt = Date.now();

    // Chain onto this shard's own pending write only. Concurrent saves for different
    // items no longer queue behind each other, which they did when every save
    // rewrote one shared document.
    const write = (this.writes.get(scopedKey) || Promise.resolve())
      .catch(() => undefined)
      .then(() => this.persist(item, shard));
    this.writes.set(scopedKey, write);
    try {
      await write;
    } finally {
      if (this.writes.get(scopedKey) === write) { this.writes.delete(scopedKey); }
    }
  }

  private async persist(item: LibraryScopedItem, shard: Shard): Promise<void> {
    const path = this.pathFor(item);
    await IOUtils.makeDirectory(PathUtils.parent(path)!, {
      createAncestors: true,
      ignoreExisting: true,
    });
    // Written through a temp file: a crash mid-write would otherwise leave truncated
    // JSON, and this shard is the only copy of that item's resolved list.
    await IOUtils.writeUTF8(path, JSON.stringify(shard), { tmpPath: `${path}.tmp` });
  }

  // -------------------------------------------------------------- Diagnostics

  /**
   * What is actually on disk, for UniZeroDebug().
   *
   * Reads the most recently written shards rather than all of them: the question
   * this answers is "did the save I just triggered land, and with what", and a
   * whole-library scan would make the debug call itself expensive.
   */
  async summary(limit = 50): Promise<any> {
    const result = {
      directory: this.directory,
      resident: this.resident.size,
      shards: 0,
      recent: [] as any[],
    };
    if (!this.directory) { return result; }
    const found: { path: string; scopedKey: string; modified: number }[] = [];
    for (const libraryDirectory of await IOUtils.getChildren(this.directory)) {
      const libraryID = PathUtils.filename(libraryDirectory);
      for (const path of await IOUtils.getChildren(libraryDirectory)) {
        if (!path.endsWith(".json")) { continue; }
        const stat = await IOUtils.stat(path);
        found.push({
          path,
          scopedKey: `${libraryID}:${PathUtils.filename(path).slice(0, -".json".length)}`,
          modified: Number(stat.lastModified || 0),
        });
      }
    }
    result.shards = found.length;
    found.sort((a, b) => b.modified - a.modified);
    for (const entry of found.slice(0, limit)) {
      try {
        const shard = JSON.parse(await IOUtils.readUTF8(entry.path) as string);
        result.recent.push({
          item: entry.scopedKey,
          updatedAt: new Date(shard.updatedAt || entry.modified).toLocaleString(),
          records: Object.keys(shard.records || {}),
          counts: Object.fromEntries(
            Object.entries(shard.records || {}).map(([key, record]: [string, any]) => [
              key,
              record?.references?.length ?? record?.all?.length,
            ]),
          ),
        });
      } catch (error) {
        result.recent.push({ item: entry.scopedKey, error: String(error) });
      }
    }
    return result;
  }

  // ------------------------------------------------------------ Housekeeping

  private pathFor(item: LibraryScopedItem): string {
    return PathUtils.join(
      this.directory,
      String(effectiveLibraryID(item)),
      `${item.key}.json`,
    );
  }

  /** Drop the least recently used shards, skipping any with a write in flight. */
  private evict(): void {
    for (const scopedKey of this.resident.keys()) {
      if (this.resident.size <= RESIDENT_SHARDS) { return; }
      if (this.writes.has(scopedKey)) { continue; }
      this.resident.delete(scopedKey);
    }
  }

  /**
   * Delete shards whose item is gone from the library.
   *
   * The condition is deletion, not age: a resolved reference list does not go stale
   * on a clock, and expiring one by mtime would throw away a result that cost
   * hundreds of metadata lookups in exchange for disk space that is measured in
   * kilobytes. Identifier changes are handled at read time by the callers, which
   * compare the stored DOI against the item's current one.
   */
  private async sweep(): Promise<void> {
    if (!this.directory) { return; }
    for (const libraryDirectory of await IOUtils.getChildren(this.directory)) {
      const libraryID = Number(PathUtils.filename(libraryDirectory));
      if (!Number.isFinite(libraryID)) { continue; }
      // A library that is not currently loaded (a group still syncing, say) would
      // report every one of its items as missing.
      if (!Zotero.Libraries.exists(libraryID)) { continue; }
      let removed = 0;
      for (const path of await IOUtils.getChildren(libraryDirectory)) {
        const filename = PathUtils.filename(path);
        if (!filename.endsWith(".json")) { continue; }
        const itemKey = filename.slice(0, -".json".length);
        try {
          if (await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey)) { continue; }
          await IOUtils.remove(path, { ignoreAbsent: true });
          this.resident.delete(`${libraryID}:${itemKey}`);
          removed += 1;
        } catch (error) {
          ztoolkit.log(`cache sweep skipped ${path}: ${error}`);
        }
      }
      if (removed) { ztoolkit.log(`cache sweep removed ${removed} shard(s) in ${libraryID}`); }
    }
  }

  /**
   * One-shot import of the pre-sharding cache.
   *
   * This runs in place of the old read-time fallback through the previous add-on
   * names, which existed so a rename would not force the user to re-resolve the
   * whole library. That fallback is retired here — after the import there is no
   * legacy read path left — but the import itself still looks at the old names,
   * because the cost of not doing so is paid by the user in hundreds of API calls.
   *
   * The source file is renamed rather than deleted, so a failed import can still be
   * inspected.
   */
  private async importSingleDocumentCache(name: string): Promise<void> {
    for (const candidate of [name, ...config.legacyAddonRefs]) {
      const path = PathUtils.join(dataDirectory(), `${candidate}.json`);
      let document: any;
      try {
        document = JSON.parse(await IOUtils.readUTF8(path) as string);
      } catch (error) {
        continue;
      }
      if (!document || typeof document !== "object") { continue; }

      let imported = 0;
      for (const [entryKey, records] of Object.entries(document)) {
        if (!records || typeof records !== "object" || !Object.keys(records).length) {
          continue;
        }
        // Entries are `libraryID:itemKey`; anything older is a bare item key, which
        // was only ever written for the user library.
        const [scopeOrKey, maybeKey] = entryKey.split(":");
        const item: LibraryScopedItem = maybeKey
          ? { libraryID: Number(scopeOrKey), key: maybeKey }
          : { libraryID: Number(Zotero.Libraries.userLibraryID || 1), key: scopeOrKey };
        if (!item.key || !Number.isFinite(effectiveLibraryID(item))) { continue; }
        try {
          const shard = emptyShard(item);
          shard.updatedAt = Date.now();
          shard.records = records as Record<string, any>;
          await this.persist(item, shard);
          imported += 1;
        } catch (error) {
          ztoolkit.log(`cache import failed for ${entryKey}: ${error}`);
        }
      }

      try {
        await IOUtils.move(path, `${path}.migrated`, { noOverwrite: false });
      } catch (error) {
        ztoolkit.log(`cache import could not retire ${path}: ${error}`);
      }
      ztoolkit.log(`cache import: ${imported} item(s) from ${path}`);
      return;
    }
  }
}

/**
 * The Zotero data directory.
 *
 * `Zotero.DataDirectory.dir` is the direct answer; the temp-directory parent is what
 * this module used before that API was relied on, and is kept as the fallback so a
 * missing internal API degrades to the old location instead of losing the cache.
 */
function dataDirectory(): string {
  const dir = (Zotero as any).DataDirectory?.dir;
  if (typeof dir === "string" && dir) { return dir; }
  return Zotero.getTempDirectory().parent.path;
}

function isMissingFile(error: any): boolean {
  return error?.name === "NotFoundError" || error?.name === "NotAllowedError";
}

export default LocalStorage

/** One cache instance shared by Views and whole-library derived readers. */
export const localStorage = new LocalStorage(config.addonRef);
