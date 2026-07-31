const {
  settings,
  engineSync,
  recordStarted,
  recordSucceeded,
  recordFailed,
} = vi.hoisted(() => ({
  settings: {
    baseURL: "https://dav-a.example.test/dav/",
    username: "person-a@example.test",
    remoteRoot: "Unizero/v1",
    deviceID: "device_test",
  },
  engineSync: vi.fn<() => Promise<any>>(),
  recordStarted: vi.fn(),
  recordSucceeded: vi.fn(),
  recordFailed: vi.fn(),
}));

vi.mock("../src/sync/engine", () => ({
  SyncEngine: class {
    sync() {
      return engineSync();
    }
  },
}));
vi.mock("../src/sync/projectStore", () => ({
  PROJECT_SYNC_NAMESPACES: [],
  ProjectSyncLocalStore: class {},
}));
vi.mock("../src/sync/stateStore", () => ({
  defaultSyncCheckpointStore: vi.fn(() => ({})),
}));
vi.mock("../src/sync/settings", () => ({
  getWebDAVSyncSettings: () => ({ ...settings }),
  recordWebDAVSyncStarted: recordStarted,
  recordWebDAVSyncSucceeded: recordSucceeded,
  recordWebDAVSyncFailed: recordFailed,
}));
vi.mock("../src/sync/webdavBackend", () => ({
  WebDAVBackend: class {},
}));

import { syncProjectsWithWebDAV } from "../src/sync/service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("WebDAV sync service", () => {
  it("deduplicates one target but rejects a different target while it is active", async () => {
    const pending = deferred<any>();
    engineSync.mockReturnValueOnce(pending.promise);
    const first = syncProjectsWithWebDAV("app-password-a");
    const duplicate = syncProjectsWithWebDAV("app-password-a");
    expect(duplicate).toBe(first);
    expect(engineSync).toHaveBeenCalledTimes(1);

    settings.baseURL = "https://dav-b.example.test/dav/";
    settings.username = "person-b@example.test";
    await expect(syncProjectsWithWebDAV("app-password-b"))
      .rejects.toThrow("Another WebDAV target is already syncing");

    pending.resolve({
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      unchanged: 0,
      packsUploaded: 0,
      packsDownloaded: 0,
      remaining: 0,
    });
    await first;
    expect(recordSucceeded).toHaveBeenCalledTimes(1);
  });
});
