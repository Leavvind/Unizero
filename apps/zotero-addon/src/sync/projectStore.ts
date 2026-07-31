import {
  applyPortableProjectObject,
  listPortableProjectObjects,
} from "../projects/projectRepository";
import {
  BOARD_EDGE_SCHEMA,
  BOARD_NODE_SCHEMA,
  BOARD_SCHEMA,
  isPortableObjectID,
  PROJECT_SCHEMA,
  type PortableProjectObject,
} from "../projects/types";
import { latestWriteWinsNamespace } from "./documents";
import {
  SYNC_DOCUMENT_SCHEMA,
  type SyncDocument,
  type SyncLocalStore,
  type SyncNamespace,
  type SyncNamespaceName,
  syncObjectKey,
} from "./types";

function namespaceForObject(
  object: PortableProjectObject,
): SyncNamespaceName {
  if ("subject" in object) { return "project.meta"; }
  if (!("boardID" in object)) { return "project.board"; }
  return object.kind === "manual"
    ? "project.board-edge"
    : "project.board-node";
}

function projectIDForObject(object: PortableProjectObject): string {
  return "projectID" in object ? object.projectID : object.id;
}

function validatePortableObject(
  namespace: SyncNamespaceName,
  payload: unknown,
): PortableProjectObject {
  const object = payload as any;
  const common = object && isPortableObjectID(object.id) &&
    typeof object.createdAt === "number" &&
    typeof object.updatedAt === "number";
  if (!common) { throw new Error(`Invalid ${namespace} payload`); }
  if (
    namespace === "project.meta" &&
    object.schema === PROJECT_SCHEMA &&
    validProjectSubject(object.subject) &&
    isPortableObjectID(object.defaultBoardID)
  ) {
    return object;
  }
  if (
    namespace === "project.board" &&
    object.schema === BOARD_SCHEMA &&
    isPortableObjectID(object.projectID) &&
    typeof object.name === "string"
  ) {
    return object;
  }
  if (
    namespace === "project.board-node" &&
    object.schema === BOARD_NODE_SCHEMA &&
    isPortableObjectID(object.projectID) &&
    isPortableObjectID(object.boardID) &&
    (object.kind === "paper" || object.kind === "text")
  ) {
    return object;
  }
  if (
    namespace === "project.board-edge" &&
    object.schema === BOARD_EDGE_SCHEMA &&
    isPortableObjectID(object.projectID) &&
    isPortableObjectID(object.boardID) &&
    object.kind === "manual" &&
    isPortableObjectID(object.sourceNodeID) &&
    isPortableObjectID(object.targetNodeID)
  ) {
    return object;
  }
  throw new Error(`Invalid ${namespace} payload`);
}

function validProjectSubject(subject: any): boolean {
  const library = subject?.library;
  const validLibrary = library === "library" ||
    (typeof library === "string" && /^groups\/[1-9]\d*$/.test(library));
  if (!validLibrary) { return false; }
  if (subject.kind === "library") { return true; }
  return subject.kind === "collection" &&
    typeof subject.collectionKey === "string" &&
    subject.collectionKey.length > 0 &&
    subject.collectionKey.length <= 255;
}

function namespace(
  name: SyncNamespaceName,
  schema: number,
): SyncNamespace<PortableProjectObject> {
  return latestWriteWinsNamespace(
    name,
    schema,
    (payload) => validatePortableObject(name, payload),
  );
}

export const PROJECT_SYNC_NAMESPACES: SyncNamespace[] = [
  namespace("project.meta", PROJECT_SCHEMA),
  namespace("project.board", BOARD_SCHEMA),
  namespace("project.board-node", BOARD_NODE_SCHEMA),
  namespace("project.board-edge", BOARD_EDGE_SCHEMA),
];

/**
 * One store instance serves exactly one sync run, so its snapshot of the
 * repository is scoped to that run. Without it, applying a pack re-read every
 * Project object once per document in the pack.
 */
export class ProjectSyncLocalStore implements SyncLocalStore {
  private snapshot?: Map<string, SyncDocument>;

  public constructor(private readonly deviceID: string) {}

  public async list(): Promise<SyncDocument[]> {
    return [...(await this.load()).values()];
  }

  public async get(
    namespaceName: SyncNamespaceName,
    id: string,
  ): Promise<SyncDocument | undefined> {
    return (await this.load()).get(syncObjectKey(namespaceName, id));
  }

  public async put(document: SyncDocument): Promise<void> {
    const syncNamespace = PROJECT_SYNC_NAMESPACES.find(
      (entry) => entry.name === document.namespace,
    );
    if (!syncNamespace) {
      throw new Error(
        `Project store cannot import namespace ${document.namespace}`,
      );
    }
    const valid = syncNamespace.migrate(document);
    const object = valid.payload as PortableProjectObject;
    if (valid.id !== object.id) {
      throw new Error(`Project sync document ID mismatch: ${valid.id}`);
    }
    if (
      valid.scope.kind !== "project" ||
      valid.scope.id !== projectIDForObject(object)
    ) {
      throw new Error(`Project sync scope mismatch: ${valid.id}`);
    }
    // Cache what the repository actually stored, not what arrived: geometry and
    // block contents are normalized on write, and a snapshot holding the
    // pre-normalization shape would make the next run see a phantom change.
    const stored = this.document(await applyPortableProjectObject(object));
    (await this.load()).set(
      syncObjectKey(stored.namespace, stored.id),
      stored,
    );
  }

  private async load(): Promise<Map<string, SyncDocument>> {
    if (!this.snapshot) {
      this.snapshot = new Map(
        (await listPortableProjectObjects()).map((object) => {
          const entry = this.document(object);
          return [syncObjectKey(entry.namespace, entry.id), entry];
        }),
      );
    }
    return this.snapshot;
  }

  private document(object: PortableProjectObject): SyncDocument {
    return {
      syncSchema: SYNC_DOCUMENT_SCHEMA,
      namespace: namespaceForObject(object),
      id: object.id,
      schema: object.schema,
      scope: { kind: "project", id: projectIDForObject(object) },
      updatedAt: object.updatedAt,
      deviceID: this.deviceID,
      payload: object,
    };
  }
}
