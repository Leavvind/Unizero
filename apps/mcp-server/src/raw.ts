/**
 * Raw Markdown as an agent reads it.
 *
 * Raw is the user's working copy of a converted paper (edited in Obsidian), so it
 * is only ever read here. Reading normalises it in memory:
 *
 * - page links the runtime injects, `[p12](zotero://open-pdf/...?page=12)`
 *   (`inject_page_links` in `services/paper-runtime/.../pipeline/steps.py`),
 *   become `[p.12]` markers, and every line carries the page in force at it, so
 *   an answer can cite pages without the agent tracking links;
 * - the user's injected highlight links (`...&annotation=KEY`, written by
 *   `application/annotations.py`) are dropped: a reading habit, not content;
 * - relative image links become absolute paths so the agent can open them.
 */

import { stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PAGE_LINK = /\[p\.?(\d+)\]\(zotero:\/\/open-pdf\/[^)\s]*?[?&]page=(\d+)[^)\s]*\)/g;
const HIGHLIGHT_LINK = / ?\[[^\]]*\]\(zotero:\/\/open-pdf\/[^)\s]*[?&]annotation=[^)\s]*\)/g;
const IMAGE = /(!\[[^\]]*\]\()([^)\s]+)(\))/g;
const PAGE_MARKER = /\[p\.(\d+)\]/g;
const URL_OR_DRIVE = /^[a-z][a-z0-9+.-]*:/i;

export interface RawDocument {
  path: string;
  /** Normalised lines; line N is `lines[N - 1]`. */
  lines: string[];
  /** PDF page in force at each line (the last `[p.N]` at or above it). */
  pages: (number | undefined)[];
}

export interface OutlineEntry {
  line: number;
  page?: number;
  level: number;
  heading: string;
}

export function normaliseRaw(markdown: string, rawDir: string): string {
  // Raw edited on Windows has CRLF endings; a stray \r defeats every line pattern.
  let md = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  md = md.replace(HIGHLIGHT_LINK, "");
  md = md.replace(PAGE_LINK, (_match, _label, page: string) => `[p.${page}]`);
  md = md.replace(IMAGE, (match, open: string, target: string, close: string) => {
    if (URL_OR_DRIVE.test(target) || target.startsWith("<")) { return match; }
    let decoded = target;
    try { decoded = decodeURIComponent(target); } catch { /* keep as written */ }
    return `${open}<${resolve(rawDir, decoded)}>${close}`;
  });
  md = md.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return md.trim() + "\n";
}

export function parseRaw(path: string, normalised: string): RawDocument {
  const lines = normalised.replace(/\n$/, "").split("\n");
  const pages: (number | undefined)[] = [];
  let page: number | undefined;
  for (const line of lines) {
    for (const match of line.matchAll(PAGE_MARKER)) { page = Number(match[1]); }
    pages.push(page);
  }
  return { path, lines, pages };
}

const cache = new Map<string, { mtimeMs: number; doc: RawDocument }>();

/** Read and normalise a Raw file, reusing the parse while the file is unchanged. */
export async function loadRaw(path: string): Promise<RawDocument> {
  const { mtimeMs } = await stat(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) { return hit.doc; }
  // Zotero records these attachments as windows-1252, but UniZero writes UTF-8.
  const text = await readFile(path, "utf-8");
  const doc = parseRaw(path, normaliseRaw(text, dirname(path)));
  cache.set(path, { mtimeMs, doc });
  return doc;
}

export function outline(doc: RawDocument): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  doc.lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      out.push({
        line: index + 1,
        page: doc.pages[index],
        level: match[1].length,
        heading: match[2].replace(PAGE_MARKER, "").trim(),
      });
    }
  });
  return out;
}

/**
 * Lines `from`..`to` (1-based, inclusive) of the section whose heading contains
 * `heading`, ending before the next heading of the same or a higher level.
 */
export function sectionRange(doc: RawDocument, heading: string): { from: number; to: number } | undefined {
  const entries = outline(doc);
  const needle = heading.trim().toLowerCase();
  const exact = entries.findIndex((entry) => entry.heading.toLowerCase() === needle);
  const index = exact >= 0
    ? exact
    : entries.findIndex((entry) => entry.heading.toLowerCase().includes(needle));
  if (index < 0) { return undefined; }
  const start = entries[index];
  const next = entries.slice(index + 1).find((entry) => entry.level <= start.level);
  return { from: start.line, to: next ? next.line - 1 : doc.lines.length };
}

/** `L<line> p.<page>  <text>`, the form every reading tool returns. */
export function formatLine(doc: RawDocument, line: number): string {
  const page = doc.pages[line - 1];
  return `L${line} p.${page ?? "?"}  ${doc.lines[line - 1]}`;
}

export interface ReadSlice {
  from: number;
  to: number;
  text: string;
  truncated: boolean;
}

/** Blank lines separate paragraphs; they are skipped in output but keep their numbers. */
function blank(doc: RawDocument, line: number): boolean {
  return doc.lines[line - 1].trim() === "";
}

/** Lines `from`..`to`, cut short once `maxChars` is reached (never mid-line). */
export function readSlice(doc: RawDocument, from: number, to: number, maxChars: number): ReadSlice {
  const first = Math.max(1, Math.min(from, doc.lines.length));
  const last = Math.max(first, Math.min(to, doc.lines.length));
  const out: string[] = [];
  let size = 0;
  let line = first;
  for (; line <= last; line++) {
    if (blank(doc, line)) { continue; }
    const formatted = formatLine(doc, line);
    if (out.length > 0 && size + formatted.length > maxChars) { break; }
    out.push(formatted);
    size += formatted.length + 1;
  }
  return { from: first, to: line - 1, text: out.join("\n"), truncated: line <= last };
}

export interface SearchHit {
  line: number;
  page?: number;
  text: string;
}

/**
 * Lines matching `pattern` case-insensitively, as a regular expression or as
 * literal text, each with `context` non-blank lines either side. Both readings count
 * because papers are full of TeX (`$r_t$`, `\beta`) that parses as a regex but
 * means itself.
 */
export function search(doc: RawDocument, pattern: string, context: number, limit: number): {
  hits: SearchHit[];
  total: number;
} {
  const needle = pattern.toLowerCase();
  let regex: RegExp | undefined;
  try { regex = new RegExp(pattern, "i"); } catch { /* literal only */ }
  const matcher = (line: string) =>
    line.toLowerCase().includes(needle) || Boolean(regex?.test(line));

  const matches: number[] = [];
  doc.lines.forEach((line, index) => { if (matcher(line)) { matches.push(index + 1); } });

  const hits = matches.slice(0, limit).map((line) => {
    const before: number[] = [];
    for (let n = line - 1; n >= 1 && before.length < context; n--) {
      if (!blank(doc, n)) { before.unshift(n); }
    }
    const after: number[] = [];
    for (let n = line + 1; n <= doc.lines.length && after.length < context; n++) {
      if (!blank(doc, n)) { after.push(n); }
    }
    const text = [...before, line, ...after].map((n) => formatLine(doc, n)).join("\n");
    return { line, page: doc.pages[line - 1], text };
  });
  return { hits, total: matches.length };
}
