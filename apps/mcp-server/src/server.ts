/**
 * The MCP tools. Each one resolves the paper through the bridge, picks the
 * attachments of one PDF, and reads them; nothing here writes to Zotero except
 * `convert_paper`, which asks the add-on to start the same job as its item menu.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { BridgeClient, BridgeError, BridgeUnreachable, type BridgeArtifacts, type BridgePaper, type PaperAddress } from "./bridge.js";
import { loadDigest, loadReferences } from "./artifacts.js";
import {
  addressLabel,
  bibliographicLine,
  chooseSource,
  coverage,
  resolvePaper,
  type SourceArtifacts,
} from "./papers.js";
import { loadRaw, outline, readSlice, search, sectionRange, type RawDocument } from "./raw.js";

const INSTRUCTIONS = `UniZero serves papers from the user's Zotero library with their full text as
UniZero converted it (MinerU PDF -> Markdown, "Raw"), plus table images and the
reference list extracted from the PDF. Prefer it over generic full-text tools for any
paper in the library: the text keeps formulas, tables, and PDF page numbers.

Workflow: get_paper (metadata, what was converted, outline with line numbers and
pages) -> search_paper / read_paper for only the lines the question needs ->
get_table for table numbers (the image is the source of truth; Raw text tables can be
garbled). Every text line comes as "L<line> p.<page>  <text>"; the page is the last
page marker at or above that line and is a lower bound, since markers can be a few
pages apart. Cite a page as @libraryID/ITEMKEY.pdf:N.

Identity is @libraryID/itemKey; a citekey is an alias and can be ambiguous. Raw is the
user's own edited copy: only read it. convert_paper starts a minutes-long MinerU job
in Zotero; ask the user before calling it.`;

const paperParam = z.string().min(1).describe(
  "The paper: @libraryID/ITEMKEY (preferred, as in notes), an item key, a citekey, or title/author words",
);
const pdfParam = z.string().regex(/^[A-Za-z0-9]{8}$/).optional().describe(
  "Key of one PDF attachment, for papers with supplements; default is the Raw of the PDF Zotero opens, else any Raw",
);

class UserFacing extends Error {}

/**
 * Listing rows stay one short line: OCR can turn a table row into a "heading", and a
 * table's caption can carry its whole note.
 */
function oneLine(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof UserFacing || error instanceof BridgeUnreachable ||
      error instanceof BridgeError
    ? error.message
    : `unexpected error: ${(error as Error)?.stack || String(error)}`;
  return { content: [{ type: "text", text: message }], isError: true };
}

function tool<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return failure(error);
    }
  };
}

interface Located {
  paper: BridgePaper;
  address: PaperAddress;
  header: string;
}

async function locate(client: BridgeClient, query: string): Promise<Located> {
  const resolution = await resolvePaper(client, query);
  if (resolution.kind === "candidates") {
    if (!resolution.candidates.length) {
      throw new UserFacing(`Nothing in the Zotero library matches "${query}".`);
    }
    throw new UserFacing([
      `"${query}" matches ${resolution.candidates.length} papers; call again with one address:`,
      ...resolution.candidates.map((candidate) =>
        `  @${candidate.libraryID}/${candidate.itemKey}  ` +
        `${candidate.authors.slice(0, 3).join(", ")} (${candidate.year || "n.d."}) ` +
        `${candidate.title}  [${candidate.citekey}]`),
    ].join("\n"));
  }
  const { paper, address } = resolution;
  const header = [
    `PAPER ${addressLabel(paper)} [${paper.citekey}]` +
      (paper.ambiguous ? `  (citekey is ambiguous; this is one of several)` : ""),
    `  ${bibliographicLine(paper)}`,
  ].join("\n");
  return { paper, address, header };
}

interface WithRaw extends Located {
  listing: BridgeArtifacts;
  chosen: SourceArtifacts;
  doc: RawDocument;
}

