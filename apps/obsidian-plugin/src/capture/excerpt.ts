/**
 * Zotero annotation excerpts, as Zotero copies them to the clipboard.
 *
 * `“Quoted text” ([Smith et al., 2024, p. 17](zotero://open-pdf/...))` becomes
 * `Quoted text [Smith et al., 2024](zotero://open-pdf/...)`.
 *
 * The `zotero://` link is the excerpt's provenance — where it was read — and is
 * deliberately not turned into `@libraryID/itemKey`: a citation is something the
 * user writes on purpose, and the vault index counts every one of them.
 */

export interface ZoteroExcerpt {
  content: string;
  link: string;
  label: string;
}

/** The excerpt form of a Zotero annotation, or the text unchanged. */
export function formatIncomingText(text: string): string {
  const parsed = parseZoteroExcerpt(text);
  return parsed ? formatExcerpt(parsed) : text;
}

export function formatExcerpt(excerpt: ZoteroExcerpt): string {
  return `${excerpt.content} [${excerpt.label}](${excerpt.link})`;
}

export function parseZoteroExcerpt(text: string): ZoteroExcerpt | null {
  const linkMatch = text.match(/zotero:\/\/[^\s)\]}>"']+/i);
  if (!linkMatch || linkMatch.index === undefined) { return null; }

  const link = linkMatch[0];
  const beforeLink = text.slice(0, linkMatch.index);
  const labelMatch = beforeLink.match(/\[([^\]]+)\]\(\s*$/);
  const label = normalizeExcerptLabel(labelMatch?.[1] ?? "Zotero");
  const quoted = beforeLink.match(/^[\s]*["“]([\s\S]+)["”]\s*\(\s*\[[\s\S]*$/);

  let content: string;
  if (quoted?.[1]) {
    content = quoted[1];
  } else {
    const citationStart = beforeLink.lastIndexOf("([");
    content = (citationStart > 0 ? beforeLink.slice(0, citationStart) : beforeLink)
      .trim()
      .replace(/^["“]/, "")
      .replace(/["”]\s*$/, "");
  }

  if (!content) { return null; }
  return { content, link, label };
}

/** `Smith, 2024, p. 17` → `Smith, 2024`: the page already lives in the link. */
export function normalizeExcerptLabel(label: string): string {
  const cleaned = label.trim().replace(/\s+/g, " ");
  const yearMatch = cleaned.match(/(?:19|20)\d{2}[a-z]?/i);
  if (!yearMatch || yearMatch.index === undefined) { return cleaned || "Zotero"; }

  const author = cleaned
    .slice(0, yearMatch.index)
    .trim()
    .replace(/[,，、;；\s]+$/u, "");
  return author ? `${author}, ${yearMatch[0]}` : yearMatch[0];
}
