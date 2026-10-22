/**
 * From what an agent was told ("the Bernard 1989 paper", a citekey, a note's
 * `@1/ITEMKEY`) to one Zotero item, and from that item to the attachments of one
 * of its PDFs.
 */

import type {
  BridgeArtifact,
  BridgeArtifacts,
  BridgeClient,
  BridgePaper,
  BridgeSuggestion,
  PaperAddress,
} from "./bridge.js";
import { BridgeError } from "./bridge.js";

/** `@1/ABCD1234`, also as written in notes with a PDF suffix: `@1/ABCD1234.pdf:12`. */
const CITATION = /^@?(\d+)\/([A-Za-z0-9]{8})(?:\.\w+(?::\d+)?)?$/;
const ITEM_KEY = /^[A-Z0-9]{8}$/;
const CITEKEY = /^@?[\p{L}\p{N}_:.#$%&+?<>~/-]+$/u;

/** Zotero's own user library. Group libraries are addressed with `@libraryID/itemKey`. */
const USER_LIBRARY_ID = 1;

export type Resolution =
  | { kind: "found"; paper: BridgePaper; address: PaperAddress }
  | { kind: "candidates"; candidates: BridgeSuggestion[] };

async function paperOrMiss(client: BridgeClient, address: PaperAddress): Promise<BridgePaper | undefined> {
  try {
    return await client.paper(address);
  } catch (error) {
    if (error instanceof BridgeError && (error.status === 404 || error.status === 400)) {
      return undefined;
    }
    throw error;
  }
}

export async function resolvePaper(client: BridgeClient, query: string, limit = 8): Promise<Resolution> {
  const q = query.trim();
  const citation = CITATION.exec(q);
  const direct: PaperAddress | undefined = citation
    ? { libraryID: Number(citation[1]), itemKey: citation[2].toUpperCase() }
    : ITEM_KEY.test(q)
      ? { libraryID: USER_LIBRARY_ID, itemKey: q }
      : CITEKEY.test(q)
        ? { citekey: q.replace(/^@/, "") }
        : undefined;

  if (direct) {
    const paper = await paperOrMiss(client, direct);
    if (paper) {
      return {
        kind: "found",
        paper,
        address: { libraryID: paper.libraryID, itemKey: paper.itemKey },
      };
    }
    if (citation) { return { kind: "candidates", candidates: [] }; }
  }

  const candidates = await client.suggest(q.replace(/^@/, ""), limit);
  if (candidates.length === 1) {
    const only = candidates[0];
    const address = { libraryID: only.libraryID, itemKey: only.itemKey };
    return { kind: "found", paper: await client.paper(address), address };
  }
  return { kind: "candidates", candidates };
}

export function addressLabel(paper: { libraryID: number; itemKey: string }): string {
  return `@${paper.libraryID}/${paper.itemKey}`;
}

export function bibliographicLine(paper: BridgePaper): string {
  const authors = paper.authors.length > 3
    ? `${paper.authors.slice(0, 3).join(", ")}, et al.`
    : paper.authors.join(", ");
  const sentence = (text: string) => /[.?!]$/.test(text) ? text : `${text}.`;
  const parts = [
    `${authors || "(no authors)"} (${paper.year || "n.d."}). ${sentence(paper.title)}`,
    paper.venue ? sentence(paper.venue) : "",
    paper.doi ? `doi:${paper.doi}` : "",
    paper.arxiv ? `arXiv:${paper.arxiv}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export interface SourceArtifacts {
  /** The PDF these attachments were converted from. */
  source?: string;
  /** Title of that PDF, or why it has none. */
  sourceLabel: string;
  raw?: BridgeArtifact;
  rawBackup?: BridgeArtifact;
  tables?: BridgeArtifact;
  references?: BridgeArtifact;
}

function ofKind(listing: BridgeArtifacts, kind: string, source: string | undefined): BridgeArtifact | undefined {
  const owned = listing.artifacts.filter((artifact) => artifact.kind === kind);
  return owned.find((artifact) => artifact.source === source)
    // A digest written before records existed has no source; with one PDF it is that PDF's.
    ?? (owned.length === 1 && owned[0].source === undefined ? owned[0] : undefined);
}

export function pdfLabel(listing: BridgeArtifacts, key: string | undefined): string {
  if (!key) { return "unknown PDF (attachment has no source record)"; }
  const pdf = listing.pdfs.find((candidate) => candidate.key === key);
  if (!pdf) { return `PDF ${key} (not attached to this item, often a duplicate's)`; }
  // `main` is only the PDF Zotero opens by default (the first one), which can be an
  // appendix; the title is what tells the paper from its supplements.
  return `"${pdf.title}" (${key}${pdf.main ? ", opened by default" : ""})`;
}

/**
 * The attachments converted from one PDF: `pdf` when given, else the paper's own
 * PDF when it has a Raw, else whichever PDF has one.
 */
export function chooseSource(listing: BridgeArtifacts, pdf?: string): SourceArtifacts {
  const raws = listing.artifacts.filter((artifact) => artifact.kind === "raw");
  const main = listing.pdfs.find((candidate) => candidate.main);
  const source = pdf
    ?? (raws.find((raw) => raw.source === main?.key) ?? raws[0])?.source
    ?? main?.key;
  return {
    source,
    sourceLabel: pdfLabel(listing, source),
    raw: raws.find((raw) => raw.source === source) ?? (pdf ? undefined : raws[0]),
    rawBackup: ofKind(listing, "raw-backup", source),
    tables: ofKind(listing, "tables", source),
    references: ofKind(listing, "references", source),
  };
}

/** One line per PDF saying what has been generated from it. */
export function coverage(listing: BridgeArtifacts): string[] {
  const sources = new Set<string | undefined>([
    ...listing.pdfs.map((pdf) => pdf.key),
    ...listing.artifacts
      .filter((artifact) => ["raw", "tables", "references"].includes(artifact.kind))
      .map((artifact) => artifact.source),
  ]);
  return [...sources].map((source) => {
    const has = (kind: string) => listing.artifacts.some(
      (artifact) => artifact.kind === kind && artifact.source === source,
    );
    const generated = ["raw", "tables", "references"].filter(has);
    return `${pdfLabel(listing, source)}: ${generated.length ? generated.join(", ") : "not converted"}`;
  });
}
