import type { ZoteroLibraryScope } from "../zotero/libraryScope";

export const PROJECT_SCHEMA = 1 as const;
export const BOARD_SCHEMA = 1 as const;
export const BOARD_NODE_SCHEMA = 1 as const;
export const BOARD_EDGE_SCHEMA = 1 as const;
export const PAPER_SCHEMA = 1 as const;
export const LITERATURE_OBSERVATION_SCHEMA = 1 as const;
export const PAPER_REDIRECT_SCHEMA = 1 as const;

const PORTABLE_OBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Persisted object IDs are opaque names, never paths. Keep this deliberately
 * narrower than a general filename so imported sync data cannot escape a
 * repository root or create platform-dependent paths.
 */
export function isPortableObjectID(value: unknown): value is string {
  return typeof value === "string" &&
    PORTABLE_OBJECT_ID_PATTERN.test(value) &&
    value !== "." &&
    value !== "..";
}

export interface PaperIdentifiers {
  doi?: string;
  arxiv?: string;
  semanticScholarPaperId?: string;
  openAlexId?: string;
}

/**
 * A portable subject for one Unizero Home project.
 *
 * Zotero's numeric libraryID and collectionID are deliberately absent: they are
 * local database row IDs and can differ between devices. Zotero item/collection
 * keys and the logical personal/group scope survive Zotero Sync.
 */
export type ProjectSubject =
  | {
      kind: "library";
      library: ZoteroLibraryScope;
    }
  | {
      kind: "collection";
      library: ZoteroLibraryScope;
      collectionKey: string;
    };

export interface ProjectDocument {
  schema: typeof PROJECT_SCHEMA;
  id: string;
  subject: ProjectSubject;
  name: string;
  defaultBoardID: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Board objects are separate from their nodes and edges so moving one card does
 * not turn the whole project into one sync-conflict document.
 */
export interface BoardDocument {
  schema: typeof BOARD_SCHEMA;
  id: string;
  projectID: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface BoardNodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardPaperNodeDocument {
  schema: typeof BOARD_NODE_SCHEMA;
  id: string;
  projectID: string;
  boardID: string;
  kind: "paper";
  paperID: string;
  geometry: BoardNodeGeometry;
  titleOverride?: string;
  note?: string;
  colour?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface BoardTextContentBlock {
  id: string;
  kind: "text";
  text: string;
}

export interface BoardPaperContentBlock {
  id: string;
  kind: "paper";
  paperID: string;
}

export type BoardContentBlock =
  | BoardTextContentBlock
  | BoardPaperContentBlock;

/**
 * A text node is a Canvas frame with an ordered block body. Paper blocks reference
 * the same stable Paper catalog as standalone paper nodes, so embedding never
 * copies bibliographic identity or creates a Zotero item.
 */
export interface BoardTextNodeDocument {
  schema: typeof BOARD_NODE_SCHEMA;
  id: string;
  projectID: string;
  boardID: string;
  kind: "text";
  geometry: BoardNodeGeometry;
  blocks: BoardContentBlock[];
  colour?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export type BoardNodeDocument =
  | BoardPaperNodeDocument
  | BoardTextNodeDocument;

/**
 * Manual edges connect card instances, not papers. The same paper may occur more
 * than once on a board, and each occurrence can participate in a different
 * argument. A future explicit command may separately write a Zotero relation.
 */
export interface BoardManualEdgeDocument {
  schema: typeof BOARD_EDGE_SCHEMA;
  id: string;
  projectID: string;
  boardID: string;
  kind: "manual";
  sourceNodeID: string;
  targetNodeID: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface ZoteroPaperBinding {
  library: ZoteroLibraryScope;
  itemKey: string;
}

/**
 * Library and external papers share one record shape. A Zotero binding is
 * optional and can be added later without replacing the stable paper ID used by
 * board nodes.
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
 * An explicit, user-reviewed identity merge keeps old Board and sync references
 * resolvable without pretending that two provider identifiers were always known
 * to describe one Paper.
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

export interface ProjectBundle {
  project: ProjectDocument;
  defaultBoard: BoardDocument;
}

export type PortableProjectObject =
  | ProjectDocument
  | BoardDocument
  | BoardNodeDocument
  | BoardManualEdgeDocument;
