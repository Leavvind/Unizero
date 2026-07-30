/**
 * Local repository for user-authored Unizero Home projects.
 *
 * The files are a local projection, not a remote protocol:
 *
 *   <dataDir>/unizero/projects/index.json
 *   <dataDir>/unizero/projects/objects/<projectID>/project.json
 *   <dataDir>/unizero/projects/objects/<projectID>/boards/<boardID>.json
 *
 * Project and Board already have independent versioned envelopes so a future
 * sync engine can transport typed objects without uploading this directory as a
 * monolithic database file.
 */

import { config } from "../../package.json";
import type { LiteratureCollectionScope } from "../modules/literatureRelations";
import { libraryScope } from "../zotero/libraryScope";
import {
  BOARD_EDGE_SCHEMA,
  BOARD_NODE_SCHEMA,
  BOARD_SCHEMA,
  PROJECT_SCHEMA,
  type BoardNodeGeometry,
  type BoardContentBlock,
  type BoardManualEdgeDocument,
  type BoardNodeDocument,
  type BoardPaperNodeDocument,
  type BoardPaperContentBlock,
  type BoardTextNodeDocument,
  type BoardDocument,
  type ProjectBundle,
  type ProjectDocument,
  type ProjectSubject,
} from "./types";

const PROJECT_INDEX_SCHEMA = 1;

interface ProjectIndexDocument {
  schema: number;
  subjects: Record<string, string>;
}

interface ProjectRepositoryOptions {
  now?: () => number;
  createID?: (kind: ProjectObjectKind) => string;
}

export type ProjectObjectKind =
  | "project"
  | "board"
  | "node"
  | "edge"
  | "block"
  | "paper";

function isMissingFile(error: any): boolean {
  return error?.name === "NotFoundError" || error?.name === "NotAllowedError";
}

function defaultDataDirectory(): string {
  const dir = (Zotero as any).DataDirectory?.dir;
  if (typeof dir === "string" && dir) { return dir; }
  return Zotero.getTempDirectory().parent.path;
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(2, "0"))
      .join("");
  }
  const fallback = (Zotero.Utilities as any)?.randomString?.(bytes * 2);
  if (fallback) { return String(fallback).toLowerCase(); }
  throw new Error("A secure ID generator is unavailable");
}

export function createProjectObjectID(kind: ProjectObjectKind): string {
  return `${kind}_${randomHex(16)}`;
}

const DEFAULT_NODE_WIDTH = 228;
const DEFAULT_NODE_HEIGHT = 118;

export function validBoardGeometry(
  value: Partial<BoardNodeGeometry>,
): BoardNodeGeometry {
  const finite = (input: unknown, fallback: number) => {
    const number = Number(input);
    return Number.isFinite(number) ? number : fallback;
  };
  return {
    x: Math.max(-100_000, Math.min(100_000, finite(value.x, 0))),
    y: Math.max(-100_000, Math.min(100_000, finite(value.y, 0))),
    width: Math.max(160, Math.min(720, finite(value.width, DEFAULT_NODE_WIDTH))),
    height: Math.max(80, Math.min(520, finite(value.height, DEFAULT_NODE_HEIGHT))),
  };
}

function validBoardBlocks(value: unknown): BoardContentBlock[] | undefined {
  if (!Array.isArray(value)) { return; }
  const seen = new Set<string>();
  const blocks: BoardContentBlock[] = [];
  for (const raw of value) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    if (!id || seen.has(id)) { return; }
    seen.add(id);
    if (raw?.kind === "text" && typeof raw?.text === "string") {
      blocks.push({ id, kind: "text", text: raw.text.slice(0, 200_000) });
    } else if (raw?.kind === "paper" && typeof raw?.paperID === "string") {
      blocks.push({ id, kind: "paper", paperID: raw.paperID });
    } else {
      return;
    }
  }
  return blocks;
}

