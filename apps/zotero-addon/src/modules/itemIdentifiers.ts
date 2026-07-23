/**
 * Zotero 条目上的外部论文标识符。
 *
 * DOI 可能在原生字段，也可能落在 Extra；Semantic Scholar Paper ID 没有 Zotero
 * 原生字段，只能约定写入 Extra。把读取规则放在一处，补全、References 和 Citations
 * 才不会出现“已经写入但另一个模块看不见”的情况。
 */

import { bareDOI } from "./scholarlyHttp";

export const S2_ID_FIELD = "Semantic Scholar Paper ID";
export const S2_ID_ALIASES = [
  S2_ID_FIELD,
  "Semantic Scholar Paper",
  "Semantic Scholar ID",
  "S2 Paper ID",
  "S2 ID",
];

export interface ItemPaperIdentifiers {
  doi?: string;
  semanticScholarPaperId?: string;
}

export function getExtraValue(extra: string, aliases: readonly string[]): string | undefined {
  const escaped = aliases.map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`^(?:${escaped.join("|")})\\s*:\\s*(.+)$`, "im");
  return String(extra || "").match(pattern)?.[1]?.trim() || undefined;
}

/** 接受裸 SHA、PaperId: 前缀和 Semantic Scholar 论文页 URL。 */
export function normalizeSemanticScholarPaperId(value?: string): string | undefined {
  const raw = String(value || "").trim();
  if (!raw) { return; }
  const urlMatch = raw.match(
    /semanticscholar\.org\/paper\/(?:[^/]+\/)?([a-f\d]{40})(?:[/?#]|$)/i,
  );
  return (urlMatch?.[1] || raw.replace(/^paperid\s*:\s*/i, "")).trim() || undefined;
}

export function readItemPaperIdentifiers(item: Zotero.Item): ItemPaperIdentifiers {
  const extra = String(item.getField("extra") || "");
  let doi = "";
  try { doi = String(item.getField("DOI") || ""); } catch { /* 此类型没有 DOI 字段 */ }
  if (!doi) {
    try { doi = String(item.getExtraField("DOI") || ""); } catch { /* 未知 Extra 字段 */ }
  }
  doi ||= getExtraValue(extra, ["DOI"]) || "";
  return {
    doi: doi ? bareDOI(doi) : undefined,
    semanticScholarPaperId: normalizeSemanticScholarPaperId(
      getExtraValue(extra, S2_ID_ALIASES),
    ),
  };
}
