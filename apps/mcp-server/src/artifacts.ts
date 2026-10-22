/**
 * Readers for the generated attachments other than Raw.
 *
 * - The tables digest (`unizero:tables`) is the HTML `providers/tables.py` in the
 *   paper runtime writes: one `<section>` per table with an `<h2>` caption, a
 *   base64 crop, an optional `p.footnote`, and a `?page=N` link. Change both
 *   together; `tests/artifacts.test.ts` holds a sample of that output.
 * - References (`unizero:references`) is the versioned JSON the add-on writes in
 *   `attachReferences` (`apps/zotero-addon/src/zotero/conversionAdapter.ts`).
 */

import { readFile } from "node:fs/promises";

export interface DigestTable {
  /** `t01`, `t02`, ... in digest order. */
  id: string;
  caption: string;
  /** Exact PDF page of the crop, when the digest recorded one. */
  page?: number;
  footnote: string;
  image?: { mimeType: string; base64: string };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** MinerU's own inline markup, which arrives escaped inside captions and notes. */
const INLINE_TAG = /<\/?(?:sub|sup|span|small|b|i|em|strong)\b[^>]*>/gi;

function plain(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(INLINE_TAG, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDigest(html: string): DigestTable[] {
  const tables: DigestTable[] = [];
  const sections = html.matchAll(/<section>([\s\S]*?)<\/section>/g);
  let index = 0;
  for (const [, section] of sections) {
    index += 1;
    const caption = /<h2>([\s\S]*?)<\/h2>/.exec(section);
    const image = /src="data:(image\/[\w+.-]+);base64,([^"]+)"/.exec(section);
    const footnote = /<p class="footnote">([\s\S]*?)<\/p>/.exec(section);
    const page = /[?&]page=(\d+)/.exec(section) ?? /PDF p(\d+)/.exec(section);
    tables.push({
      id: `t${String(index).padStart(2, "0")}`,
      caption: caption ? plain(caption[1]) : "",
      page: page ? Number(page[1]) : undefined,
      footnote: footnote ? plain(footnote[1]) : "",
      image: image ? { mimeType: image[1], base64: image[2] } : undefined,
    });
  }
  return tables;
}

export async function loadDigest(path: string): Promise<DigestTable[]> {
  return parseDigest(await readFile(path, "utf-8"));
}

export interface ExtractedReference {
  index: number;
  raw: string;
  page?: number;
  identifiers: { doi?: string; arxiv?: string };
}

export interface ReferencesFile {
  schema: string;
  generatedAt?: string;
  references: ExtractedReference[];
}

/**
 * Current envelopes, plus the ZoMiner one older libraries still carry (same rows;
 * listed in docs/LEGACY_SUPPORT.md with the add-on's own reader).
 */
const REFERENCES_SCHEMA = /^(?:unizero\.references\/\d+|zominer\.references\/1)$/;

export async function loadReferences(path: string): Promise<ReferencesFile> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<ReferencesFile>;
  if (typeof parsed.schema !== "string" || !REFERENCES_SCHEMA.test(parsed.schema)) {
    throw new Error(`${path} is not a UniZero references file (schema ${String(parsed.schema)})`);
  }
  return {
    schema: parsed.schema,
    generatedAt: parsed.generatedAt,
    references: Array.isArray(parsed.references) ? parsed.references : [],
  };
}
