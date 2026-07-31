import {
  latestWriteWinsNamespace,
  syncChecksum,
  syncDocumentChecksum,
} from "../src/sync/documents";
import { SyncEngine } from "../src/sync/engine";
import { PROJECT_SYNC_NAMESPACES } from "../src/sync/projectStore";
import {
  SYNC_DOCUMENT_SCHEMA,
  SYNC_CHECKPOINT_SCHEMA,
  type RemoteEntry,
  type RemoteObject,
  type SyncBackend,
  type SyncCheckpoint,
  type SyncCheckpointStore,
  type SyncDocument,
  type SyncLocalStore,
  type SyncNamespaceName,
  type WriteCondition,
  syncObjectKey,
} from "../src/sync/types";

class MemoryBackend implements SyncBackend {
  public files = new Map<string, { body: string; revision: number }>();
  private revision = 0;

  async connect(): Promise<void> {}
  async list(prefix: string): Promise<RemoteEntry[]> {
    const start = `${prefix}/`;
    return [...this.files.keys()]
      .filter((key) =>
        key.startsWith(start) && !key.slice(start.length).includes("/"))
      .map((key) => ({
        key: key.slice(start.length),
        collection: false,
        revision: String(this.files.get(key)?.revision),
      }));
  }
  async get(key: string): Promise<RemoteObject | undefined> {
    const file = this.files.get(key);
    return file
      ? { body: file.body, revision: String(file.revision) }
      : undefined;
  }
  async put(
    key: string,
    body: string,
    condition: WriteCondition = {},
  ): Promise<{ revision?: string }> {
    const existing = this.files.get(key);
    if (
      (condition.ifNoneMatch && existing) ||
      (condition.ifMatch && String(existing?.revision) !== condition.ifMatch)
    ) {
      throw Object.assign(new Error("precondition failed"), { status: 412 });
    }
    const revision = ++this.revision;
    this.files.set(key, { body, revision });
    return { revision: String(revision) };
  }
  async remove(key: string): Promise<void> {
    this.files.delete(key);
  }
}

class MemoryCheckpointStore implements SyncCheckpointStore {
  public checkpoint: SyncCheckpoint = {
    schema: SYNC_CHECKPOINT_SCHEMA,
    appliedPackIDs: [],
    exportedChecksums: {},
  };
  async load(): Promise<SyncCheckpoint> {
    return structuredClone(this.checkpoint);
  }
  async save(checkpoint: SyncCheckpoint): Promise<void> {
    this.checkpoint = structuredClone(checkpoint);
  }
}

class MemoryLocalStore implements SyncLocalStore {
  public documents = new Map<string, SyncDocument>();

  async list(): Promise<SyncDocument[]> {
    return [...this.documents.values()];
  }
  async get(
    namespace: SyncNamespaceName,
    id: string,
  ): Promise<SyncDocument | undefined> {
    return this.documents.get(syncObjectKey(namespace, id));
  }
  async put(document: SyncDocument): Promise<void> {
    this.documents.set(
      syncObjectKey(document.namespace, document.id),
      document,
    );
  }
}

function document(
  deviceID: string,
  updatedAt: number,
  title: string,
): SyncDocument<{ title: string }> {
  return {
    syncSchema: SYNC_DOCUMENT_SCHEMA,
    namespace: "project.meta",
    id: "project_1",
    schema: 1,
    scope: { kind: "project", id: "project_1" },
    updatedAt,
    deviceID,
    payload: { title },
  };
}

const projectNamespace = latestWriteWinsNamespace(
  "project.meta",
  1,
  (payload) => {
    if (!payload || typeof (payload as any).title !== "string") {
      throw new Error("invalid project");
    }
    return payload as { title: string };
  },
);

