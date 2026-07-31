import { config } from "../../package.json";
import {
  SYNC_CHECKPOINT_SCHEMA,
  type SyncCheckpoint,
  type SyncCheckpointStore,
} from "./types";

function isMissingFile(error: any): boolean {
  return error?.name === "NotFoundError" || error?.name === "NotAllowedError";
}

function defaultDataDirectory(): string {
  const dir = (Zotero as any).DataDirectory?.dir;
  if (typeof dir === "string" && dir) { return dir; }
  return Zotero.getTempDirectory().parent.path;
}

function emptyCheckpoint(): SyncCheckpoint {
  return {
    schema: SYNC_CHECKPOINT_SCHEMA,
    appliedPackIDs: [],
    exportedChecksums: {},
  };
}

export class FileSyncCheckpointStore implements SyncCheckpointStore {
  private writes: Promise<void> = Promise.resolve();

  public constructor(private readonly path: string) {}

  public async load(): Promise<SyncCheckpoint> {
    await this.writes.catch(() => undefined);
    try {
      return JSON.parse(
        await IOUtils.readUTF8(this.path) as string,
      ) as SyncCheckpoint;
    } catch (error) {
      if (isMissingFile(error)) { return emptyCheckpoint(); }
      throw error;
    }
  }

  public async save(checkpoint: SyncCheckpoint): Promise<void> {
    const operation = this.writes
      .catch(() => undefined)
      .then(async () => {
        await IOUtils.makeDirectory(PathUtils.parent(this.path)!, {
          createAncestors: true,
          ignoreExisting: true,
        });
        await IOUtils.writeUTF8(this.path, JSON.stringify(checkpoint), {
          tmpPath: `${this.path}.tmp`,
        });
      });
    this.writes = operation;
    await operation;
  }
}

export function defaultSyncCheckpointStore(
  profileKey: string,
): FileSyncCheckpointStore {
  return new FileSyncCheckpointStore(PathUtils.join(
    defaultDataDirectory(),
    config.addonRef,
    "sync",
    `${profileKey}.json`,
  ));
}

