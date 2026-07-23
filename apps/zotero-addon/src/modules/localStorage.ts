import { config } from "../../package.json";
import {
  effectiveLibraryID,
  libraryItemIdentity,
  type LibraryScopedItem,
} from "../zotero/libraryScope";

class LocalStorage {
  public filename!: string;
  public cache: any;
  public lock: any;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(filename: string) {
    this.lock = Zotero.Promise.defer()
    this.init(filename)
  }

  async init(filename: string) {
    // `window.OS` (OS.File/OS.Path) was removed from current Zotero versions.
    // The caller passes the add-on name, so preserve the old storage location
    // using nsIFile APIs that are still supported by Zotero.
    this.filename = this.pathFor(filename)
    // 改名前的缓存分别叫 zoference.json / zoteroreference.json，里面是已抓好的参考文献；
    // 读不到新文件就按从新到旧的顺序回退，省掉用户对整个文库重跑一遍解析。
    // 写入始终落到新路径，旧文件留着不动。
    try {
      this.cache = JSON.parse(await Zotero.File.getContentsAsync(this.filename) as string)
      ztoolkit.log(this.cache)
    } catch {
      this.cache = await this.adoptLegacyCache()
    }
    this.lock.resolve()
  }

  private async adoptLegacyCache(): Promise<any> {
    for (const legacyRef of config.legacyAddonRefs) {
      const legacyPath = this.pathFor(legacyRef)
      try {
        const cache = JSON.parse(await Zotero.File.getContentsAsync(legacyPath) as string)
        ztoolkit.log(`UniZero: adopted legacy cache from ${legacyPath}`)
        return cache
      } catch {
        continue
      }
    }
    return {}
  }

  private pathFor(name: string): string {
    const file = Zotero.getTempDirectory().parent;
    file.append(`${name}.json`);
    return file.path;
  }

  private entry(item: LibraryScopedItem): any {
    const scopedKey = libraryItemIdentity(item);
    if (this.cache[scopedKey] === undefined) {
      // Pre-UniZero caches used only item.key. That value is safe to adopt only for
      // the user library; applying it to a group library could return another
      // library's references for a colliding key.
      const userLibraryID = Number(Zotero.Libraries.userLibraryID || 1);
      if (effectiveLibraryID(item) === userLibraryID &&
          this.cache[item.key] !== undefined) {
        this.cache[scopedKey] = this.cache[item.key];
        delete this.cache[item.key];
      } else {
        this.cache[scopedKey] = {};
      }
    }
    return this.cache[scopedKey];
  }

  get(item: LibraryScopedItem, key: string) {
    if (this.cache == undefined) {
      ztoolkit.log("cache is undefined")
      return
    }
    return this.entry(item)[key]
  }

  async set(item: LibraryScopedItem, key: string, value: any) {
    await this.lock.promise;
    this.entry(item)[key] = value

    // Serialize writes and resolve only after persistence. Concurrent set() calls used
    // to start overlapping putContentsAsync operations and could lose the last update
    // when Zotero closed immediately after a refresh.
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await Zotero.File.putContentsAsync(this.filename, JSON.stringify(this.cache));
      });
    this.writeQueue = write;
    await write;
  }
}

export default LocalStorage

