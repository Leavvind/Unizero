/**
 * Zotero annotation excerpts as Zotero copies them to the clipboard. The
 * `zotero://` link is provenance, deliberately never turned into a citation.
 */

export interface ZoteroExcerpt {
  content: string;
  link: string;
  label: string;
  comment?: string;
}

const MARKDOWN_LINK = /\[([^\]]*)\]\(\s*(zotero:\/\/[^\s)]+)\s*\)/gi;
const BARE_LINK = /zotero:\/\/[^\s)\]}>"']+/i;
// Not a page number or part of a longer number.
const YEAR = /(?<!(?:\bpp?\.|第)\s*)(?<![\p{L}\p{N}])(?:19|20)\d{2}[a-z]?(?![\p{L}\p{N}])/iu;

export function formatIncomingText(text: string): string {
  const parsed = parseZoteroExcerpt(text);
  return parsed ? formatExcerpt(parsed) : text;
}

export function formatExcerpt(excerpt: ZoteroExcerpt): string {
  const quote = `${excerpt.content} [${excerpt.label}](${excerpt.link})`;
  return excerpt.comment ? `${quote}\n${excerpt.comment}` : quote;
}

/** `“text” ([label](zotero://select/…)) ([pdf](zotero://open-pdf/…)) comment`; open-pdf carries the page. */
export function parseZoteroExcerpt(text: string): ZoteroExcerpt | null {
  const links = Array.from(text.matchAll(MARKDOWN_LINK));
  if (links.length === 0) { return parseBareLink(text); }

  const first = links[0];
  const last = links[links.length - 1];
  const chosen = links.find((match) => /^zotero:\/\/open-pdf\//i.test(match[2])) ?? first;
  const content = stripQuotes(text.slice(0, first.index).trim().replace(/\($/, ""));
  if (!content) { return null; }

  const link = chosen[2];
  const label = labelFor(first[1], link);
  const comment = text.slice((last.index ?? 0) + last[0].length).replace(/^[\s)]+/, "").trim();
  return comment ? { content, link, label, comment } : { content, link, label };
}

function parseBareLink(text: string): ZoteroExcerpt | null {
  const match = text.match(BARE_LINK);
  if (!match || match.index === undefined) { return null; }
  const content = stripQuotes(text.slice(0, match.index).trim().replace(/\($/, ""));
  return content ? { content, link: match[0], label: "Zotero" } : null;
}

function stripQuotes(text: string): string {
  return text.trim().replace(/^["“]/, "").replace(/["”]$/, "").trim();
}

/** Drop the locator only when the link carries the page. */
function labelFor(label: string, link: string): string {
  if (/[?&]page=/i.test(link)) { return normalizeExcerptLabel(label); }
  return label.trim().replace(/\s+/g, " ") || "Zotero";
}

/** `Smith, 2024, p. 17` → `Smith, 2024`. */
export function normalizeExcerptLabel(label: string): string {
  const cleaned = label.trim().replace(/\s+/g, " ");
  const yearMatch = cleaned.match(YEAR);
  if (!yearMatch || yearMatch.index === undefined) { return cleaned || "Zotero"; }

  const author = cleaned
    .slice(0, yearMatch.index)
    .trim()
    .replace(/[,，、;；\s]+$/u, "");
  return author ? `${author}, ${yearMatch[0]}` : yearMatch[0];
}
