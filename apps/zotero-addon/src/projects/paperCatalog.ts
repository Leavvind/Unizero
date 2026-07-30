/**
 * Minimal durable Paper catalog used by the Board vertical slice.
 *
 * A Zotero item is a binding on a stable Paper document, not the Paper ID itself.
 * External/provider observations will join this catalog in a later phase without
 * changing BoardNode.paperID.
 */

import { config } from "../../package.json";
import { literatureCandidateFromItem } from "../zotero/literatureCollectionAdapter";
import { libraryScope } from "../zotero/libraryScope";
import {
  createProjectObjectID,
  type ProjectObjectKind,
} from "./projectRepository";
import {
  PAPER_SCHEMA,
  type PaperDocument,
  type ZoteroPaperBinding,
} from "./types";

const PAPER_INDEX_SCHEMA = 1;

interface PaperIndexDocument {
  schema: number;
  bindings: Record<string, string>;
}

interface PaperCatalogOptions {
  now?: () => number;
  createID?: (kind: ProjectObjectKind) => string;
}

function isMissingFile(error: any): boolean {
  return error?.name === "NotFoundError" || error?.name === "NotAllowedError";
}

function defaultDataDirectory(): string {
  const dir = (Zotero as any).DataDirectory?.dir;
  if (typeof dir === "string" && dir) { return dir; }
  return Zotero.getTempDirectory().parent.path;
}

function bindingKey(binding: ZoteroPaperBinding): string {
  return `${binding.library}:${binding.itemKey}`;
}

export class PaperCatalog {
  private readonly now: () => number;
  private readonly createID: (kind: ProjectObjectKind) => string;
  private index?: PaperIndexDocument;
  private writes: Promise<void> = Promise.resolve();

  public constructor(
    private readonly root: string,
    options: PaperCatalogOptions = {},
  ) {
    this.now = options.now || (() => Date.now());
    this.createID = options.createID || createProjectObjectID;
  }

  public async ensureZoteroPaper(item: Zotero.Item): Promise<PaperDocument> {
    let result!: PaperDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        result = await this.ensureZoteroPaperExclusive(item);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async readPaper(paperID: string): Promise<PaperDocument> {
    await this.writes.catch(() => undefined);
    const paper = await this.readJSON(this.paperPath(paperID));
    if (
      paper?.schema !== PAPER_SCHEMA ||
      paper?.id !== paperID ||
      !Array.isArray(paper?.bindings)
    ) {
      throw new Error(`Unsupported or invalid Paper document: ${paperID}`);
    }
    return paper;
  }

  private async ensureZoteroPaperExclusive(
    item: Zotero.Item,
  ): Promise<PaperDocument> {
    const binding: ZoteroPaperBinding = {
      library: libraryScope(item.libraryID),
      itemKey: String(item.key),
    };
    const key = bindingKey(binding);
    const index = await this.loadIndex();
    const knownID = index.bindings[key];
    const candidate = literatureCandidateFromItem(item);
    const timestamp = this.now();
    const existing = knownID ? await this.readPaperDirect(knownID) : undefined;
    const paperID = existing?.id || this.createID("paper");
    const bindings = existing?.bindings?.some(
      (entry) => bindingKey(entry) === key,
    )
      ? existing.bindings
      : [...(existing?.bindings || []), binding];
    const paper: PaperDocument = {
      schema: PAPER_SCHEMA,
      id: paperID,
      identifiers: {
        doi: candidate.identifiers.DOI || undefined,
        arxiv: candidate.identifiers.arXiv || undefined,
        semanticScholarPaperId: candidate.identifiers.paperID || undefined,
      },
      title: candidate.title || "Untitled",
      authors: candidate.authors || [],
      year: candidate.year,
      type: candidate.type,
      primaryVenue: candidate.primaryVenue,
      abstract: candidate.abstract,
      bindings,
      retention: "zotero",
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    await this.writeJSON(this.paperPath(paperID), paper);
    if (!knownID) {
      const nextIndex = {
        schema: PAPER_INDEX_SCHEMA,
        bindings: { ...index.bindings, [key]: paperID },
      };
      await this.writeJSON(this.indexPath(), nextIndex);
      this.index = nextIndex;
    }
    return paper;
  }

  private async readPaperDirect(paperID: string): Promise<PaperDocument> {
    const paper = await this.readJSON(this.paperPath(paperID));
    if (
      paper?.schema !== PAPER_SCHEMA ||
      paper?.id !== paperID ||
      !Array.isArray(paper?.bindings)
    ) {
      throw new Error(`Unsupported or invalid Paper document: ${paperID}`);
    }
    return paper;
  }

  private async loadIndex(): Promise<PaperIndexDocument> {
    if (this.index) { return this.index; }
    try {
      const parsed = await this.readJSON(this.indexPath());
      if (
        parsed?.schema !== PAPER_INDEX_SCHEMA ||
        !parsed?.bindings ||
        typeof parsed.bindings !== "object"
      ) {
        throw new Error("Unsupported or invalid Paper index");
      }
      this.index = {
        schema: PAPER_INDEX_SCHEMA,
        bindings: parsed.bindings,
      };
    } catch (error) {
      if (!isMissingFile(error)) { throw error; }
      this.index = { schema: PAPER_INDEX_SCHEMA, bindings: {} };
    }
    return this.index;
  }

  private async readJSON(path: string): Promise<any> {
    return JSON.parse(await IOUtils.readUTF8(path) as string);
  }

  private async writeJSON(path: string, value: unknown): Promise<void> {
    await IOUtils.makeDirectory(PathUtils.parent(path)!, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.writeUTF8(path, JSON.stringify(value), {
      tmpPath: `${path}.tmp`,
    });
  }

  private indexPath(): string {
    return PathUtils.join(this.root, "index.json");
  }

  private paperPath(paperID: string): string {
    return PathUtils.join(this.root, "objects", `${paperID}.json`);
  }
}

let catalog: PaperCatalog | undefined;

function defaultCatalog(): PaperCatalog {
  if (!catalog) {
    catalog = new PaperCatalog(PathUtils.join(
      defaultDataDirectory(),
      config.addonRef,
      "literature",
    ));
  }
  return catalog;
}

export async function ensureCatalogPaper(
  item: Zotero.Item,
): Promise<PaperDocument> {
  return defaultCatalog().ensureZoteroPaper(item);
}

export async function readCatalogPaper(paperID: string): Promise<PaperDocument> {
  return defaultCatalog().readPaper(paperID);
}
