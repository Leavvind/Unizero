import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent, Root } from "mdast";
import { parseTree, findNodeAtLocation, type Node as JsonNode } from "jsonc-parser";
import { parseLinkTarget, serializeLinkTarget, type LinkTarget, type TextLocation } from "./linkTarget";

export interface DocumentLink {
  target: LinkTarget;
  raw: string;
  from: number;
  to: number;
  /** Source span of the label, excluding brackets and the destination. */
  labelFrom?: number;
  labelTo?: number;
  line: number;
  ch: number;
  lineText: string;
  nodeId?: string;
  /** JSON string span for lossless Canvas field edits. */
  field?: { from: number; to: number; text: string };
}
type Ast = Root | RootContent;
type Span = [number, number];
/** Plain text to CommonMark. Spaces would turn a masked line start into an indented code block. */
const OPAQUE = "\uE000";
/**
 * Hide Obsidian comments and wikilinks from CommonMark, outside code, keeping every offset.
 * A wikilink is content; a comment only counts when text follows it on the line, so a
 * comment-only line stays blank and a trailing comment cannot hide a block ID.
 */
function maskObsidianSyntax(text: string): { masked: string; comments: Span[] } {
  const base = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, (s) => s.replace(/[^\r\n]/g, " "));
  if (!base.includes("%%") && !base.includes("[[")) { return { masked: base, comments: [] }; }
  const inert: Span[] = [];
  const collect = (node: Ast): void => {
    if (["code", "inlineCode", "html"].includes(node.type)) { inert.push([node.position!.start.offset!, node.position!.end.offset!]); return; }
    if ("children" in node) { node.children.forEach(collect); }
  };
  collect(fromMarkdown(base));
  const isInert = (offset: number) => inert.some(([from, to]) => offset >= from && offset < to);
  const comments: Span[] = [];
  let cursor = 0;
  while (true) {
    const start = base.indexOf("%%", cursor);
    if (start < 0) { break; }
    if (isInert(start)) { cursor = start + 2; continue; }
    const closing = base.indexOf("%%", start + 2), end = closing < 0 ? base.length : closing + 2;
    comments.push([start, end]); cursor = end;
  }
  const chars = base.split("");
  const fill = (from: number, to: number, char: string) => {
    for (let i = from; i < to; i += 1) { if (chars[i] !== "\n" && chars[i] !== "\r") { chars[i] = char; } }
  };
  for (const [from, to] of comments) { fill(from, to, " "); }
  for (const match of base.matchAll(/!?\[\[[^\n]*?\]\]/g)) {
    const from = match.index!;
    if (!isInert(from) && !comments.some(([start, end]) => from >= start && from < end)) { fill(from, from + match[0].length, OPAQUE); }
  }
  for (const [from, to] of comments) {
    let start = from;
    while (start < to) {
      const newline = base.indexOf("\n", start), end = newline < 0 || newline >= to ? to : newline;
      let next = end;
      while (next < chars.length && chars[next] !== "\n" && /\s/.test(chars[next])) { next += 1; }
      if (next < chars.length && chars[next] !== "\n") { fill(start, end, OPAQUE); }
      start = end + 1;
    }
  }
  return { masked: chars.join(""), comments };
}
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) { starts.push(i + 1); }
  return starts;
}
function lineAt(starts: number[], offset: number): number {
  let low = 0, high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) { low = middle; } else { high = middle - 1; }
  }
  return low;
}
export function scanDocumentLinks(text: string): DocumentLink[] {
  const { masked } = maskObsidianSyntax(text);
  const tree = fromMarkdown(masked);
  const lineStarts = lineStartsOf(text);
  const definitions = new Map<string, string>();
  function collect(node: Ast): void {
    if (node.type === "definition" && !definitions.has(node.identifier)) { definitions.set(node.identifier, node.url); }
    if ("children" in node) { node.children.forEach(collect); }
  }
  collect(tree);
  const result: DocumentLink[] = [];
  function add(target: LinkTarget, from: number, to: number, labelTo?: number): void {
    const line = lineAt(lineStarts, from), lineStart = lineStarts[line];
    const lineEnd = text.indexOf("\n", from);
    result.push({ target, from, to, raw: text.slice(from, to),
      ...(labelTo !== undefined && labelTo > from + 1 ? { labelFrom: from + 1, labelTo } : {}),
      line, ch: from - lineStart,
      lineText: text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).replace(/\r$/, "") });
  }
  function visit(node: Ast): void {
    const from = node.position?.start.offset, to = node.position?.end.offset;
    if (from === undefined || to === undefined) { return; }
    if (node.type === "link" || node.type === "linkReference") {
      const target = parseLinkTarget(node.type === "link" ? node.url : definitions.get(node.identifier) || "");
      if (target) { add(target, from, to, node.children[node.children.length - 1]?.position?.end.offset); }
      return;
    }
    if (["code", "inlineCode", "html", "image", "imageReference", "definition"].includes(node.type)) { return; }
    if ("children" in node) { node.children.forEach(visit); }
  }
  visit(tree);
  return result.sort((a, b) => a.from - b.from);
}
export interface CanvasTextField { nodeId?: string; text: string; from: number; to: number }
export function canvasTextFields(json: string): CanvasTextField[] {
  JSON.parse(json); // Invalid JSON is a failed read, never an empty source.
  const tree = parseTree(json);
  const nodes = findNodeAtLocation(tree!, ["nodes"]);
  const edges = findNodeAtLocation(tree!, ["edges"]);
  const fields: CanvasTextField[] = [];
  function field(node: JsonNode, key: string): void {
    const value = findNodeAtLocation(node, [key]);
    const id = findNodeAtLocation(node, ["id"])?.value;
    if (value?.type === "string") { fields.push({ nodeId: typeof id === "string" ? id : undefined,
      text: value.value, from: value.offset, to: value.offset + value.length }); }
  }
  for (const node of nodes?.children || []) {
    const type = findNodeAtLocation(node, ["type"])?.value;
    if (type === "text") { field(node, "text"); }
    if (type === "group") { field(node, "label"); }
  }
  for (const edge of edges?.children || []) { field(edge, "label"); }
  return fields;
}
export function scanCanvasLinks(json: string): DocumentLink[] {
  return canvasTextFields(json).flatMap((field) => scanDocumentLinks(field.text)
    .map((link) => ({ ...link, nodeId: field.nodeId, field: { from: field.from, to: field.to, text: field.text } })));
}

