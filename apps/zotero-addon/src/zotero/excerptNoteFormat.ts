/**
 * The excerpt note: one child note of a citing paper A, tagged `unizero:excerpts`,
 * holding the passages of A that the user attached to each paper A cites.
 *
 * The note is the user's content and the only store for it, so this module never
 * rewrites a note wholesale. It reads leniently and writes surgically: a section is
 * an `<h2>` whose link selects the cited item, an excerpt is a Zotero highlight span
 * (`data-annotation`) inside that section, and everything else the user wrote is
 * left exactly where it was.
 *
 * Identity lives only where Zotero's note editor keeps it: the heading's hyperlink
 * (`zotero://select/…/items/KEY`) and the highlight's `data-annotation`. Custom
 * attributes may be stripped on the next edit, so none are relied on. Heading text
 * is display only.
 *
 * Pure string logic with no Zotero globals, so it runs under the unit tests.
 */

export const EXCERPT_NOTE_TAG = "unizero:excerpts";
export const EXCERPT_NOTE_TITLE = "Cited passages";

/** Where a `zotero://select` link points: a library scope plus an item key. */
export interface SelectTarget {
  /** `library` for the user library, `groups/<groupID>` for a group. */
  scope: string;
  itemKey: string;
}

export interface ExcerptRecord {
  annotationKey: string;
  /** The PDF attachment holding the annotation, when the URI names one. */
  attachmentKey?: string;
  attachmentURI?: string;
  pageLabel?: string;
  pageIndex?: number;
  /** Snapshot of the highlighted text, without the surrounding quotation marks. */
  text: string;
}

export interface ExcerptSection {
  target: SelectTarget;
  /** The heading's visible text. */
  label: string;
  excerpts: ExcerptRecord[];
}

/** What a caller supplies to add one annotation to a section. */
export interface ExcerptInput {
  annotationKey: string;
  /** `Zotero.URI.getItemURI(attachment)`. */
  attachmentURI: string;
  /** `Zotero.URI.getItemURI(citingItem)`, for the citation that follows the quote. */
  citingItemURI: string;
  text: string;
  pageLabel?: string;
  /** The annotation's parsed `annotationPosition`. */
  position?: unknown;
  color?: string;
  /** Visible citation text, e.g. `Smith, 2020, p. 7`. */
  citationLabel: string;
}

