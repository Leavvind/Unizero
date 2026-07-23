import { config } from "../../package.json";

class LocalStorage {
  public filename!: string;
  public cache: any;
  public lock: any;
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

  get(item: Zotero.Item | { key: string }, key: string) {
    if (this.cache == undefined) {
      ztoolkit.log("cache is undefined")
      return
    }
    return (this.cache[item.key] ??= {})[key]
  }

  async set(item: Zotero.Item | { key: string }, key: string, value: any) {
    await this.lock.promise;
    (this.cache[item.key] ??= {})[key] = value
    window.setTimeout(async () => {
      await Zotero.File.putContentsAsync(this.filename, JSON.stringify(this.cache));
    })
  }
}

export default LocalStorage

