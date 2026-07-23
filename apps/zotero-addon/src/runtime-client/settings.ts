/**
 * Connection and process settings for the paper runtime.
 *
 * ZoMiner kept these keys under `extensions.zominer.*` (the global branch of
 * Zotero.Prefs); UniZero collects them under
 * `extensions.zotero.unizero.runtime.*`. See migrateLegacyRuntimePrefs() for the
 * migration.
 */

import { config } from "../../package.json";

const PREFIX = `${config.addonRef}.runtime.`;

/** ZoMiner's legacy key prefix. It sits on the global Prefs branch, not under extensions.zotero.*. */
const LEGACY_PREFIX = "extensions.zominer.";

const DEFAULT_PORT = 23300;

export interface RuntimeSettings {
  /** Absolute path to the Python interpreter; empty means auto-detect. */
  pythonPath: string;
  /**
   * Absolute path to server.py. **Optional** — when empty, launch.ts searches for
   * an installed runtime in its own order.
   *
   * When set it is always used, including the migrated-from-ZoMiner case where it
   * still points at the old paper_service/server.py.
   */
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

/**
 * Fall back to the default rather than throwing on an invalid port. Starting the
 * process and building the URL must use the same value.
 */
export function servicePort(): number {
  return parseInt(String(read("port")), 10) || DEFAULT_PORT;
}

/** The runtime listens only on the loopback address. */
export function serviceURL(): string {
  return `http://127.0.0.1:${servicePort()}`;
}

const DONE_PREF = `${config.addonRef}.legacyRuntimePrefsMigrated`;

/**
 * Migrate settings once from ZoMiner's `extensions.zominer.*`.
 *
 * Kept separate from migrateLegacyPrefs() because the two sets of legacy keys are
 * not even on the same Prefs branch: Zoference's live under
 * `extensions.zotero.<ref>.*`, ZoMiner's under `extensions.zominer.*`. Merging
 * them into one function would only let the two branch conditions interfere.
 *
 * Only values the user explicitly set are moved, and existing user values on the
 * new keys are never overwritten — same reasoning as migrate.ts.
 */
export function migrateLegacyRuntimePrefs(): void {
  try {
    if (Zotero.Prefs.get(DONE_PREF)) { return; }

    const branch = (Zotero.Prefs as any).rootBranch;
    const migrated: string[] = [];

    // Key names are listed one by one rather than walking the legacy branch:
    // ZoMiner's branch may still hold retired experimental keys, and moving the
    // whole branch would inherit the junk along with it.
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

    // mdSnapshot belongs to the conversion feature, not the runtime connection,
    // so it lands in the conversion namespace.
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
    // As in migrate.ts: a failed migration is not marked done, so the next start
    // retries it; it must never block the add-on from loading.
    Zotero.logError(error as Error);
  }
}