const SELECT_LINK = /zotero:\/\/select\/(library|groups\/\d+)\/items\/([A-Za-z0-9]+)/;
const HEADING = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
const SPAN_TAG = /<\/?span\b[^>]*>/gi;
const PARAGRAPH = /<p\b[^>]*>[\s\S]*?<\/p\s*>/gi;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function stripQuotes(text: string): string {
  return text.replace(/^["“”'‘’]+/, "").replace(/["“”'‘’]+$/, "").trim();
}

function attribute(openTag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(openTag);
  if (!match) { return; }
  return decodeEntities(match[2] ?? match[3] ?? "");
}

function hasClass(openTag: string, name: string): boolean {
  return (attribute(openTag, "class") || "").split(/\s+/).includes(name);
}

/** Decode a `data-annotation` / `data-citation` value: URI-encoded JSON, or plain JSON. */
function decodeJSONAttribute(value: string): any {
  for (const candidate of [() => decodeURIComponent(value), () => value]) {
    try {
      return JSON.parse(candidate());
    } catch {
      // Try the next form.
    }
  }
  return undefined;
}

function encodeJSONAttribute(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

export function selectURI(target: SelectTarget): string {
  return `zotero://select/${target.scope}/items/${target.itemKey}`;
}

export function parseSelectURI(value: string): SelectTarget | undefined {
  const match = SELECT_LINK.exec(value);
  return match ? { scope: match[1], itemKey: match[2] } : undefined;
}

function sameTarget(left: SelectTarget, right: SelectTarget): boolean {
  return left.scope === right.scope && left.itemKey === right.itemKey;
}

interface SpanMatch { start: number; openEnd: number; closeStart: number; end: number; openTag: string }

/** Every highlight span in `html`, matched to its own closing tag (spans may nest). */
function highlightSpans(html: string): SpanMatch[] {
  const spans: SpanMatch[] = [];
  const stack: { start: number; openEnd: number; openTag: string }[] = [];
  SPAN_TAG.lastIndex = 0;
  for (let match = SPAN_TAG.exec(html); match; match = SPAN_TAG.exec(html)) {
    const tag = match[0];
    if (tag[1] !== "/") {
      stack.push({ start: match.index, openEnd: match.index + tag.length, openTag: tag });
      continue;
    }
    const open = stack.pop();
    if (open && hasClass(open.openTag, "highlight") && attribute(open.openTag, "data-annotation")) {
      spans.push({ ...open, closeStart: match.index, end: match.index + tag.length });
    }
  }
  return spans.sort((left, right) => left.start - right.start);
}

function excerptFromSpan(html: string, span: SpanMatch): ExcerptRecord | undefined {
  const data = decodeJSONAttribute(attribute(span.openTag, "data-annotation") || "");
  const annotationKey = typeof data?.annotationKey === "string" ? data.annotationKey : "";
  if (!annotationKey) { return; }
  const attachmentURI = typeof data.attachmentURI === "string" ? data.attachmentURI : undefined;
  const attachmentKey = attachmentURI?.match(/\/items\/([A-Za-z0-9]+)\/?$/)?.[1];
  const pageIndex = Number(data.position?.pageIndex);
  return {
    annotationKey,
    attachmentKey,
    attachmentURI,
    pageLabel: data.pageLabel === undefined ? undefined : String(data.pageLabel),
    pageIndex: Number.isInteger(pageIndex) ? pageIndex : undefined,
    text: stripQuotes(plainText(html.slice(span.openEnd, span.closeStart))),
  };
}

/** Where content may go: before the wrapper `</div>` Zotero puts around a note. */
function contentEnd(html: string): number {
  if (/^\s*<div\b/i.test(html)) {
    const close = html.lastIndexOf("</div>");
    if (close >= 0) { return close; }
  }
  return html.length;
}

interface SectionLayout {
  target: SelectTarget;
  label: string;
  headingStart: number;
  bodyStart: number;
  bodyEnd: number;
}

/** Sections in document order. A section runs to the next h1/h2 or the note's end. */
function layout(html: string): SectionLayout[] {
  const end = contentEnd(html);
  const headings: { start: number; end: number; inner: string; level: string }[] = [];
  HEADING.lastIndex = 0;
  for (let match = HEADING.exec(html); match; match = HEADING.exec(html)) {
    if (match.index >= end) { break; }
    headings.push({
      start: match.index,
      end: match.index + match[0].length,
      inner: match[2],
      level: match[1],
    });
  }
  const sections: SectionLayout[] = [];
  headings.forEach((heading, index) => {
    if (heading.level !== "2") { return; }
    const href = /<a\b[^>]*>/i.exec(heading.inner);
    const target = href ? parseSelectURI(attribute(href[0], "href") || "") : undefined;
    if (!target) { return; }
    sections.push({
      target,
      label: plainText(heading.inner),
      headingStart: heading.start,
      bodyStart: heading.end,
      bodyEnd: index + 1 < headings.length ? headings[index + 1].start : end,
    });
  });
  return sections;
}

/** Read every section. Sections for the same target are merged, in order. */
export function parseExcerptNote(html: string): ExcerptSection[] {
  const sections: ExcerptSection[] = [];
  for (const section of layout(html)) {
    const body = html.slice(section.bodyStart, section.bodyEnd);
    const excerpts = highlightSpans(body)
      .map((span) => excerptFromSpan(body, span))
      .filter((excerpt): excerpt is ExcerptRecord => Boolean(excerpt));
    const existing = sections.find((entry) => sameTarget(entry.target, section.target));
    if (existing) {
      for (const excerpt of excerpts) {
        if (!existing.excerpts.some((known) => known.annotationKey === excerpt.annotationKey)) {
          existing.excerpts.push(excerpt);
        }
      }
      continue;
    }
    const seen = new Set<string>();
    sections.push({
      target: section.target,
      label: section.label,
      excerpts: excerpts.filter((excerpt) =>
        !seen.has(excerpt.annotationKey) && Boolean(seen.add(excerpt.annotationKey))),
    });
  }
  return sections;
}

export function newExcerptNote(): string {
  return `<div data-schema-version="9"><h1>${EXCERPT_NOTE_TITLE}</h1>\n</div>`;
}

function excerptParagraph(input: ExcerptInput): string {
  const annotation: Record<string, unknown> = {
    attachmentURI: input.attachmentURI,
    annotationKey: input.annotationKey,
  };
  if (input.color) { annotation.color = input.color; }
  if (input.pageLabel) { annotation.pageLabel = input.pageLabel; }
  if (input.position !== undefined) { annotation.position = input.position; }
  const citationItem: Record<string, unknown> = { uris: [input.citingItemURI] };
  if (input.pageLabel) { citationItem.locator = input.pageLabel; }
  annotation.citationItem = citationItem;
  const citation = { citationItems: [citationItem], properties: {} };
  return `<p><span class="highlight" data-annotation="${encodeJSONAttribute(annotation)}">`
    + `“${escapeText(input.text.trim())}”</span> `
    + `<span class="citation" data-citation="${encodeJSONAttribute(citation)}">`
    + `(<span class="citation-item">${escapeText(input.citationLabel)}</span>)</span></p>\n`;
}

function sectionHeading(target: SelectTarget, label: string): string {
  return `<h2><a href="${escapeAttribute(selectURI(target))}">${escapeText(label)}</a></h2>\n`;
}

/** The paragraph-level blocks of a section that hold an excerpt, in order. */
function excerptBlocks(html: string, section: SectionLayout): { start: number; end: number; keys: string[] }[] {
  const blocks: { start: number; end: number; keys: string[] }[] = [];
  const body = html.slice(section.bodyStart, section.bodyEnd);
  PARAGRAPH.lastIndex = 0;
  for (let match = PARAGRAPH.exec(body); match; match = PARAGRAPH.exec(body)) {
    const keys = highlightSpans(match[0])
      .map((span) => excerptFromSpan(match![0], span)?.annotationKey)
      .filter((key): key is string => Boolean(key));
    if (keys.length) {
      blocks.push({
        start: section.bodyStart + match.index,
        end: section.bodyStart + match.index + match[0].length,
        keys,
      });
    }
  }
  return blocks;
}

/**
 * Add one excerpt to the target's section, creating the section at the end of the
 * note when it has none. `index` places it among the section's excerpts (default:
 * last). An annotation already in that section leaves the note unchanged.
 */
export function addExcerptToNote(
  html: string,
  target: SelectTarget,
  label: string,
  input: ExcerptInput,
  index?: number,
): string {
  const note = html.trim() ? html : newExcerptNote();
  const section = layout(note).find((entry) => sameTarget(entry.target, target));
  const paragraph = excerptParagraph(input);
  if (!section) {
    const at = contentEnd(note);
    return note.slice(0, at) + sectionHeading(target, label) + paragraph + note.slice(at);
  }
  const blocks = excerptBlocks(note, section);
  const known = parseExcerptNote(note)
    .find((entry) => sameTarget(entry.target, target))?.excerpts || [];
  if (known.some((excerpt) => excerpt.annotationKey === input.annotationKey)) { return note; }
  let at: number;
  if (index !== undefined && index >= 0 && index < blocks.length) {
    at = blocks[index].start;
  } else if (blocks.length) {
    at = blocks[blocks.length - 1].end;
    if (note[at] === "\n") { at += 1; }
  } else {
    at = section.bodyStart;
  }
  return note.slice(0, at) + paragraph + note.slice(at);
}

/** Markup that is the user's content even without text: images, rules, tables, media. */
const CONTENT_TAG = /<(img|hr|table|iframe|video|audio|math|svg)\b/i;

/** Whether a fragment holds anything of the user's: text, or content markup. */
function hasContent(html: string): boolean {
  return Boolean(plainText(html)) || CONTENT_TAG.test(html);
}

/** `paragraph` without one highlight and the citation that follows it. */
function cutHighlight(paragraph: string, annotationKey: string): string {
  const span = highlightSpans(paragraph)
    .find((entry) => excerptFromSpan(paragraph, entry)?.annotationKey === annotationKey);
  if (!span) { return paragraph; }
  let end = span.end;
  const citation = /^\s*<span\b[^>]*class="[^"]*\bcitation\b[^"]*"[^>]*>/i
    .exec(paragraph.slice(end));
  if (citation) {
    const after = spanEnd(paragraph, end + citation[0].length);
    if (after !== undefined) { end = after; }
  }
  const before = paragraph.slice(0, span.start);
  // At the paragraph's start, or after a space, the leading space would be stray.
  const rest = /(\s|<p\b[^>]*>)$/i.test(before)
    ? paragraph.slice(end).replace(/^\s+/, "")
    : paragraph.slice(end).replace(/^\s+/, " ");
  return before + rest;
}

/**
 * Remove one excerpt from the target's section: the highlight and its citation.
 * The paragraph goes too only when nothing else is left in it; text or images the
 * user added there stay. A section left with no content loses its heading too.
 * Unknown keys are a no-op.
 */
export function removeExcerptFromNote(
  html: string,
  target: SelectTarget,
  annotationKey: string,
): string {
  for (const section of layout(html)) {
    if (!sameTarget(section.target, target)) { continue; }
    for (const block of excerptBlocks(html, section)) {
      if (!block.keys.includes(annotationKey)) { continue; }
      const cut = cutHighlight(html.slice(block.start, block.end), annotationKey);
      let next: string;
      if (hasContent(cut)) {
        next = html.slice(0, block.start) + cut + html.slice(block.end);
      } else {
        let end = block.end;
        if (html[end] === "\n") { end += 1; }
        next = html.slice(0, block.start) + html.slice(end);
      }
      return dropEmptySection(next, target);
    }
  }
  return html;
}

/** End of the span whose content starts at `from` (after its open tag), by depth. */
function spanEnd(html: string, from: number): number | undefined {
  let depth = 1;
  SPAN_TAG.lastIndex = from;
  for (let match = SPAN_TAG.exec(html); match; match = SPAN_TAG.exec(html)) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) { return match.index + match[0].length; }
  }
  return undefined;
}

function dropEmptySection(html: string, target: SelectTarget): string {
  const section = layout(html).find((entry) => sameTarget(entry.target, target));
  if (!section) { return html; }
  if (hasContent(html.slice(section.bodyStart, section.bodyEnd))) { return html; }
  return html.slice(0, section.headingStart) + html.slice(section.bodyEnd);
}
