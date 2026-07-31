import {
  parseSyncDocument,
  stableJSONString,
  syncChecksum,
  syncDocumentChecksum,
} from "./documents";
import {
  SYNC_CHECKPOINT_SCHEMA,
  SYNC_MANIFEST_SCHEMA,
  SYNC_PACK_SCHEMA,
  type RemoteObject,
  type SyncBackend,
  type SyncCheckpoint,
  type SyncCheckpointStore,
  type SyncDocument,
  type SyncLocalStore,
  type SyncManifestDocument,
  type SyncNamespace,
  type SyncNamespaceName,
  type SyncPackDescriptor,
  type SyncPackDocument,
  type SyncRunResult,
  syncObjectKey,
} from "./types";

const DEFAULT_MAX_DOCUMENTS_PER_PACK = 256;
const DEFAULT_MAX_PACK_BYTES = 1_000_000;
const DEFAULT_MAX_PACKS_PER_RUN = 4;
const NAMESPACE_ORDER: SyncNamespaceName[] = [
  "project.meta",
  "project.board",
  "project.board-node",
  "project.board-edge",
  "literature.paper",
  "literature.paper-redirect",
  "literature.observation",
];

export interface SyncEngineOptions {
  deviceID: string;
  now?: () => number;
  maxDocumentsPerPack?: number;
  maxPackBytes?: number;
  maxPacksPerRun?: number;
  maxRetries?: number;
}

function manifestPath(deviceID: string): string {
  return `manifests/${encodeURIComponent(deviceID)}.json`;
}

function packPath(packID: string): string {
  const shard = syncChecksum(packID).slice(0, 2);
  return `packs/${shard}/${encodeURIComponent(packID)}.json`;
}

function emptyManifest(
  deviceID: string,
  now: number,
): SyncManifestDocument {
  return {
    schema: SYNC_MANIFEST_SCHEMA,
    deviceID,
    updatedAt: now,
    packs: {},
  };
}

function parseManifest(
  remote: RemoteObject | undefined,
  expectedDeviceID: string,
  now: number,
): SyncManifestDocument {
  if (!remote) { return emptyManifest(expectedDeviceID, now); }
  const manifest = JSON.parse(remote.body) as SyncManifestDocument;
  if (
    manifest?.schema !== SYNC_MANIFEST_SCHEMA ||
    manifest.deviceID !== expectedDeviceID ||
    !manifest.packs ||
    typeof manifest.packs !== "object"
  ) {
    throw new Error(`Unsupported sync manifest: ${expectedDeviceID}`);
  }
  for (const [packID, descriptor] of Object.entries(manifest.packs)) {
    if (
      descriptor?.id !== packID ||
      !/^pack_[a-z0-9-]+$/i.test(packID) ||
      !/^packs\/[a-z0-9]+\/[^/]+\.json$/i.test(descriptor.path) ||
      descriptor.path.includes("..") ||
      typeof descriptor.checksum !== "string" ||
      typeof descriptor.createdAt !== "number" ||
      typeof descriptor.documentCount !== "number"
    ) {
      throw new Error(`Invalid sync pack descriptor: ${packID}`);
    }
  }
  return manifest;
}

function parsePack(remote: RemoteObject, descriptor: SyncPackDescriptor):
SyncPackDocument {
  const pack = JSON.parse(remote.body) as SyncPackDocument;
  if (
    pack?.schema !== SYNC_PACK_SCHEMA ||
    pack.id !== descriptor.id ||
    !Array.isArray(pack.documents) ||
    pack.documents.length !== descriptor.documentCount ||
    syncChecksum(pack.documents) !== descriptor.checksum
  ) {
    throw new Error(`Unsupported or corrupt sync pack: ${descriptor.id}`);
  }
  return {
    ...pack,
    documents: pack.documents.map((document) =>
      parseSyncDocument(stableJSONString(document))),
  };
}

function namespaceOrder(document: SyncDocument): number {
  const order = NAMESPACE_ORDER.indexOf(document.namespace);
  return order < 0 ? NAMESPACE_ORDER.length : order;
}

function sortDocuments(documents: SyncDocument[]): SyncDocument[] {
  return [...documents].sort((left, right) =>
    namespaceOrder(left) - namespaceOrder(right) ||
    syncObjectKey(left.namespace, left.id).localeCompare(
      syncObjectKey(right.namespace, right.id),
    ));
}

function emptyCheckpoint(): SyncCheckpoint {
  return {
    schema: SYNC_CHECKPOINT_SCHEMA,
    appliedPackIDs: [],
    exportedChecksums: {},
  };
}