export interface TextAnchor { location: TextLocation; line: number; offset: number; /** Heading depth, 1 to 6. */ level?: number }
export function textAnchors(text: string): TextAnchor[] {
  const anchors: TextAnchor[] = [];
  const { masked, comments } = maskObsidianSyntax(text);
  const plain = (node: Ast): string => "value" in node ? String(node.value) : "children" in node ? node.children.map(plain).join("") : "";
  /** A heading's text keeps its wikilinks and drops its comments. */
  const headingValue = (node: Ast): string => {
    const from = node.position!.start.offset!, to = node.position!.end.offset!;
    if (!masked.slice(from, to).includes(OPAQUE)) { return plain(node); }
    let source = text.slice(from, to);
    for (const [start, end] of [...comments].reverse()) {
      if (start < to && end > from) { source = source.slice(0, Math.max(start, from) - from) + source.slice(Math.min(end, to) - from); }
    }
    return plain(fromMarkdown(source));
  };
  function visit(node: Ast): void {
    if (node.type === "code" || node.type === "html") { return; }
    if (node.type === "heading") { anchors.push({ location: { kind: "heading", value: headingValue(node) }, level: node.depth,
      line: node.position!.start.line - 1, offset: node.position!.start.offset! }); }
    if (node.type === "text") {
      const from = node.position!.start.offset!, to = node.position!.end.offset!;
      const source = masked.slice(from, to);
      const match = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*(?=\r?$)/gm;
      for (const m of source.matchAll(match)) {
        // Anchor at the caret: the `\s` before it may be the line break that ends the
        // previous line of the paragraph, which would put the anchor one line early.
        const offset = from + m.index! + m[0].indexOf("^");
        anchors.push({ location: { kind: "block", value: m[1] }, line: text.slice(0, offset).split("\n").length - 1, offset });
      }
    }
    if ("children" in node) { node.children.forEach(visit); }
  }
  visit(fromMarkdown(masked));
  return anchors;
}
export function resolveTextLocation(text: string, location?: TextLocation): { line?: number; status: "file" | "found" | "missing" | "ambiguous" } {
  if (!location) { return { status: "file" }; }
  const found = textAnchors(text).filter((a) => a.location.kind === location.kind && a.location.value === location.value);
  return found.length === 1 ? { status: "found", line: found[0].line } : { status: found.length ? "ambiguous" : "missing" };
}

/**
 * A source line as a reader sees it: destinations and block markup dropped, and cut so
 * that a link late in a long paragraph is still in view.
 */
export function occurrenceSnippet(line: string, ch: number, width = 160, lead = 50): string {
  const plain = (text: string) => text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  const before = plain(line.slice(0, ch)).replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "");
  const start = Math.max(0, before.length - lead);
  const text = before.slice(start) + plain(line.slice(ch));
  return `${start ? "…" : ""}${text.slice(0, width).trim()}${text.length > width ? "…" : ""}`;
}

/** Preserve all authored Markdown within an inline link label. */
export function retargetInlineLink(raw: string, target: LinkTarget): string {
  const paragraph = fromMarkdown(raw).children[0];
  const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
  if (link?.type !== "link" || link.position?.start.offset !== 0 || link.position.end.offset !== raw.length) {
    throw new Error("Use an inline Markdown link to reselect its location; reference-style targets can be copied from the link menu.");
  }
  const end = link.children.length ? link.children[link.children.length - 1].position!.end.offset! : 1;
  return `${raw.slice(0, end)}](${serializeLinkTarget(target)})`;
}
