/**
 * Vault Raw ↔ Zotero paper identity matching.
 *
 * Pure helpers only — no Obsidian or Electron imports — so Vitest can cover
 * them without the host packages.
 *
 * Conversion publishes title-named Markdown with frontmatter:
 *   uid: <itemKey>
 *   unizero-item: <libraryID>:<itemKey>
 *   citekey: …
 * Older runs may use `unizero-<libraryID>-<itemKey>` as uid, or lack identity
 * fields entirely (Open Raw then prompts to pick a vault file).
 */

export interface RawMatchPaper {
  itemKey: string;
  libraryID?: number;
  citekey?: string;
}

export interface RawMatchSettings {
  itemKeyProperty: string;
  citekeyProperty: string;
}

/**
 * How a vault file's frontmatter can identify a paper.
 *
 * Conversion writes `uid` and `unizero-item`. Settings properties
 * (`zotero-key`, `citekey`) are user-configured extras and are also written
 * when Open Raw has to pick a file.
 */
export type RawFrontmatterMatch =
  | "itemKeyProperty"
  | "uid"
  | "unizero-item"
  | "citekeyProperty";

/**
 * Pure frontmatter match.
 *
 * Preference order for a *hit* that should win over a citekey-only scan:
 * itemKey property → uid → unizero-item. Citekey is a weaker fallback.
 */
export function matchRawFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
  paper: RawMatchPaper,
  settings: RawMatchSettings,
): RawFrontmatterMatch | undefined {
  if (!frontmatter) { return undefined; }

  if (String(frontmatter[settings.itemKeyProperty] || "") === paper.itemKey) {
    return "itemKeyProperty";
  }

  const uid = String(frontmatter.uid || "").trim();
  if (uid === paper.itemKey) {
    return "uid";
  }
  if (
    paper.libraryID != null
    && uid === `unizero-${paper.libraryID}-${paper.itemKey}`
  ) {
    return "uid";
  }

  if (paper.libraryID != null) {
    const unizeroItem = String(frontmatter["unizero-item"] || "").trim();
    if (unizeroItem === `${paper.libraryID}:${paper.itemKey}`) {
      return "unizero-item";
    }
  }

  if (
    paper.citekey
    && String(frontmatter[settings.citekeyProperty] || "") === paper.citekey
  ) {
    return "citekeyProperty";
  }

  return undefined;
}
