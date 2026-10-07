import { config } from "../../package.json";

const PREFIX = `${config.addonRef}.sync.webdav.`;

export type SyncNotificationMode = "errors" | "all" | "none";

export interface WebDAVSyncSettings {
  baseURL: string;
  username: string;
  remoteRoot: string;
  deviceID: string;
  rememberPassword: boolean;
  autoSync: boolean;
  intervalMinutes: number;
  notificationMode: SyncNotificationMode;
  lastAttemptAt: number;
  lastSuccessAt: number;
  lastError: string;
}

export const WEBDAV_SYNC_DEFAULTS: Omit<
  WebDAVSyncSettings,
  "deviceID" | "lastAttemptAt" | "lastSuccessAt" | "lastError"
> = {
  baseURL: "https://dav.jianguoyun.com/dav/",
  username: "",
  remoteRoot: "Unizero/v1",
  rememberPassword: true,
  autoSync: false,
  intervalMinutes: 30,
  notificationMode: "errors",
};

function randomDeviceID(): string {
  const values = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return `device_${Array.from(
      values,
      (value) => value.toString(16).padStart(2, "0"),
    ).join("")}`;
  }
  const fallback = (Zotero.Utilities as any)?.randomString?.(32);
  if (!fallback) { throw new Error("A secure device ID generator is unavailable"); }
  return `device_${String(fallback).toLowerCase()}`;
}

function readString(name: keyof WebDAVSyncSettings): string {
  return String(Zotero.Prefs.get(PREFIX + name, true) || "").trim();
}

function readBoolean(name: keyof WebDAVSyncSettings, fallback: boolean): boolean {
  const value = Zotero.Prefs.get(PREFIX + name, true);
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(name: keyof WebDAVSyncSettings, fallback = 0): number {
  const value = Number(Zotero.Prefs.get(PREFIX + name, true));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getWebDAVSyncSettings(): WebDAVSyncSettings {
  let deviceID = readString("deviceID");
  if (!deviceID) {
    deviceID = randomDeviceID();
    Zotero.Prefs.set(PREFIX + "deviceID", deviceID, true);
  }
  const interval = readNumber(
    "intervalMinutes",
    WEBDAV_SYNC_DEFAULTS.intervalMinutes,
  );
  const notification = readString("notificationMode");
  return {
    baseURL: readString("baseURL") || WEBDAV_SYNC_DEFAULTS.baseURL,
    username: readString("username"),
    remoteRoot: readString("remoteRoot") || WEBDAV_SYNC_DEFAULTS.remoteRoot,
    deviceID,
    rememberPassword: readBoolean(
      "rememberPassword",
      WEBDAV_SYNC_DEFAULTS.rememberPassword,
    ),
    autoSync: readBoolean("autoSync", WEBDAV_SYNC_DEFAULTS.autoSync),
    intervalMinutes: Math.max(30, Math.round(interval)),
    notificationMode:
      notification === "all" || notification === "none"
        ? notification
        : WEBDAV_SYNC_DEFAULTS.notificationMode,
    lastAttemptAt: readNumber("lastAttemptAt"),
    lastSuccessAt: readNumber("lastSuccessAt"),
    lastError: readString("lastError"),
  };
}

export function setWebDAVSyncSetting<K extends keyof WebDAVSyncSettings>(
  name: K,
  value: WebDAVSyncSettings[K],
): void {
  const normalized = typeof value === "string" ? value.trim() : value;
  Zotero.Prefs.set(PREFIX + name, normalized, true);
}

export function recordWebDAVSyncStarted(now = Date.now()): void {
  setWebDAVSyncSetting("lastAttemptAt", now);
}

export function recordWebDAVSyncSucceeded(now = Date.now()): void {
  setWebDAVSyncSetting("lastSuccessAt", now);
  setWebDAVSyncSetting("lastError", "");
}

export function recordWebDAVSyncFailed(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setWebDAVSyncSetting("lastError", message.slice(0, 500));
}