export function projectSubjectForScope(
  scope: LiteratureCollectionScope,
): ProjectSubject {
  const library = libraryScope(scope.libraryID);
  if (scope.collectionID !== undefined) {
    const collectionKey = String(scope.collectionKey || "").trim();
    if (!collectionKey) {
      throw new Error("A Zotero Collection key is required for a portable Project");
    }
    return { kind: "collection", library, collectionKey };
  }
  return { kind: "library", library };
}

export function projectSubjectKey(subject: ProjectSubject): string {
  return subject.kind === "collection"
    ? `${subject.library}:collection:${subject.collectionKey}`
    : `${subject.library}:library`;
}

function sameSubject(left: ProjectSubject, right: ProjectSubject): boolean {
  return projectSubjectKey(left) === projectSubjectKey(right);
}

export class ProjectRepository {
  private readonly now: () => number;
  private readonly createID: (kind: ProjectObjectKind) => string;
  private index?: ProjectIndexDocument;
  private writes: Promise<void> = Promise.resolve();

  public constructor(
    private readonly root: string,
    options: ProjectRepositoryOptions = {},
  ) {
    this.now = options.now || (() => Date.now());
    this.createID = options.createID || createProjectObjectID;
  }

  public async ensureProject(
    subject: ProjectSubject,
    name: string,
  ): Promise<ProjectBundle> {
    let result!: ProjectBundle;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        result = await this.ensureProjectExclusive(subject, name);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async listBoardNodes(
    projectID: string,
    boardID: string,
  ): Promise<BoardNodeDocument[]> {
    await this.writes.catch(() => undefined);
    const directory = this.nodesPath(projectID, boardID);
    let paths: string[];
    try {
      paths = await IOUtils.getChildren(directory);
    } catch (error) {
      if (isMissingFile(error)) { return []; }
      throw error;
    }
    const nodes: BoardNodeDocument[] = [];
    for (const path of paths) {
      if (!String(path).endsWith(".json")) { continue; }
      try {
        const node = await this.readJSON(path);
        const valid = this.validBoardNode(node, projectID, boardID);
        if (valid && !valid.deletedAt) { nodes.push(valid); }
      } catch (error) {
        ztoolkit.log(`Board node unreadable at ${path}: ${error}`);
      }
    }
    return nodes.sort((left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  public async createPaperNode(
    projectID: string,
    boardID: string,
    paperID: string,
    geometry: Partial<BoardNodeGeometry>,
  ): Promise<BoardPaperNodeDocument> {
    let result!: BoardPaperNodeDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        await this.assertBoard(projectID, boardID);
        const timestamp = this.now();
        result = {
          schema: BOARD_NODE_SCHEMA,
          id: this.createID("node"),
          projectID,
          boardID,
          kind: "paper",
          paperID,
          geometry: validBoardGeometry(geometry),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await this.writeJSON(this.nodePath(projectID, boardID, result.id), result);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async createTextNode(
    projectID: string,
    boardID: string,
    geometry: Partial<BoardNodeGeometry>,
  ): Promise<BoardTextNodeDocument> {
    let result!: BoardTextNodeDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        await this.assertBoard(projectID, boardID);
        const timestamp = this.now();
        result = {
          schema: BOARD_NODE_SCHEMA,
          id: this.createID("node"),
          projectID,
          boardID,
          kind: "text",
          geometry: validBoardGeometry({
            width: 320,
            height: 240,
            ...geometry,
          }),
          blocks: [{
            id: this.createID("block"),
            kind: "text",
            text: "",
          }],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await this.writeJSON(this.nodePath(projectID, boardID, result.id), result);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async updateTextBlock(
    projectID: string,
    boardID: string,
    nodeID: string,
    blockID: string,
    text: string,
  ): Promise<BoardTextNodeDocument> {
    let result!: BoardTextNodeDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readBoardNode(projectID, boardID, nodeID);
        if (current.kind !== "text") {
          throw new Error(`Board node is not a text container: ${nodeID}`);
        }
        let found = false;
        const blocks = current.blocks.map((block) => {
          if (block.id !== blockID) { return block; }
          if (block.kind !== "text") {
            throw new Error(`Board block is not editable text: ${blockID}`);
          }
          found = true;
          return { ...block, text: String(text || "").slice(0, 200_000) };
        });
        if (!found) { throw new Error(`Board text block not found: ${blockID}`); }
        result = { ...current, blocks, updatedAt: this.now() };
        await this.writeJSON(this.nodePath(projectID, boardID, nodeID), result);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async addPaperBlock(
    projectID: string,
    boardID: string,
    nodeID: string,
    paperID: string,
  ): Promise<BoardTextNodeDocument> {
    let result!: BoardTextNodeDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readBoardNode(projectID, boardID, nodeID);
        if (current.kind !== "text") {
          throw new Error(`Board node is not a text container: ${nodeID}`);
        }
        const block: BoardPaperContentBlock = {
          id: this.createID("block"),
          kind: "paper",
          paperID,
        };
        result = {
          ...current,
          blocks: [...current.blocks, block],
          updatedAt: this.now(),
        };
        await this.writeJSON(this.nodePath(projectID, boardID, nodeID), result);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async deleteContentBlock(
    projectID: string,
    boardID: string,
    nodeID: string,
    blockID: string,
  ): Promise<BoardTextNodeDocument> {
    let result!: BoardTextNodeDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readBoardNode(projectID, boardID, nodeID);
        if (current.kind !== "text") {
          throw new Error(`Board node is not a text container: ${nodeID}`);
        }
        const blocks = current.blocks.filter((block) => block.id !== blockID);
        if (blocks.length === current.blocks.length) {
          throw new Error(`Board content block not found: ${blockID}`);
        }
        result = { ...current, blocks, updatedAt: this.now() };
        await this.writeJSON(this.nodePath(projectID, boardID, nodeID), result);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async listBoardEdges(
    projectID: string,
    boardID: string,
  ): Promise<BoardManualEdgeDocument[]> {
    await this.writes.catch(() => undefined);
    const directory = this.edgesPath(projectID, boardID);
    let paths: string[];
    try {
      paths = await IOUtils.getChildren(directory);
    } catch (error) {
      if (isMissingFile(error)) { return []; }
      throw error;
    }
    const edges: BoardManualEdgeDocument[] = [];
    for (const path of paths) {
      if (!String(path).endsWith(".json")) { continue; }
      try {
        const edge = await this.readJSON(path);
        if (
          edge?.schema === BOARD_EDGE_SCHEMA &&
          edge?.projectID === projectID &&
          edge?.boardID === boardID &&
          edge?.kind === "manual" &&
          typeof edge?.sourceNodeID === "string" &&
          typeof edge?.targetNodeID === "string" &&
          !edge.deletedAt
        ) {
          edges.push(edge);
        }
      } catch (error) {
        ztoolkit.log(`Board edge unreadable at ${path}: ${error}`);
      }
    }
    return edges.sort((left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  public async createManualEdge(
    projectID: string,
    boardID: string,
    sourceNodeID: string,
    targetNodeID: string,
  ): Promise<BoardManualEdgeDocument> {
    if (sourceNodeID === targetNodeID) {
      throw new Error("A manual edge needs two different Board nodes");
    }
    let result!: BoardManualEdgeDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        await Promise.all([
          this.readBoardNode(projectID, boardID, sourceNodeID),
          this.readBoardNode(projectID, boardID, targetNodeID),
        ]);
        const timestamp = this.now();
        result = {
          schema: BOARD_EDGE_SCHEMA,
          id: this.createID("edge"),
          projectID,
          boardID,
          kind: "manual",
          sourceNodeID,
          targetNodeID,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await this.writeJSON(this.edgePath(projectID, boardID, result.id), result);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async moveBoardNode(
    projectID: string,
    boardID: string,
    nodeID: string,
    geometry: Partial<BoardNodeGeometry>,
  ): Promise<BoardNodeDocument> {
    let result!: BoardNodeDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readBoardNode(projectID, boardID, nodeID);
        const patch: Partial<BoardNodeGeometry> = {};
        for (const key of ["x", "y", "width", "height"] as const) {
          const value = geometry[key];
          if (Number.isFinite(Number(value))) { patch[key] = Number(value); }
        }
        result = {
          ...current,
          geometry: validBoardGeometry({
            ...current.geometry,
            ...patch,
          }),
          updatedAt: this.now(),
        };
        await this.writeJSON(this.nodePath(projectID, boardID, nodeID), result);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async deleteBoardNode(
    projectID: string,
    boardID: string,
    nodeID: string,
  ): Promise<BoardNodeDocument> {
    let result!: BoardNodeDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readBoardNode(projectID, boardID, nodeID);
        const timestamp = this.now();
        result = { ...current, updatedAt: timestamp, deletedAt: timestamp };
        await this.writeJSON(this.nodePath(projectID, boardID, nodeID), result);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  public async deleteBoardEdge(
    projectID: string,
    boardID: string,
    edgeID: string,
  ): Promise<BoardManualEdgeDocument> {
    let result!: BoardManualEdgeDocument;
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readBoardEdge(projectID, boardID, edgeID);
        const timestamp = this.now();
        result = { ...current, updatedAt: timestamp, deletedAt: timestamp };
        await this.writeJSON(this.edgePath(projectID, boardID, edgeID), result);
      });
    this.writes = operation;
    await operation;
    return result;
  }

  private async ensureProjectExclusive(
    subject: ProjectSubject,
    rawName: string,
  ): Promise<ProjectBundle> {
    const name = String(rawName || "").trim() || "Untitled Project";
    const index = await this.loadIndex();
    const subjectKey = projectSubjectKey(subject);
    const knownID = index.subjects[subjectKey];
    if (knownID) {
      const existing = await this.readBundle(knownID);
      if (!sameSubject(existing.project.subject, subject)) {
        throw new Error(`Project subject mismatch for ${knownID}`);
      }
      if (existing.project.name !== name) {
        const project = {
          ...existing.project,
          name,
          updatedAt: this.now(),
        };
        await this.writeJSON(this.projectPath(project.id), project);
        return { ...existing, project };
      }
      return existing;
    }

    const timestamp = this.now();
    const projectID = this.createID("project");
    const boardID = this.createID("board");
    const project: ProjectDocument = {
      schema: PROJECT_SCHEMA,
      id: projectID,
      subject,
      name,
      defaultBoardID: boardID,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const defaultBoard: BoardDocument = {
      schema: BOARD_SCHEMA,
      id: boardID,
      projectID,
      name: "Board",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Write objects before publishing their subject mapping. A crash may leave
    // recoverable orphan files, but never an index entry pointing to half a bundle.
    await this.writeJSON(this.projectPath(projectID), project);
    await this.writeJSON(this.boardPath(projectID, boardID), defaultBoard);
    const nextIndex: ProjectIndexDocument = {
      schema: PROJECT_INDEX_SCHEMA,
      subjects: { ...index.subjects, [subjectKey]: projectID },
    };
    await this.writeJSON(this.indexPath(), nextIndex);
    this.index = nextIndex;
    return { project, defaultBoard };
  }

  private async readBundle(projectID: string): Promise<ProjectBundle> {
    const project = await this.readJSON(this.projectPath(projectID));
    if (
      project?.schema !== PROJECT_SCHEMA ||
      project?.id !== projectID ||
      typeof project?.defaultBoardID !== "string"
    ) {
      throw new Error(`Unsupported or invalid Project document: ${projectID}`);
    }
    const defaultBoard = await this.readJSON(
      this.boardPath(projectID, project.defaultBoardID),
    );
    if (
      defaultBoard?.schema !== BOARD_SCHEMA ||
      defaultBoard?.id !== project.defaultBoardID ||
      defaultBoard?.projectID !== projectID
    ) {
      throw new Error(`Unsupported or invalid Board document: ${project.defaultBoardID}`);
    }
    return { project, defaultBoard };
  }

  private async assertBoard(projectID: string, boardID: string): Promise<void> {
    const board = await this.readJSON(this.boardPath(projectID, boardID));
    if (
      board?.schema !== BOARD_SCHEMA ||
      board?.id !== boardID ||
      board?.projectID !== projectID
    ) {
      throw new Error(`Unsupported or invalid Board document: ${boardID}`);
    }
  }

  private async readBoardNode(
    projectID: string,
    boardID: string,
    nodeID: string,
  ): Promise<BoardNodeDocument> {
    const node = await this.readJSON(this.nodePath(projectID, boardID, nodeID));
    const valid = this.validBoardNode(node, projectID, boardID);
    if (!valid || valid.id !== nodeID || valid.deletedAt) {
      throw new Error(`Unsupported or invalid Board node: ${nodeID}`);
    }
    return valid;
  }

  private validBoardNode(
    node: any,
    projectID: string,
    boardID: string,
  ): BoardNodeDocument | undefined {
    if (
      node?.schema !== BOARD_NODE_SCHEMA ||
      typeof node?.id !== "string" ||
      node?.projectID !== projectID ||
      node?.boardID !== boardID
    ) {
      return;
    }
    const geometry = validBoardGeometry(node.geometry || {});
    if (node.kind === "paper" && typeof node.paperID === "string") {
      return { ...node, geometry };
    }
    if (node.kind === "text") {
      const blocks = validBoardBlocks(node.blocks);
      if (blocks) { return { ...node, geometry, blocks }; }
    }
    return;
  }

  private async readBoardEdge(
    projectID: string,
    boardID: string,
    edgeID: string,
  ): Promise<BoardManualEdgeDocument> {
    const edge = await this.readJSON(this.edgePath(projectID, boardID, edgeID));
    if (
      edge?.schema !== BOARD_EDGE_SCHEMA ||
      edge?.id !== edgeID ||
      edge?.projectID !== projectID ||
      edge?.boardID !== boardID ||
      edge?.kind !== "manual" ||
      edge?.deletedAt
    ) {
      throw new Error(`Unsupported or invalid Board edge: ${edgeID}`);
    }
    return edge;
  }

  private async loadIndex(): Promise<ProjectIndexDocument> {
    if (this.index) { return this.index; }
    try {
      const parsed = await this.readJSON(this.indexPath());
      if (
        parsed?.schema !== PROJECT_INDEX_SCHEMA ||
        !parsed?.subjects ||
        typeof parsed.subjects !== "object"
      ) {
        throw new Error("Unsupported or invalid Project index");
      }
      this.index = {
        schema: PROJECT_INDEX_SCHEMA,
        subjects: parsed.subjects,
      };
    } catch (error) {
      if (!isMissingFile(error)) { throw error; }
      this.index = { schema: PROJECT_INDEX_SCHEMA, subjects: {} };
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

  private projectPath(projectID: string): string {
    return PathUtils.join(this.root, "objects", projectID, "project.json");
  }

  private boardPath(projectID: string, boardID: string): string {
    return PathUtils.join(
      this.root,
      "objects",
      projectID,
      "boards",
      `${boardID}.json`,
    );
  }

  private nodesPath(projectID: string, boardID: string): string {
    return PathUtils.join(
      this.root,
      "objects",
      projectID,
      "boards",
      boardID,
      "nodes",
    );
  }

  private nodePath(projectID: string, boardID: string, nodeID: string): string {
    return PathUtils.join(this.nodesPath(projectID, boardID), `${nodeID}.json`);
  }

  private edgesPath(projectID: string, boardID: string): string {
    return PathUtils.join(
      this.root,
      "objects",
      projectID,
      "boards",
      boardID,
      "edges",
    );
  }

  private edgePath(projectID: string, boardID: string, edgeID: string): string {
    return PathUtils.join(this.edgesPath(projectID, boardID), `${edgeID}.json`);
  }
}

let repository: ProjectRepository | undefined;

function defaultRepository(): ProjectRepository {
  if (!repository) {
    repository = new ProjectRepository(PathUtils.join(
      defaultDataDirectory(),
      config.addonRef,
      "projects",
    ));
  }
  return repository;
}

export async function ensureProjectForScope(
  scope: LiteratureCollectionScope,
): Promise<ProjectBundle> {
  return defaultRepository().ensureProject(
    projectSubjectForScope(scope),
    scope.name,
  );
}

export async function listDefaultBoardNodes(
  bundle: ProjectBundle,
): Promise<BoardNodeDocument[]> {
  return defaultRepository().listBoardNodes(
    bundle.project.id,
    bundle.defaultBoard.id,
  );
}

export async function listDefaultBoardEdges(
  bundle: ProjectBundle,
): Promise<BoardManualEdgeDocument[]> {
  return defaultRepository().listBoardEdges(
    bundle.project.id,
    bundle.defaultBoard.id,
  );
}

export async function createDefaultBoardPaperNode(
  bundle: ProjectBundle,
  paperID: string,
  geometry: Partial<BoardNodeGeometry>,
): Promise<BoardPaperNodeDocument> {
  return defaultRepository().createPaperNode(
    bundle.project.id,
    bundle.defaultBoard.id,
    paperID,
    geometry,
  );
}

export async function createDefaultBoardTextNode(
  bundle: ProjectBundle,
  geometry: Partial<BoardNodeGeometry>,
): Promise<BoardTextNodeDocument> {
  return defaultRepository().createTextNode(
    bundle.project.id,
    bundle.defaultBoard.id,
    geometry,
  );
}

export async function updateDefaultBoardTextBlock(
  bundle: ProjectBundle,
  nodeID: string,
  blockID: string,
  text: string,
): Promise<BoardTextNodeDocument> {
  return defaultRepository().updateTextBlock(
    bundle.project.id,
    bundle.defaultBoard.id,
    nodeID,
    blockID,
    text,
  );
}

export async function addDefaultBoardPaperBlock(
  bundle: ProjectBundle,
  nodeID: string,
  paperID: string,
): Promise<BoardTextNodeDocument> {
  return defaultRepository().addPaperBlock(
    bundle.project.id,
    bundle.defaultBoard.id,
    nodeID,
    paperID,
  );
}

export async function deleteDefaultBoardContentBlock(
  bundle: ProjectBundle,
  nodeID: string,
  blockID: string,
): Promise<BoardTextNodeDocument> {
  return defaultRepository().deleteContentBlock(
    bundle.project.id,
    bundle.defaultBoard.id,
    nodeID,
    blockID,
  );
}

export async function moveDefaultBoardNode(
  bundle: ProjectBundle,
  nodeID: string,
  geometry: Partial<BoardNodeGeometry>,
): Promise<BoardNodeDocument> {
  return defaultRepository().moveBoardNode(
    bundle.project.id,
    bundle.defaultBoard.id,
    nodeID,
    geometry,
  );
}

export async function createDefaultBoardManualEdge(
  bundle: ProjectBundle,
  sourceNodeID: string,
  targetNodeID: string,
): Promise<BoardManualEdgeDocument> {
  return defaultRepository().createManualEdge(
    bundle.project.id,
    bundle.defaultBoard.id,
    sourceNodeID,
    targetNodeID,
  );
}

export async function deleteDefaultBoardNode(
  bundle: ProjectBundle,
  nodeID: string,
): Promise<BoardNodeDocument> {
  return defaultRepository().deleteBoardNode(
    bundle.project.id,
    bundle.defaultBoard.id,
    nodeID,
  );
}

export async function deleteDefaultBoardEdge(
  bundle: ProjectBundle,
  edgeID: string,
): Promise<BoardManualEdgeDocument> {
  return defaultRepository().deleteBoardEdge(
    bundle.project.id,
    bundle.defaultBoard.id,
    edgeID,
  );
}
