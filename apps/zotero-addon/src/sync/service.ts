import { SyncEngine } from "./engine";
import { syncChecksum } from "./documents";
import {
  PROJECT_SYNC_NAMESPACES,
  ProjectSyncLocalStore,
} from "./projectStore";
import {
  getWebDAVSyncSettings,
  recordWebDAVSyncFailed,
  recordWebDAVSyncStarted,
  recordWebDAVSyncSucceeded,
} from "./settings";
import { defaultSyncCheckpointStore } from "./stateStore";
import type { SyncRunResult } from "./types";
import { WebDAVBackend } from "./webdavBackend";

interface ActiveSync {
  targetKey: string;
  promise: Promise<SyncRunResult>;
}

let activeSync: ActiveSync | undefined;

/**
 * Project sync entry point shared by manual and scheduled runs. The password is
 * supplied by the caller and never enters preferences, diagnostics, checkpoints,
 * manifests, or packs.
 */
export function syncProjectsWithWebDAV(
  applicationPassword: string,
): Promise<SyncRunResult> {
  const settings = getWebDAVSyncSettings();
  const password = String(applicationPassword || "").trim();
  if (!settings.username) {
    return Promise.reject(new Error("A WebDAV username is required"));
  }
  if (!password) {
    return Promise.reject(
      new Error("A WebDAV application password is required"),
    );
  }
  const targetKey = syncChecksum({
    baseURL: settings.baseURL,
    username: settings.username,
    remoteRoot: settings.remoteRoot,
  });
  if (activeSync) {
    if (activeSync.targetKey === targetKey) { return activeSync.promise; }
    return Promise.reject(
      new Error("Another WebDAV target is already syncing"),
    );
  }
  const backend = new WebDAVBackend({
    baseURL: settings.baseURL,
    username: settings.username,
    password,
    remoteRoot: settings.remoteRoot,
  });
  const engine = new SyncEngine(
    backend,
    new ProjectSyncLocalStore(settings.deviceID),
    defaultSyncCheckpointStore(syncChecksum({
      baseURL: settings.baseURL,
      username: settings.username.toLocaleLowerCase(),
      remoteRoot: settings.remoteRoot,
    })),
    PROJECT_SYNC_NAMESPACES,
    {
      deviceID: settings.deviceID,
      maxDocumentsPerPack: 256,
      maxPackBytes: 1_000_000,
      maxPacksPerRun: 4,
      maxRetries: 3,
    },
  );
  recordWebDAVSyncStarted();
  const run = engine.sync()
    .then((result) => {
      recordWebDAVSyncSucceeded();
      return result;
    })
    .catch((error) => {
      recordWebDAVSyncFailed(error);
      throw error;
    })
    .finally(() => {
      if (activeSync?.promise === run) { activeSync = undefined; }
    });
  activeSync = { targetKey, promise: run };
  return run;
}
