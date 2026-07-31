import { showError, showSuccess } from "../ui/progress";
import { getWebDAVPassword } from "./credentials";
import { syncProjectsWithWebDAV } from "./service";
import { getWebDAVSyncSettings } from "./settings";

const STARTUP_DELAY_MS = 60_000;
const MINUTE_MS = 60_000;

/**
 * One process-wide scheduler. It uses a completion-based timeout rather than an
 * interval, so a slow run can never overlap the next run. The sync service also
 * deduplicates a simultaneous manual request.
 */
export class WebDAVSyncScheduler {
  private timer?: number;
  private started = false;
  private lastNotice = "";

  public start(): void {
    if (this.started) { return; }
    this.started = true;
    this.schedule(true);
  }

  public stop(): void {
    this.started = false;
    this.clearTimer();
  }

  /** Apply a preference change or reset the clock after a manual sync. */
  public reconfigure(): void {
    if (!this.started) { return; }
    this.clearTimer();
    this.schedule(false);
  }

  private schedule(starting: boolean, fromNow = false): void {
    if (!this.started) { return; }
    const settings = getWebDAVSyncSettings();
    if (!settings.autoSync) { return; }
    const interval = settings.intervalMinutes * MINUTE_MS;
    const dueAt = fromNow
      ? Date.now() + interval
      : settings.lastAttemptAt
      ? settings.lastAttemptAt + interval
      : Date.now();
    const delay = Math.max(
      starting ? STARTUP_DELAY_MS : 1000,
      dueAt - Date.now(),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, delay) as unknown as number;
  }

  private async run(): Promise<void> {
    if (!this.started) { return; }
    const settings = getWebDAVSyncSettings();
    if (!settings.autoSync) { return; }
    if ((Services as any).io?.offline) {
      this.schedule(false, true);
      return;
    }
    try {
      const password = await getWebDAVPassword(
        settings.baseURL,
        settings.username,
      );
      if (!password) {
        throw new Error(
          "Automatic WebDAV sync needs a saved application password",
        );
      }
      const result = await syncProjectsWithWebDAV(password);
      this.lastNotice = "";
      if (settings.notificationMode === "all") {
        showSuccess(
          `WebDAV sync complete: ${result.uploaded} uploaded, ` +
            `${result.downloaded} downloaded`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Zotero.logError(error as Error);
      if (
        settings.notificationMode !== "none" &&
        message !== this.lastNotice
      ) {
        showError(`Background WebDAV sync failed: ${message}`);
        this.lastNotice = message;
      }
    } finally {
      this.schedule(false, true);
    }
  }

  private clearTimer(): void {
    if (this.timer === undefined) { return; }
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export const webDAVSyncScheduler = new WebDAVSyncScheduler();