describe("SyncEngine", () => {
  it("uses canonical SHA-256 checksums for pack identity", () => {
    expect(syncChecksum("abc")).toBe(
      "6cc43f858fbb763301637b5af970e2a46" +
      "b46f461f27e5a0f41e009c59b827b25",
    );
  });

  it("does not treat the local wrapper device as document content", () => {
    expect(syncDocumentChecksum(document("device-a", 10, "Project A")))
      .toBe(syncDocumentChecksum(document("device-b", 10, "Project A")));
  });

  it("rejects unsafe storage IDs before importing Project sync payloads", () => {
    const namespace = PROJECT_SYNC_NAMESPACES.find(
      (entry) => entry.name === "project.meta",
    )!;
    expect(() => namespace.validate({
      syncSchema: SYNC_DOCUMENT_SCHEMA,
      namespace: "project.meta",
      id: "../outside",
      schema: 1,
      scope: { kind: "project", id: "../outside" },
      updatedAt: 1,
      deviceID: "device-a",
      payload: {
        schema: 1,
        id: "../outside",
        subject: {
          kind: "collection",
          library: "library",
          collectionKey: "SAFEKEY",
        },
        name: "Unsafe Project",
        defaultBoardID: "board_safe",
        createdAt: 1,
        updatedAt: 1,
      },
    })).toThrow("Invalid project.meta payload");
  });

  it("uploads once and lets another device pull through the remote index", async () => {
    const backend = new MemoryBackend();
    const first = new MemoryLocalStore();
    const firstCheckpoint = new MemoryCheckpointStore();
    await first.put(document("device-a", 10, "Project A"));
    const upload = await new SyncEngine(
      backend,
      first,
      firstCheckpoint,
      [projectNamespace],
      { deviceID: "device-a", now: () => 100 },
    ).sync();

    expect(upload).toMatchObject({
      uploaded: 1,
      packsUploaded: 1,
      remaining: 0,
    });
    expect(backend.files.has("manifests/device-a.json")).toBe(true);
    expect([...backend.files.keys()].some((key) =>
      key.startsWith("packs/"))).toBe(true);

    const second = new MemoryLocalStore();
    const secondCheckpoint = new MemoryCheckpointStore();
    const download = await new SyncEngine(
      backend,
      second,
      secondCheckpoint,
      [projectNamespace],
      { deviceID: "device-b", now: () => 200 },
    ).sync();

    expect(download).toMatchObject({
      downloaded: 1,
      packsDownloaded: 1,
      remaining: 0,
    });
    expect((await second.get("project.meta", "project_1"))?.payload)
      .toEqual({ title: "Project A" });
  });

  it("merges divergent documents deterministically and converges the older device", async () => {
    const backend = new MemoryBackend();
    const first = new MemoryLocalStore();
    const second = new MemoryLocalStore();
    const firstCheckpoint = new MemoryCheckpointStore();
    const secondCheckpoint = new MemoryCheckpointStore();
    await first.put(document("device-a", 10, "Initial"));
    await new SyncEngine(
      backend,
      first,
      firstCheckpoint,
      [projectNamespace],
      { deviceID: "device-a", now: () => 100 },
    ).sync();
    await new SyncEngine(
      backend,
      second,
      secondCheckpoint,
      [projectNamespace],
      { deviceID: "device-b", now: () => 100 },
    ).sync();

    await first.put(document("device-a", 30, "Newer remote"));
    await second.put(document("device-b", 20, "Older local"));
    await new SyncEngine(
      backend,
      first,
      firstCheckpoint,
      [projectNamespace],
      { deviceID: "device-a", now: () => 300 },
    ).sync();
    const merged = await new SyncEngine(
      backend,
      second,
      secondCheckpoint,
      [projectNamespace],
      { deviceID: "device-b", now: () => 301 },
    ).sync();

    expect(merged.merged).toBe(1);
    expect((await second.get("project.meta", "project_1"))?.payload)
      .toEqual({ title: "Newer remote" });
    const stable = await new SyncEngine(
      backend,
      second,
      secondCheckpoint,
      [projectNamespace],
      { deviceID: "device-b", now: () => 400 },
    ).sync();
    expect(stable).toMatchObject({
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      packsUploaded: 0,
      packsDownloaded: 0,
    });
  });

  it("bounds object transfers per run for rate-limited WebDAV accounts", async () => {
    const backend = new MemoryBackend();
    const local = new MemoryLocalStore();
    const checkpoint = new MemoryCheckpointStore();
    for (let index = 0; index < 3; index += 1) {
      const entry = {
        ...document("device-a", index + 1, `Project ${index}`),
        id: `project_${index}`,
        scope: { kind: "project" as const, id: `project_${index}` },
      };
      await local.put(entry);
    }
    const result = await new SyncEngine(
      backend,
      local,
      checkpoint,
      [projectNamespace],
      {
        deviceID: "device-a",
        maxDocumentsPerPack: 2,
        maxPacksPerRun: 1,
      },
    ).sync();

    expect(result.uploaded).toBe(2);
    expect(result.remaining).toBe(1);
  });

  it("packs 200 logical documents into one immutable WebDAV object", async () => {
    const backend = new MemoryBackend();
    const local = new MemoryLocalStore();
    const checkpoint = new MemoryCheckpointStore();
    for (let index = 0; index < 200; index += 1) {
      await local.put({
        ...document("device-a", index + 1, `Project ${index}`),
        id: `project_${index}`,
        scope: { kind: "project", id: `project_${index}` },
      });
    }

    const result = await new SyncEngine(
      backend,
      local,
      checkpoint,
      [projectNamespace],
      {
        deviceID: "device-a",
        maxDocumentsPerPack: 256,
        maxPackBytes: 1_000_000,
      },
    ).sync();

    expect(result).toMatchObject({
      uploaded: 200,
      packsUploaded: 1,
      remaining: 0,
    });
    expect([...backend.files.keys()].filter((key) =>
      key.startsWith("packs/"))).toHaveLength(1);
    expect([...backend.files.keys()].filter((key) =>
      key.startsWith("manifests/"))).toHaveLength(1);
  });
});
