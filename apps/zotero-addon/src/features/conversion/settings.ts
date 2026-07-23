/**
 * Settings owned by the conversion feature. Kept apart from the runtime
 * connection settings: these describe how artifacts land, and changing the
 * runtime port should not affect them.
 */

import { config } from "../../../package.json";

const PREFIX = `${config.addonRef}.conversion.`;

export interface ConversionSettings {
  /**
   * Alongside the linked Markdown attachment, keep a read-only copy in Zotero
   * storage. It travels with Zotero sync and is readable on another machine, at
   * the cost of being overwritten on every re-conversion.
   */
  mdSnapshot: boolean;
}

export const CONVERSION_PREF_DEFAULTS: ConversionSettings = {
  mdSnapshot: true,
};

export function getConversionPref<K extends keyof ConversionSettings>(
  name: K,
): ConversionSettings[K] {
  const value = Zotero.Prefs.get(PREFIX + name, true);
  return (value === undefined
    ? CONVERSION_PREF_DEFAULTS[name]
    : value) as ConversionSettings[K];
}

export function setConversionPref<K extends keyof ConversionSettings>(
  name: K,
  value: ConversionSettings[K],
): void {
  Zotero.Prefs.set(PREFIX + name, value as boolean, true);
}