async function locateRaw(client: BridgeClient, query: string, pdf?: string): Promise<WithRaw> {
  const located = await locate(client, query);
  const listing = await client.artifacts(located.address);
  const chosen = chooseSource(listing, pdf);
  if (!chosen.raw) {
    throw new UserFacing([
      located.header,
      pdf
        ? `No Raw was converted from PDF ${pdf}.`
        : "This paper has no Raw: it has not been converted.",
      ...coverage(listing).map((line) => `  ${line}`),
      "Ask the user before calling convert_paper (MinerU, a few minutes per paper).",
    ].join("\n"));
  }
  if (!chosen.raw.path) {
    throw new UserFacing(
      `${located.header}\nThe Raw attachment exists, but its file is not on this machine ` +
        "(not synced yet?).",
    );
  }
  try {
    return { ...located, listing, chosen, doc: await loadRaw(chosen.raw.path) };
  } catch (error) {
    throw new UserFacing(
      `${located.header}\nCannot read the Raw file ${chosen.raw.path}: ${(error as Error).message}`,
    );
  }
}

export function createServer(client = new BridgeClient()): McpServer {
  const server = new McpServer(
    { name: "unizero", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool("find_paper", {
    title: "Find papers in Zotero",
    description:
      "Search the Zotero library by title words, author, year, or citekey. Returns " +
      "@libraryID/ITEMKEY addresses for the other tools.",
    inputSchema: {
      query: z.string().min(1).describe("Free text; every word must match somewhere"),
      limit: z.number().int().min(1).max(50).default(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, tool(async ({ query, limit }) => {
    const items = await client.suggest(query, limit);
    if (!items.length) { return text(`Nothing in the Zotero library matches "${query}".`); }
    return text(items.map((item) =>
      `@${item.libraryID}/${item.itemKey}  ${item.authors.slice(0, 3).join(", ")} ` +
      `(${item.year || "n.d."}) ${item.title}  [${item.citekey}]`).join("\n"));
  }));

  server.registerTool("get_paper", {
    title: "Paper overview",
    description:
      "Metadata, abstract, what UniZero has converted for each PDF, and the Raw outline " +
      "(headings with line numbers and PDF pages) plus its size. Call this first.",
    inputSchema: { paper: paperParam, pdf: pdfParam },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, tool(async ({ paper, pdf }) => {
    const located = await locate(client, paper);
    const listing = await client.artifacts(located.address);
    const chosen = chooseSource(listing, pdf);
    const p = located.paper;
    const out = [located.header];
    if (p.abstract) { out.push("", "ABSTRACT", p.abstract); }
    out.push("", "CONVERTED", ...coverage(listing).map((line) => `  ${line}`));

    if (!chosen.raw?.path) {
      out.push("", chosen.raw
        ? "RAW  attachment exists but its file is not on this machine."
        : "RAW  none; full text is unavailable until the paper is converted " +
          "(convert_paper, after asking the user).");
      return text(out.join("\n"));
    }

    const doc = await loadRaw(chosen.raw.path);
    const chars = doc.lines.reduce((sum, line) => sum + line.length + 1, 0);
    out.push(
      "",
      `RAW  from ${chosen.sourceLabel}: ${doc.lines.length} lines, ~${Math.round(chars / 4).toLocaleString("en")} tokens`,
      "OUTLINE  (line, PDF page, heading)",
      ...outline(doc).map((entry) =>
        `  L${entry.line} p.${entry.page ?? "?"}  ${"#".repeat(entry.level)} ${oneLine(entry.heading)}`),
    );
    // The overview is the entry point: an unreadable side file is reported, not fatal.
    if (chosen.tables?.path) {
      try {
        const tables = await loadDigest(chosen.tables.path);
        out.push("", `TABLES  ${tables.length} cropped from the PDF (get_table):`,
          ...tables.map((table) => `  ${table.id} p.${table.page ?? "?"}  ${oneLine(table.caption)}`));
      } catch (error) {
        out.push("", `TABLES  digest unreadable: ${(error as Error).message}`);
      }
    }
    if (chosen.references?.path) {
      try {
        const references = await loadReferences(chosen.references.path);
        out.push("", `REFERENCES  ${references.references.length} extracted from the PDF (get_references)`);
      } catch (error) {
        out.push("", `REFERENCES  unreadable: ${(error as Error).message}`);
      }
    }
    return text(out.join("\n"));
  }));

  server.registerTool("read_paper", {
    title: "Read paper text",
    description:
      "Read lines of a paper's Raw Markdown, by section heading or line range. Each line " +
      "is a paragraph, prefixed \"L<line> p.<page>\". Read narrowly: use get_paper's " +
      "outline or search_paper first.",
    inputSchema: {
      paper: paperParam,
      pdf: pdfParam,
      section: z.string().optional().describe("Heading text (exact, else first containing it)"),
      from_line: z.number().int().min(1).optional(),
      to_line: z.number().int().min(1).optional(),
      max_chars: z.number().int().min(1000).max(200_000).default(40_000),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, tool(async ({ paper, pdf, section, from_line, to_line, max_chars }) => {
    const { doc, header } = await locateRaw(client, paper, pdf);
    let from = from_line ?? 1;
    let to = to_line ?? doc.lines.length;
    if (section) {
      const range = sectionRange(doc, section);
      if (!range) {
        throw new UserFacing(`${header}\nNo heading matches "${section}". Headings:\n` +
          outline(doc).map((entry) => `  L${entry.line} ${oneLine(entry.heading)}`).join("\n"));
      }
      from = from_line ?? range.from;
      to = to_line ?? range.to;
    }
    const slice = readSlice(doc, from, to, max_chars);
    const more = slice.truncated
      ? `\n[stopped at L${slice.to} (max_chars); continue with from_line=${slice.to + 1}]`
      : "";
    return text(`${header}\nLINES ${slice.from}-${slice.to} of ${doc.lines.length}\n\n${slice.text}${more}`);
  }));

  server.registerTool("search_paper", {
    title: "Search paper text",
    description:
      "Find lines in a paper's Raw Markdown matching a pattern, case-insensitively, read " +
      "both as a regular expression and as literal text (so TeX like $r_t$ works), with " +
      "surrounding lines and PDF pages.",
    inputSchema: {
      paper: paperParam,
      pdf: pdfParam,
      pattern: z.string().min(1),
      context: z.number().int().min(0).max(10).default(1),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, tool(async ({ paper, pdf, pattern, context, limit }) => {
    const { doc, header } = await locateRaw(client, paper, pdf);
    const { hits, total } = search(doc, pattern, context, limit);
    if (!total) { return text(`${header}\nNo line matches /${pattern}/i.`); }
    const shown = total > hits.length ? ` (showing ${hits.length}; raise limit or narrow the pattern)` : "";
    return text(`${header}\n${total} matching lines${shown}\n\n` +
      hits.map((hit) => hit.text).join("\n---\n"));
  }));

  server.registerTool("get_table", {
    title: "Table images",
    description:
      "Without `table`: list the tables UniZero cropped from the PDF (caption, exact page). " +
      "With `table` (e.g. t03): return that crop as an image with its caption and notes. " +
      "Use the image for any question about a table's numbers.",
    inputSchema: {
      paper: paperParam,
      pdf: pdfParam,
      table: z.string().regex(/^t\d{2,}$/).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, tool(async ({ paper, pdf, table }) => {
    const located = await locate(client, paper);
    const listing = await client.artifacts(located.address);
    const chosen = chooseSource(listing, pdf);
    if (!chosen.tables?.path) {
      return text(`${located.header}\nNo table digest for ${chosen.sourceLabel}. ` +
        "Tables in the Raw text (Markdown/HTML rows) are the fallback; say so when using them.");
    }
    const tables = await loadDigest(chosen.tables.path);
    if (!table) {
      return text(`${located.header}\nTABLES from ${chosen.sourceLabel}\n` +
        tables.map((entry) => `  ${entry.id} p.${entry.page ?? "?"}  ${oneLine(entry.caption)}`).join("\n"));
    }
    const entry = tables.find((candidate) => candidate.id === table);
    if (!entry) {
      throw new UserFacing(`No ${table}; the digest has ${tables.map((t) => t.id).join(", ") || "no tables"}.`);
    }
    const caption = `${addressLabel(located.paper)} ${entry.id}, PDF p.${entry.page ?? "?"}: ` +
      `${entry.caption}${entry.footnote ? `\nNotes: ${entry.footnote}` : ""}`;
    const result: CallToolResult = { content: [{ type: "text", text: caption }] };
    if (entry.image) {
      result.content.push({ type: "image", data: entry.image.base64, mimeType: entry.image.mimeType });
    } else {
      result.content.push({ type: "text", text: "(no crop in the digest; check the PDF page)" });
    }
    return result;
  }));

  server.registerTool("get_references", {
    title: "Reference list",
    description:
      "The reference list UniZero extracted from the paper's PDF: raw citation text, " +
      "source page, and any DOI/arXiv printed in it. For resolved, library-linked " +
      "references use get_relations instead.",
    inputSchema: {
      paper: paperParam,
      pdf: pdfParam,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, tool(async ({ paper, pdf, offset, limit }) => {
    const located = await locate(client, paper);
    const listing = await client.artifacts(located.address);
    const chosen = chooseSource(listing, pdf);
    if (!chosen.references?.path) {
      return text(`${located.header}\nNo extracted references for ${chosen.sourceLabel}.`);
    }
    const { references } = await loadReferences(chosen.references.path);
    const page = references.slice(offset, offset + limit);
    const rows = page.map((reference) => {
      const ids = [
        reference.identifiers?.doi ? `doi:${reference.identifiers.doi}` : "",
        reference.identifiers?.arxiv ? `arXiv:${reference.identifiers.arxiv}` : "",
      ].filter(Boolean).join(" ");
      return `[${reference.index}] p.${reference.page ?? "?"}  ${reference.raw}${ids ? `  {${ids}}` : ""}`;
    });
    const more = offset + limit < references.length
      ? `\n[${references.length - offset - limit} more; continue with offset=${offset + limit}]`
      : "";
    return text(`${located.header}\nREFERENCES ${offset + 1}-${offset + page.length} of ` +
      `${references.length} from ${chosen.sourceLabel}\n${rows.join("\n")}${more}`);
  }));

  server.registerTool("get_relations", {
    title: "References, citations, related papers",
    description:
      "Resolved references, citing papers, or related papers from UniZero's provider " +
      "cache, marking which are already in the library. Answers from cache only unless " +
      "fetch is true, which calls the scholarly providers.",
    inputSchema: {
      paper: paperParam,
      kind: z.enum(["references", "citations", "relation"]).default("references"),
      fetch: z.boolean().default(false).describe("Allow provider network calls on a cache miss"),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async ({ paper, kind, fetch, limit }) => {
    const located = await locate(client, paper);
    const relations = await client.relations(located.address, kind, fetch);
    if (!relations.loaded) {
      return text(`${located.header}\n${kind} are not cached for this paper. Call again with ` +
        "fetch=true to ask the providers (network).");
    }
    const rows = relations.items.slice(0, limit).map((item) => {
      const where = item.inLibrary && item.itemKey
        ? `@${item.libraryID}/${item.itemKey}`
        : "(not in library)";
      const ids = [item.doi ? `doi:${item.doi}` : "", item.arxiv ? `arXiv:${item.arxiv}` : ""]
        .filter(Boolean).join(" ");
      return `${where}  ${item.authors.slice(0, 3).join(", ")} (${item.year || "n.d."}) ` +
        `${item.title}${ids ? `  {${ids}}` : ""}${item.isInfluential ? "  [influential]" : ""}`;
    });
    return text(`${located.header}\n${kind.toUpperCase()} via ${relations.source}: ` +
      `${relations.count} of ${relations.total}${relations.hasMore ? " (provider has more)" : ""}\n` +
      rows.join("\n"));
  }));

  server.registerTool("convert_paper", {
    title: "Convert paper to Raw",
    description:
      "Start UniZero's PDF -> Markdown conversion (MinerU) for a paper in Zotero. Runs " +
      "for minutes inside Zotero; progress is in the UniZero panel. Creates the Raw " +
      "attachment if missing, otherwise refreshes Raw Backup only. Ask the user first.",
    inputSchema: {
      paper: paperParam,
      template: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/).optional()
        .describe("Conversion template id; default is the one set in Zotero's UniZero settings"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, tool(async ({ paper, template }) => {
    const located = await locate(client, paper);
    const accepted = await client.convert(located.address, template);
    return text(`${located.header}\n${accepted.message}\nCall get_paper again once it finishes.`);
  }));

  return server;
}
