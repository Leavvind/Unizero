const {
  settings,
  getPassword,
  sync,
  showError,
  showSuccess,
} = vi.hoisted(() => ({
  settings: {
    baseURL: "https://dav.example.test/dav/",
    username: "person@example.test",
    remoteRoot: "Unizero/v1",
    deviceID: "device_test",
    rememberPassword: true,
    autoSync: true,
    intervalMinutes: 30,
    notificationMode: "errors" as "errors" | "all" | "none",
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    lastError: "",
  },
  getPassword: vi.fn(async () => "app-password"),
  sync: vi.fn(async () => ({
    uploaded: 1,
    downloaded: 0,
    merged: 0,
    remaining: 0,
  })),
  showError: vi.fn(),
  showSuccess: vi.fn(),
}));

vi.mock("../src/sync/settings", () => ({
  getWebDAVSyncSettings: () => ({ ...settings }),
}));
vi.mock("../src/sync/credentials", () => ({
  getWebDAVPassword: getPassword,
}));
vi.mock("../src/sync/service", () => ({
  syncProjectsWithWebDAV: sync,
}));
vi.mock("../src/ui/progress", () => ({
  showError,
  showSuccess,
}));

import { WebDAVSyncScheduler } from "../src/sync/scheduler";

describe("WebDAVSyncScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
    settings.autoSync = true;
    settings.intervalMinutes = 30;
    settings.notificationMode = "errors";
    settings.lastAttemptAt = 0;
    getPassword.mockReset();
    getPassword.mockResolvedValue("app-password");
    sync.mockClear();
    showError.mockClear();
    showSuccess.mockClear();
    (globalThis as any).Services = { io: { offline: false } };
    (globalThis as any).Zotero.logError = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits after startup, runs once, then schedules from completion", async () => {
    const scheduler = new WebDAVSyncScheduler();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(sync).toHaveBeenCalledTimes(1);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry every second when a saved password is missing", async () => {
    getPassword.mockResolvedValue("");
    const scheduler = new WebDAVSyncScheduler();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(getPassword).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("stays silent on success unless all-result notifications are selected", async () => {
    settings.notificationMode = "all";
    const scheduler = new WebDAVSyncScheduler();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(showSuccess).toHaveBeenCalledWith(
      "WebDAV sync complete: 1 uploaded, 0 downloaded",
    );
    scheduler.stop();
  });

  it("continues a batched run promptly instead of after a full interval", async () => {
    settings.notificationMode = "all";
    sync.mockResolvedValueOnce({
      uploaded: 4,
      downloaded: 0,
      merged: 0,
      remaining: 3,
    });
    const scheduler = new WebDAVSyncScheduler();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(1);
    // Mid-transfer: not announced as a completed sync.
    expect(showSuccess).not.toHaveBeenCalled();

    // The continuation must not wait out the 30-minute interval.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(showSuccess).toHaveBeenCalledTimes(1);

    // Once nothing remains, the normal interval applies again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
