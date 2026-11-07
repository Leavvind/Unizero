import type { ZoteroLibraryScope } from "../zotero/libraryScope";

export const PAPER_SCHEMA = 1 as const;
export const LITERATURE_OBSERVATION_SCHEMA = 1 as const;
export const PAPER_REDIRECT_SCHEMA = 1 as const;

export interface PaperIdentifiers {
  doi?: string;
  arxiv?: string;
  semanticScholarPaperId?: string;
  openAlexId?: string;
}

export interface ZoteroPaperBinding {
  library: ZoteroLibraryScope;
  itemKey: string;
}

/**
 * Library and external papers share one record shape. A Zotero binding is
 * optional and can be added later without replacing the stable paper ID.
 */
export interface PaperDocument {
  schema: typeof PAPER_SCHEMA;
  id: string;
  identifiers: PaperIdentifiers;
  title: string;
  authors: string[];
  year?: string;
  type?: string;
  primaryVenue?: string;
  abstract?: string;
  bindings: ZoteroPaperBinding[];
  /** The Zotero binding whose metadata wins after an explicit multi-item merge. */
  canonicalBinding?: ZoteroPaperBinding;
  retention: "cache" | "pinned" | "zotero";
  createdAt: number;
  updatedAt: number;
}

/**
 * An explicit, user-reviewed identity merge keeps old Paper IDs resolvable
 * without pretending that two provider identifiers were always known to describe
 * one Paper.
 */
export interface PaperRedirectDocument {
  schema: typeof PAPER_REDIRECT_SCHEMA;
  kind: "paper-redirect";
  sourcePaperID: string;
  targetPaperID: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * References and Citations are two discovery routes to the same directed edge.
 * Provider provenance remains on the observation instead of being flattened into
 * an apparently timeless fact.
 */
export interface LiteratureCitationObservation {
  schema: typeof LITERATURE_OBSERVATION_SCHEMA;
  id: string;
  kind: "cites";
  citingPaperID: string;
  citedPaperID: string;
  provider: string;
  queryKind: "references" | "citations";
  retrievedAt: number;
  sourceOrder?: number;
}
