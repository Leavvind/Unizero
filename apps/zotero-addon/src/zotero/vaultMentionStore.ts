/**
 * Keeps the Vault mention snapshots the Obsidian plugin sends
 * (src/modules/vaultMentionIndex.ts, docs/UNICONNECTION.md §3).
 *
 * The snapshots are cached in `vault-mentions.json` in the add-on's data folder so
 * Uniconnection still shows them after Zotero restarts while Obsidian is closed.
 * The file is derived state: deleting it only empties the Vault side until the
 * plugin's next push. Nothing here touches a Zotero item.
 */

import { addonDataDirectory } from "../modules/localStorage";
import { VaultMentionIndex, type VaultSnapshot } from "../modules/vaultMentionIndex";
import { isMissingFile } from "../utils/fileState";

const FILE = "vault-mentions.json";

class VaultMentionStore {
  public readonly index = new VaultMentionIndex();
  private loading?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  private path(): string {
    return PathUtils.join(addonDataDirectory(), FILE);
  }

  /** Reads the cache file once; later calls wait on the same read. */
  public ready(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        try {
          // A snapshot pushed before the read finished is newer than the file.
          const pushed = new Map(this.index.snapshots().map((snapshot) => [snapshot.vaultID, snapshot]));
          this.index.restore(JSON.parse(String(await IOUtils.readUTF8(this.path()))));
          for (const snapshot of pushed.values()) { this.index.put(snapshot); }
        } catch (error) {
          if (!isMissingFile(error)) { ztoolkit.log("[vault-mentions] cache unreadable", error); }
        }
      })();
    }
    return this.loading;
  }

  /** Replace one Vault's snapshot, save the cache file, and tell open views. */
  public async put(snapshot: VaultSnapshot): Promise<void> {
    await this.ready();
    this.index.put(snapshot);
    const value = JSON.stringify(this.index.toJSON());
    // Saves run one after another, so an older one can never land last.
    this.writing = this.writing.then(async () => {
      const path = this.path();
      await IOUtils.makeDirectory(PathUtils.parent(path)!, { createAncestors: true, ignoreExisting: true });
      await IOUtils.writeUTF8(path, value, { tmpPath: `${path}.tmp` });
    }).catch((error) => { ztoolkit.log("[vault-mentions] cache not saved", error); });
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { ztoolkit.log("[vault-mentions] listener failed", error); }
    }
    await this.writing;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Forget the in-memory copy at shutdown; the file stays for the next start. */
  public shutdown(): void {
    this.listeners.clear();
    this.index.clear();
    this.loading = undefined;
  }
}

/** One store for the bridge and every window. */
export const vaultMentions = new VaultMentionStore();
