/**
 * 转换功能自己的设置。与 runtime 连接设置分开：这些描述"产物怎么落地"，
 * 换一个 runtime 端口不该影响它们。
 */

import { config } from "../../../package.json";

const PREFIX = `${config.addonRef}.conversion.`;

export interface ConversionSettings {
  /**
   * 除了链接式 Markdown 附件，再往 Zotero storage 里存一份只读副本。
   * 好处是随 Zotero 同步、换机器能看；代价是每次重转都会覆盖。
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
