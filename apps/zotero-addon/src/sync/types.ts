/**
 * Backend-neutral sync contracts.
 *
 * Local repositories and WebDAV are adapters around these types. In particular,
 * no namespace is allowed to know a remote URL, credential, ETag, or directory
 * layout.
 */

export const SYNC_DOCUMENT_SCHEMA = 1 as const;
export const SYNC_PACK_SCHEMA = 1 as const;
export const SYNC_MANIFEST_SCHEMA = 1 as const;
export const SYNC_CHECKPOINT_SCHEMA = 1 as const;

export type SyncNamespaceName =
  | "project.meta"
  | "project.board"
  | "project.board-node"
  | "project.board-edge"
  | "literature.paper"
  | "literature.observation"
  | "literature.paper-redirect";

export type SyncScope =
  | { kind: "profile"; id: string }
  | { kind: "library"; id: string }
  | { kind: "project"; id: string };

export interface SyncDocument<T = unknown> {
  syncSchema: typeof SYNC_DOCUMENT_SCHEMA;
  namespace: SyncNamespaceName;
  id: string;
  schema: number;
  scope: SyncScope;
  updatedAt: number;
  deviceID: string;
  payload: T;
}

export interface SyncPackDescriptor {
  id: string;
  path: string;
  checksum: string;
  createdAt: number;
  documentCount: number;
}

export interface SyncPackDocument {
  schema: typeof SYNC_PACK_SCHEMA;
  id: string;
  deviceID: string;
  createdAt: number;
  documents: SyncDocument[];
}

export interface SyncManifestDocument {
  schema: typeof SYNC_MANIFEST_SCHEMA;
  deviceID: string;
  updatedAt: number;
  packs: Record<string, SyncPackDescriptor>;
}

export interface SyncCheckpoint {
  schema: typeof SYNC_CHECKPOINT_SCHEMA;
  appliedPackIDs: string[];
  exportedChecksums: Record<string, string>;
  /**
   * Packs that carried at least one document this build could not apply, and
   * the namespaces responsible. A pack is still marked applied so the run can
   * make progress; once a later build registers one of those namespaces, the
   * engine replays exactly these packs instead of leaving the data unreachable.
   * Absent on checkpoints written before deferral existed.
   */
  deferredPackIDs?: string[];
  deferredNamespaces?: string[];
}

export interface RemoteObject {
  body: string;
  revision?: string;
  modifiedAt?: number;
}

export interface RemoteEntry {
  key: string;
  collection: boolean;
  revision?: string;
  modifiedAt?: number;
}

export interface WriteCondition {
  ifMatch?: string;
  ifNoneMatch?: boolean;
}

export interface SyncBackend {
  connect(): Promise<void>;
  list(prefix: string): Promise<RemoteEntry[]>;
  get(key: string): Promise<RemoteObject | undefined>;
  put(
    key: string,
    body: string,
    condition?: WriteCondition,
  ): Promise<{ revision?: string }>;
  remove(key: string, condition?: WriteCondition): Promise<void>;
}

export interface SyncLocalStore {
  list(): Promise<SyncDocument[]>;
  get(
    namespace: SyncNamespaceName,
    id: string,
  ): Promise<SyncDocument | undefined>;
  put(document: SyncDocument): Promise<void>;
}

export interface SyncCheckpointStore {
  load(): Promise<SyncCheckpoint>;
  save(checkpoint: SyncCheckpoint): Promise<void>;
}

export interface SyncMergeContext {
  deviceID: string;
  now: number;
}

export interface SyncNamespace<T = unknown> {
  name: SyncNamespaceName;
  currentSchema: number;
  validate(document: SyncDocument<unknown>): SyncDocument<T>;
  migrate(document: SyncDocument<unknown>): SyncDocument<T>;
  merge(
    local: SyncDocument<T>,
    remote: SyncDocument<T>,
    context: SyncMergeContext,
  ): SyncDocument<T>;
}

export interface SyncRunResult {
  uploaded: number;
  downloaded: number;
  merged: number;
  unchanged: number;
  packsUploaded: number;
  packsDownloaded: number;
  remaining: number;
  /** Documents in a namespace this build does not know; deferred, not lost. */
  skipped: number;
}

export function syncObjectKey(
  namespace: SyncNamespaceName,
  id: string,
): string {
  return `${namespace}\u0000${id}`;
}
