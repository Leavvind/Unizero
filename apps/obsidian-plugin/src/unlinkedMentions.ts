/**
 * Unlinked mentions: plain-text occurrences of a note's title or aliases in other
 * Vault notes. Pure text scanning, so the Backlinks pane can list them beside
 * linked references. Zotero documents are never scanned: they are long, and a
 * mention there cannot be linked without editing a Zotero attachment.
 */

export interface Mention {
  /** Offsets of the matched text in the source document. */
  from: number;
  to: number;
  /** Zero-based line and column of `from`. */
  line: number;
  ch: number;
  lineText: string;
  /** The text as written, which may differ in case from the title. */
  text: string;
}

/** Scripts written with spaces between words: a match there must stand as a whole word. */
const WORD_CHAR = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}_]/u;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Spans a mention cannot sit in: frontmatter, code, comments, links, URLs and link definitions. */
export function excludedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (frontmatter) { spans.push([0, frontmatter[0].length]); }
  // Fenced code, line by line, so an unclosed fence runs to the end like Markdown's.
  let offset = 0, fence: { marker: string; from: number } | undefined;
  for (const line of text.split("\n")) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence.marker[0] && open[1].length >= fence.marker.length && !line.slice(open[0].length).trim()) {
        spans.push([fence.from, offset + line.length]); fence = undefined;
      }
    } else if (open) { fence = { marker: open[1], from: offset }; }
    offset += line.length + 1;
  }
  if (fence) { spans.push([fence.from, text.length]); }
  for (const pattern of [
    /<!--[\s\S]*?-->/g, /%%[\s\S]*?%%/g, /`[^`\n]+`/g,
    /!?\[\[[^\]\n]*\]\]/g, /!?\[[^\]\n]*\]\([^)\n]*\)/g, /!?\[[^\]\n]*\]\[[^\]\n]*\]/g,
    /<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi, /^ {0,3}\[[^\]\n]+\]:[^\n]*/gm,
  ]) {
    for (const match of text.matchAll(pattern)) { spans.push([match.index!, match.index! + match[0].length]); }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/**
 * Every unlinked occurrence of `terms` in `text`, case-insensitively. A longer term
 * wins where two overlap. Word boundaries apply only to scripts that use spaces,
 * so a Chinese or Japanese title also matches inside a sentence. `spansOf` lets a
 * caller reuse the text's `excludedSpans` across term sets; it runs only on a hit.
 */
export function findMentions(text: string, terms: readonly string[], spansOf: () => Array<[number, number]> = () => excludedSpans(text)): Mention[] {
  const unique = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) { return []; }
  const pattern = new RegExp(unique.map(escapeRegExp).join("|"), "giu");
  // Most notes never mention the title: the exclusion scan and line table are built only on a hit.
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) { return []; }
  const spans = spansOf();
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) { lineStarts.push(i + 1); }
  const result: Mention[] = [];
  let span = 0, line = 0;
  for (const match of matches) {
    const from = match.index!, to = from + match[0].length;
    const before = text.charAt(from - 1), after = text.charAt(to);
    if (WORD_CHAR.test(match[0].charAt(0)) && before && WORD_CHAR.test(before)) { continue; }
    if (WORD_CHAR.test(match[0].charAt(match[0].length - 1)) && after && WORD_CHAR.test(after)) { continue; }
    while (span < spans.length && spans[span][1] <= from) { span++; }
    // Spans are sorted by start: only those starting before `to` can cover the match.
    let covered = false;
    for (let i = span; i < spans.length && spans[i][0] < to; i++) { if (spans[i][1] > from) { covered = true; break; } }
    if (covered) { continue; }
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= from) { line++; }
    const lineEnd = text.indexOf("\n", from);
    result.push({ from, to, line, ch: from - lineStarts[line], text: match[0],
      lineText: text.slice(lineStarts[line], lineEnd < 0 ? undefined : lineEnd).replace(/\r$/, "") });
  }
  return result;
}

/**
 * A line cut down around one mention, split so the mention can be highlighted.
 * About `lead` characters stay before it; the whole is at most about `width`.
 */
export function mentionSnippet(lineText: string, ch: number, length: number, width = 160, lead = 50): { before: string; match: string; after: string } {
  // A leading list, heading or quote marker is noise in a one-line preview.
  const before = lineText.slice(0, ch).replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "");
  const start = Math.max(0, before.length - lead);
  const match = lineText.slice(ch, ch + length);
  const room = Math.max(0, width - (before.length - start) - match.length);
  const rest = lineText.slice(ch + length);
  return {
    before: `${start ? "…" : ""}${before.slice(start).trimStart()}`,
    match,
    after: `${rest.slice(0, room).trimEnd()}${rest.length > room ? "…" : ""}`,
  };
}

