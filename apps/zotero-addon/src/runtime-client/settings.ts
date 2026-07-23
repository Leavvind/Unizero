/**
 * Paper runtime 的连接与进程设置。
 *
 * ZoMiner 把这些键放在 `extensions.zominer.*`（Zotero.Prefs 的 global 分支），UniZero
 * 统一收进 `extensions.zotero.unizero.runtime.*`。迁移见 migrateLegacyRuntimePrefs()。
 */

import { config } from "../../package.json";

const PREFIX = `${config.addonRef}.runtime.`;

/** ZoMiner 的旧键前缀。它在 Prefs 的 global 分支上，不在 extensions.zotero.* 下面。 */
const LEGACY_PREFIX = "extensions.zominer.";

const DEFAULT_PORT = 23300;

export interface RuntimeSettings {
  /** Python 解释器绝对路径；留空则自动探测。 */
  pythonPath: string;
  /** paper runtime 的 server.py 绝对路径。没有默认值，必须由用户配置。 */
  serverScript: string;
  port: number;
  autoStart: boolean;
  autoStopOnQuit: boolean;
}

export const RUNTIME_PREF_DEFAULTS: RuntimeSettings = {
  pythonPath: "",
  serverScript: "",
  port: DEFAULT_PORT,
  autoStart: true,
  autoStopOnQuit: true,
};

function read<K extends keyof RuntimeSettings>(name: K): RuntimeSettings[K] {
  const value = Zotero.Prefs.get(PREFIX + name, true);
  return (value === undefined ? RUNTIME_PREF_DEFAULTS[name] : value) as RuntimeSettings[K];
}

export function getRuntimePref<K extends keyof RuntimeSettings>(
  name: K,
): RuntimeSettings[K] {
  return read(name);
}

export function setRuntimePref<K extends keyof RuntimeSettings>(
  name: K,
  value: RuntimeSettings[K],
): void {
  Zotero.Prefs.set(PREFIX + name, value as string | number | boolean, true);
}

/** runtime 只监听回环地址；端口非法时退回默认值而不是抛错。 */
export function serviceURL(): string {
  const port = parseInt(String(read("port")), 10) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

const DONE_PREF = `${config.addonRef}.legacyRuntimePrefsMigrated`;

/**
 * 从 ZoMiner 的 `extensions.zominer.*` 搬一次设置。
 *
 * 和 migrateLegacyPrefs() 分开是因为两者的旧键根本不在同一个 Prefs 分支上：Zoference
 * 的旧键在 `extensions.zotero.<ref>.*`，ZoMiner 的在 `extensions.zominer.*`。合并成
 * 一个函数只会让两边的分支逻辑互相干扰。
 *
 * 只搬用户显式设过的值，且不覆盖新键上已有的用户值——理由同 migrate.ts。
 */
export function migrateLegacyRuntimePrefs(): void {
  try {
    if (Zotero.Prefs.get(DONE_PREF)) { return; }

    const branch = (Zotero.Prefs as any).rootBranch;
    const migrated: string[] = [];

    // 键名逐个列出而不是遍历旧分支：ZoMiner 的旧分支里可能还留着已废弃的实验键，
    // 整支搬过来等于把垃圾一起继承。
    const names: Array<keyof RuntimeSettings> = [
      "pythonPath", "serverScript", "port", "autoStart", "autoStopOnQuit",
    ];

    for (const name of names) {
      const legacyKey = LEGACY_PREFIX + name;
      if (!branch.prefHasUserValue(legacyKey)) { continue; }
      const targetKey = `extensions.zotero.${PREFIX}${name}`;
      if (branch.prefHasUserValue(targetKey)) { continue; }

      switch (branch.getPrefType(legacyKey)) {
        case branch.PREF_BOOL:
          branch.setBoolPref(targetKey, branch.getBoolPref(legacyKey));
          break;
        case branch.PREF_INT:
          branch.setIntPref(targetKey, branch.getIntPref(legacyKey));
          break;
        case branch.PREF_STRING:
          branch.setStringPref(targetKey, branch.getStringPref(legacyKey));
          break;
        default:
          continue;
      }
      migrated.push(targetKey);
    }

    // mdSnapshot 属于转换功能而不是 runtime 连接，落到 conversion 命名空间下。
    const legacySnapshot = `${LEGACY_PREFIX}mdSnapshot`;
    const snapshotTarget = `extensions.zotero.${config.addonRef}.conversion.mdSnapshot`;
    if (branch.prefHasUserValue(legacySnapshot) &&
        !branch.prefHasUserValue(snapshotTarget)) {
      branch.setBoolPref(snapshotTarget, branch.getBoolPref(legacySnapshot));
      migrated.push(snapshotTarget);
    }

    Zotero.Prefs.set(DONE_PREF, true);
    ztoolkit.log(`UniZero: migrated ${migrated.length} legacy runtime prefs`, migrated);
  } catch (error) {
    // 同 migrate.ts：迁移失败不打标记，下次启动重试，绝不拦住插件加载。
    Zotero.logError(error as Error);
  }
}
