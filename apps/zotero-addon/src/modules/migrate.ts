/**
 * Migrate user settings from older add-on IDs.
 *
 * The rename chain is zotero-reference (`zoteroreference`) → Zoference
 * (`zoference`) → UniZero (`unizero`). Every preference key is
 * `extensions.zotero.<addonRef>.*`, so without migration the user's Semantic
 * Scholar key, tooltip colours, auto-refresh exclusions, and the rest all revert
 * to defaults while the old keys sit unread in the profile.
 *
 * Only settings the user explicitly changed are moved: Gecko's prefHasUserValue
 * distinguishes a user value from a default declared in prefs.js. Anything still
 * at its default needs no move — the defaults match on both sides — and moving it
 * would freeze the old default in place as a user value. For the same reason, a
 * new key that already has a user value is never overwritten: the user's choice in
 * the current version outranks anything left over from an older one.
 *
 * legacyAddonRefs is ordered newest to oldest and the first hit wins, so a user
 * upgrading straight from zotero-reference and skipping Zoference still migrates,
 * while a profile holding both generations follows the newer one.
 */

import { config } from "../../package.json";

const PREFIX = `extensions.zotero.${config.addonRef}.`;
const DONE_PREF = `${config.addonRef}.legacyPrefsMigrated`;

/** Idempotent: a successful migration sets a flag, so later starts cost one Prefs.get. */
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
        // Skip anything that already has a user value: it may come from this
        // generation, or from a newer legacy ref.
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
    // A failed migration must not block startup: at worst the user re-enters the
    // settings. The DONE flag is left unset so the next start tries again.
    Zotero.logError(error as Error);
  }
}