export class SyncEngine {
  private readonly namespaces = new Map<
    SyncNamespaceName,
    SyncNamespace
  >();
  private readonly now: () => number;
  private readonly maxDocumentsPerPack: number;
  private readonly maxPackBytes: number;
  private readonly maxPacksPerRun: number;
  private readonly maxRetries: number;

  public constructor(
    private readonly backend: SyncBackend,
    private readonly local: SyncLocalStore,
    private readonly checkpoints: SyncCheckpointStore,
    namespaces: SyncNamespace[],
    private readonly options: SyncEngineOptions,
  ) {
    for (const namespace of namespaces) {
      this.namespaces.set(namespace.name, namespace);
    }
    this.now = options.now || (() => Date.now());
    this.maxDocumentsPerPack = Math.max(
      1,
      options.maxDocumentsPerPack || DEFAULT_MAX_DOCUMENTS_PER_PACK,
    );
    this.maxPackBytes = Math.max(
      1024,
      options.maxPackBytes || DEFAULT_MAX_PACK_BYTES,
    );
    this.maxPacksPerRun = Math.max(
      1,
      options.maxPacksPerRun || DEFAULT_MAX_PACKS_PER_RUN,
    );
    this.maxRetries = Math.max(1, options.maxRetries || 3);
  }

  public async sync(): Promise<SyncRunResult> {
    await this.backend.connect();
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await this.syncAttempt();
      } catch (error) {
        lastError = error;
        if ((error as any)?.status !== 412) { throw error; }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Sync conflict retry limit reached");
  }

