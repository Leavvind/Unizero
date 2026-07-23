/**
 * 从旧插件 ID 迁移用户设置。
 *
 * 改名链：zotero-reference（`zoteroreference`）→ Zoference（`zoference`）→ UniZero
 * （`unizero`）。所有偏好项的键名都是 `extensions.zotero.<addonRef>.*`——不迁移的话
 * 用户填过的 Semantic Scholar key、提示框颜色、自动刷新白名单等会全部退回默认值，
 * 且旧键还静静留在 profile 里没人再读。
 *
 * 只搬“用户显式改过”的项：Gecko 的 prefHasUserValue 能区分用户值和 prefs.js 里的默认值，
 * 停留在默认值的项没必要搬（两边默认值一致），搬了反而会把旧默认值固化成用户值。
 * 同理，新键若已有用户值就不覆盖——用户在新版里的选择优先于旧版遗留。
 *
 * legacyAddonRefs 按“从新到旧”排列，先命中的先赢：跳过 Zoference 直接从 zotero-reference
 * 升上来的用户同样能迁移，而两代旧键并存时以较新的那代为准。
 */

import { config } from "../../package.json";

const PREFIX = `extensions.zotero.${config.addonRef}.`;
const DONE_PREF = `${config.addonRef}.legacyPrefsMigrated`;

/** 幂等：迁移成功后打标记，之后每次启动只花一次 Prefs.get。 */
export function migrateLegacyPrefs(): void {
  try {
    if (Zotero.Prefs.get(DONE_PREF)) { return; }

    const branch = (Zotero.Prefs as any).rootBranch;
    const migrated: string[] = [];

    for (const legacyRef of config.legacyAddonRefs) {
      const legacyPrefix = `extensions.zotero.${legacyRef}.`;
      const legacyKeys: string[] = branch.getChildList(legacyPrefix) || [];

      for (const legacyKey of legacyKeys) {
        if (!branch.prefHasUserValue(legacyKey)) { continue; }
        const targetKey = PREFIX + legacyKey.slice(legacyPrefix.length);
        // 已有用户值就跳过：可能来自本代，也可能来自更新的那一代 legacy ref。
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
    }

    Zotero.Prefs.set(DONE_PREF, true);
    ztoolkit.log(`UniZero: migrated ${migrated.length} legacy prefs`, migrated);
  } catch (error) {
    // 迁移失败不该拦住插件启动：大不了用户重填一次设置。
    // 不打 DONE 标记，下次启动还会再试一次。
    Zotero.logError(error as Error);
  }
}
