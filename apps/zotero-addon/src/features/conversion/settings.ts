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
  /**
   * Obsidian vault holding the converted Markdown, used to open a note by its
   * frontmatter `uid` through the Advanced URI plugin. Empty falls back to
   * opening by absolute path, which does not survive a rename inside the vault.
   */
  obsidianVault: string;
  /**
   * Template a conversion uses when none is named: the bridge's `POST /convert`
   * (Obsidian's "Zotero default", the MCP server's `convert_paper`) and the item
   * menu's offline entry. Shipped as Journal Papers, which publishes Raw.
   */
  defaultTemplate: string;
}

export const CONVERSION_PREF_DEFAULTS: ConversionSettings = {
  mdSnapshot: true,
  obsidianVault: "",
  defaultTemplate: "paper-to-markdown",
};

/** The runtime's own template-id rule (`_SAFE_ID` in pipeline/templates.py). */
export const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;

/** The default template id, falling back to the shipped one when the pref is not an id. */
export function defaultTemplateId(): string {
  const saved = String(getConversionPref("defaultTemplate") || "").trim();
  return TEMPLATE_ID.test(saved) ? saved : CONVERSION_PREF_DEFAULTS.defaultTemplate;
}

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
  Zotero.Prefs.set(PREFIX + name, value as string | boolean, true);
}
