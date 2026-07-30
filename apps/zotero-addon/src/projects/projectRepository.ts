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
  BOARD_SCHEMA,
  PROJECT_SCHEMA,
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
  createID?: (kind: "project" | "board") => string;
}

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

function createStableID(kind: "project" | "board"): string {
  return `${kind}_${randomHex(16)}`;
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
  private readonly createID: (kind: "project" | "board") => string;
  private index?: ProjectIndexDocument;
  private writes: Promise<void> = Promise.resolve();

  public constructor(
    private readonly root: string,
    options: ProjectRepositoryOptions = {},
  ) {
    this.now = options.now || (() => Date.now());
    this.createID = options.createID || createStableID;
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