  private async syncAttempt(): Promise<SyncRunResult> {
    const checkpoint = await this.loadCheckpoint();
    const applied = new Set(checkpoint.appliedPackIDs);
    const result: SyncRunResult = {
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      unchanged: 0,
      packsUploaded: 0,
      packsDownloaded: 0,
      remaining: 0,
    };

    const manifests = await this.loadRemoteManifests();
    const descriptors = [...new Map(
      manifests
        .flatMap(({ manifest }) => Object.values(manifest.packs))
        .sort((left, right) =>
          left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map((descriptor) => [descriptor.id, descriptor]),
    ).values()];
    const pendingDownloads = descriptors.filter(
      (descriptor) => !applied.has(descriptor.id),
    );
    const downloadBatch = pendingDownloads.slice(0, this.maxPacksPerRun);
    for (const descriptor of downloadBatch) {
      const remote = await this.backend.get(descriptor.path);
      if (!remote) {
        throw new Error(`Sync pack is missing: ${descriptor.id}`);
      }
      const pack = parsePack(remote, descriptor);
      await this.applyPack(pack, checkpoint, result);
      applied.add(pack.id);
      checkpoint.appliedPackIDs = [...applied].sort();
      await this.checkpoints.save(checkpoint);
      result.packsDownloaded += 1;
    }

    if (pendingDownloads.length > downloadBatch.length) {
      result.remaining += pendingDownloads.length - downloadBatch.length;
      return result;
    }

    const localDocuments = sortDocuments(await this.local.list());
    const dirty = localDocuments.filter((document) =>
      checkpoint.exportedChecksums[
        syncObjectKey(document.namespace, document.id)
      ] !== syncDocumentChecksum(document));
    const chunks = this.packChunks(dirty);
    const uploadBatch = chunks.slice(0, this.maxPacksPerRun);
    if (uploadBatch.length) {
      const own = manifests.find(
        ({ manifest }) => manifest.deviceID === this.options.deviceID,
      );
      const manifest = own?.manifest ||
        emptyManifest(this.options.deviceID, this.now());
      for (const documents of uploadBatch) {
        const pack = this.createPack(documents);
        const descriptor = await this.uploadPack(pack);
        manifest.packs[pack.id] = descriptor;
        for (const document of documents) {
          checkpoint.exportedChecksums[
            syncObjectKey(document.namespace, document.id)
          ] = syncDocumentChecksum(document);
          result.uploaded += 1;
        }
        checkpoint.appliedPackIDs = [...new Set([
          ...checkpoint.appliedPackIDs,
          pack.id,
        ])].sort();
        result.packsUploaded += 1;
      }
      manifest.updatedAt = this.now();
      await this.backend.put(
        manifestPath(this.options.deviceID),
        stableJSONString(manifest),
        own?.remote.revision
          ? { ifMatch: own.remote.revision }
          : { ifNoneMatch: true },
      );
      await this.checkpoints.save(checkpoint);
    }
    if (chunks.length > uploadBatch.length) {
      result.remaining += chunks.length - uploadBatch.length;
    }
    return result;
  }

  private async loadRemoteManifests(): Promise<Array<{
    manifest: SyncManifestDocument;
    remote: RemoteObject;
  }>> {
    const entries = await this.backend.list("manifests");
    const manifests: Array<{
      manifest: SyncManifestDocument;
      remote: RemoteObject;
    }> = [];
    for (const entry of entries) {
      if (entry.collection || !entry.key.endsWith(".json")) { continue; }
      const deviceID = decodeURIComponent(entry.key.slice(0, -".json".length));
      const remote = await this.backend.get(`manifests/${entry.key}`);
      if (!remote) { continue; }
      manifests.push({
        manifest: parseManifest(remote, deviceID, this.now()),
        remote,
      });
    }
    return manifests;
  }

  private async applyPack(
    pack: SyncPackDocument,
    checkpoint: SyncCheckpoint,
    result: SyncRunResult,
  ): Promise<void> {
    for (const remoteDocument of sortDocuments(pack.documents)) {
      const namespace = this.namespace(remoteDocument.namespace);
      const remote = namespace.migrate(remoteDocument);
      const local = await this.local.get(remote.namespace, remote.id);
      if (!local) {
        await this.local.put(remote);
        checkpoint.exportedChecksums[
          syncObjectKey(remote.namespace, remote.id)
        ] = syncDocumentChecksum(remote);
        result.downloaded += 1;
        continue;
      }
      const validLocal = namespace.validate(local);
      if (syncDocumentChecksum(validLocal) === syncDocumentChecksum(remote)) {
        checkpoint.exportedChecksums[
          syncObjectKey(remote.namespace, remote.id)
        ] = syncDocumentChecksum(remote);
        result.unchanged += 1;
        continue;
      }
      const merged = namespace.merge(validLocal, remote, {
        deviceID: this.options.deviceID,
        now: this.now(),
      });
      await this.local.put(merged);
      if (syncDocumentChecksum(merged) === syncDocumentChecksum(remote)) {
        checkpoint.exportedChecksums[
          syncObjectKey(remote.namespace, remote.id)
        ] = syncDocumentChecksum(remote);
      }
      result.merged += 1;
    }
  }

  private packChunks(documents: SyncDocument[]): SyncDocument[][] {
    const chunks: SyncDocument[][] = [];
    let current: SyncDocument[] = [];
    let bytes = 2;
    for (const document of documents) {
      const size = stableJSONString(document).length + 1;
      if (
        current.length &&
        (current.length >= this.maxDocumentsPerPack ||
          bytes + size > this.maxPackBytes)
      ) {
        chunks.push(current);
        current = [];
        bytes = 2;
      }
      current.push(document);
      bytes += size;
    }
    if (current.length) { chunks.push(current); }
    return chunks;
  }

  private createPack(documents: SyncDocument[]): SyncPackDocument {
    const checksum = syncChecksum(documents);
    return {
      schema: SYNC_PACK_SCHEMA,
      id: `pack_${checksum}`,
      deviceID: this.options.deviceID,
      createdAt: this.now(),
      documents,
    };
  }

  private async uploadPack(
    pack: SyncPackDocument,
  ): Promise<SyncPackDescriptor> {
    const path = packPath(pack.id);
    const checksum = syncChecksum(pack.documents);
    try {
      await this.backend.put(
        path,
        stableJSONString(pack),
        { ifNoneMatch: true },
      );
    } catch (error) {
      if ((error as any)?.status !== 412) { throw error; }
      const existing = await this.backend.get(path);
      if (!existing || parsePack(existing, {
        id: pack.id,
        path,
        checksum,
        createdAt: pack.createdAt,
        documentCount: pack.documents.length,
      }).id !== pack.id) {
        throw error;
      }
    }
    return {
      id: pack.id,
      path,
      checksum,
      createdAt: pack.createdAt,
      documentCount: pack.documents.length,
    };
  }

  private namespace(name: SyncNamespaceName): SyncNamespace {
    const namespace = this.namespaces.get(name);
    if (!namespace) {
      throw new Error(`No sync namespace registered for ${name}`);
    }
    return namespace;
  }

  private async loadCheckpoint(): Promise<SyncCheckpoint> {
    const checkpoint = await this.checkpoints.load();
    if (
      checkpoint?.schema !== SYNC_CHECKPOINT_SCHEMA ||
      !Array.isArray(checkpoint.appliedPackIDs) ||
      !checkpoint.exportedChecksums ||
      typeof checkpoint.exportedChecksums !== "object"
    ) {
      return emptyCheckpoint();
    }
    return checkpoint;
  }
}
