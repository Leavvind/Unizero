/**
 * The UniZero pane inside Zotero's settings.
 *
 * The pane holds two kinds of settings, read and written differently:
 *
 * - **The reference-relations groups** use XUL's declarative `preference=`
 *   binding, and Zotero handles reading, writing, and taking effect immediately.
 * - **The local-service and conversion groups** are wired up by hand here, through
 *   `getRuntimePref` / `setRuntimePref`.
 *
 * The latter avoid declarative binding not for the sake of complexity: those keys
 * already have typed accessors (port is an integer, the rest are booleans and
 * strings), and the panel has always written through them. Adding a declarative
 * write path would give the same keys two entry points, bypass the RuntimeSettings
 * types, and leave us hoping XUL's type coercion happens to agree with the types
 * declared in Prefs.
 */

import { config } from "../../package.json";
import { runtimeClient } from "../runtime-client/client";
import {
  getRuntimePref,
  servicePort,
  setRuntimePref,
  type RuntimeSettings,
} from "../runtime-client/settings";
import {
  getConversionPref,
  setConversionPref,
  type ConversionSettings,
} from "../features/conversion/settings";
import {
  getWebDAVSyncSettings,
  setWebDAVSyncSetting,
} from "../sync/settings";
import {
  getWebDAVPassword,
  removeWebDAVPassword,
  saveWebDAVPassword,
} from "../sync/credentials";
import { webDAVSyncScheduler } from "../sync/scheduler";
import { syncProjectsWithWebDAV } from "../sync/service";

export async function registerPrefs(): Promise<void> {
  const prefOptions = {
    pluginID: config.addonID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: "UniZero",
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  };
  await (Zotero as any).PreferencePanes.register(prefOptions);
}

/** Element ids all carry the addonRef prefix in the XHTML; add it in one place. */
function element(doc: Document, suffix: string): any {
  return doc.getElementById(`${config.addonRef}-${suffix}`);
}

const RUNTIME_TEXT_FIELDS: Array<[string, "pythonPath" | "serverScript"]> = [
  ["runtime-python-path", "pythonPath"],
  ["runtime-server-script", "serverScript"],
];

const RUNTIME_CHECKBOXES: Array<[string, "autoStart" | "autoStopOnQuit"]> = [
  ["runtime-auto-start", "autoStart"],
  ["runtime-auto-stop", "autoStopOnQuit"],
];

const CONVERSION_CHECKBOXES: Array<[string, "mdSnapshot"]> = [
  ["conversion-md-snapshot", "mdSnapshot"],
];

const CONVERSION_TEXT_FIELDS: Array<[string, "obsidianVault"]> = [
  ["conversion-obsidian-vault", "obsidianVault"],
];

/**
 * Push a changed port to the running runtime.
 *
 * When the add-on starts the service itself the port comes from the command line
 * and `config.json` plays no part — but for a user running
 * `python -m unizero_runtime` by hand, config.json is the authority. Without this
 * sync a manually started service keeps listening on the old port while the add-on
 * knocks on the new one, and the symptom is a plainly alive service that never
 * passes a health check.
 *
 * Failure is not reported: a stopped service is normal rather than exceptional,
 * and the new port is already in prefs, so the next start is correct regardless.
 */
function syncPortToRuntime(currentPort: number, nextPort: number): void {
  // Contact the service on the port it is listening on now. serviceURL() already
  // points at nextPort by the time this asynchronous request starts.
  runtimeClient.saveConfigAtPort(currentPort, { port: nextPort }).catch((error) => {
    ztoolkit.log(`runtime port not synced, service likely offline: ${error}`);
  });
}

/**
 * Changes take effect immediately, with no Save button — consistent with the
 * declaratively bound settings in the same pane. A pane where half the settings
 * apply on change and the other half need saving is worse than one extra click.
 */
async function bindRuntimeSettings(doc: Document): Promise<void> {
  for (const [id, name] of RUNTIME_TEXT_FIELDS) {
    const input = element(doc, id);
    if (!input) { continue; }
    input.value = getRuntimePref(name) || "";
    input.addEventListener("change", () => {
      setRuntimePref(name, String(input.value).trim());
    });
  }

  const port = element(doc, "runtime-port");
  if (port) {
    port.value = String(servicePort());
    port.addEventListener("change", () => {
      // Empty or junk input falls back to the default port rather than writing
      // NaN into an integer pref.
      const parsed = parseInt(String(port.value), 10);
      const currentPort = servicePort();
      const value = parsed > 0 && parsed <= 65535 ? parsed : currentPort;
      port.value = String(value);
      setRuntimePref("port", value);
      if (value !== currentPort) {
        syncPortToRuntime(currentPort, value);
      }
    });
  }

  for (const [id, name] of RUNTIME_CHECKBOXES) {
    const box = element(doc, id);
    if (!box) { continue; }
    box.checked = !!getRuntimePref(name as keyof RuntimeSettings);
    box.addEventListener("command", () => {
      setRuntimePref(name, !!box.checked);
    });
  }

  for (const [id, name] of CONVERSION_CHECKBOXES) {
    const box = element(doc, id);
    if (!box) { continue; }
    box.checked = !!getConversionPref(name);
    box.addEventListener("command", () => {
      setConversionPref(name, !!box.checked);
    });
  }

  for (const [id, name] of CONVERSION_TEXT_FIELDS) {
    const input = element(doc, id);
    if (!input) { continue; }
    input.value = getConversionPref(name) || "";
    input.addEventListener("change", () => {
      setConversionPref(name, String(input.value).trim());
    });
  }

  await bindWebDAVSync(doc);
}

async function localized(
  doc: Document,
  id: string,
  args: Record<string, unknown> = {},
  fallback: string,
): Promise<string> {
  try {
    return await (doc as any).l10n?.formatValue(id, args) || fallback;
  } catch (_error) {
    return fallback;
  }
}

async function bindWebDAVSync(doc: Document): Promise<void> {
  const url = element(doc, "sync-webdav-url");
  const username = element(doc, "sync-webdav-username");
  const password = element(doc, "sync-webdav-password");
  const remember = element(doc, "sync-remember-password");
  const automatic = element(doc, "sync-auto");
  const interval = element(doc, "sync-interval");
  const notifications = element(doc, "sync-notifications");
  const button = element(doc, "sync-now");
  const status = element(doc, "sync-status");
  if (
    !url || !username || !password || !remember || !automatic ||
    !interval || !notifications || !button || !status
  ) { return; }
  if (button.dataset?.unizeroBound === "true") { return; }
  if (button.dataset) { button.dataset.unizeroBound = "true"; }

  const settings = getWebDAVSyncSettings();
  url.value = settings.baseURL;
  username.value = settings.username;
  remember.checked = settings.rememberPassword;
  automatic.checked = settings.rememberPassword && settings.autoSync;
  automatic.disabled = !settings.rememberPassword;
  if (!settings.rememberPassword && settings.autoSync) {
    setWebDAVSyncSetting("autoSync", false);
  }
  interval.value = String(settings.intervalMinutes);
  notifications.value = settings.notificationMode;
  let credentialLoadGeneration = 0;
  const showLastStatus = async () => {
    const latest = getWebDAVSyncSettings();
    if (latest.lastError && latest.lastAttemptAt > latest.lastSuccessAt) {
      status.textContent = await localized(
        doc,
        "sync-status-last-error",
        { message: latest.lastError },
        `Last sync failed: ${latest.lastError}`,
      );
    } else if (latest.lastSuccessAt) {
      const time = new Date(latest.lastSuccessAt).toLocaleString();
      status.textContent = await localized(
        doc,
        "sync-status-last-success",
        { time },
        `Last synced: ${time}`,
      );
    }
  };
  const loadPassword = async () => {
    const request = ++credentialLoadGeneration;
    if (!remember.checked) {
      password.value = "";
      return;
    }
    const targetURL = String(url.value).trim();
    const targetUsername = String(username.value).trim();
    password.value = "";
    const saved = await getWebDAVPassword(
      targetURL,
      targetUsername,
    );
    if (
      request === credentialLoadGeneration &&
      password.isConnected &&
      remember.checked &&
      String(url.value).trim() === targetURL &&
      String(username.value).trim() === targetUsername
    ) {
      password.value = saved;
    }
  };
  try {
    await loadPassword();
  } catch (error) {
    Zotero.logError(error as Error);
  }
  await showLastStatus();
  password.addEventListener("input", () => {
    // A password typed by the user always wins over an older Login Manager read.
    credentialLoadGeneration += 1;
  });
  url.addEventListener("change", () => {
    setWebDAVSyncSetting("baseURL", String(url.value).trim());
    void loadPassword().catch((error) => Zotero.logError(error as Error));
    webDAVSyncScheduler.reconfigure();
  });
  username.addEventListener("change", () => {
    setWebDAVSyncSetting("username", String(username.value).trim());
    void loadPassword().catch((error) => Zotero.logError(error as Error));
    webDAVSyncScheduler.reconfigure();
  });
  remember.addEventListener("command", () => {
    const enabled = !!remember.checked;
    setWebDAVSyncSetting("rememberPassword", enabled);
    automatic.disabled = !enabled;
    if (!enabled) {
      automatic.checked = false;
      setWebDAVSyncSetting("autoSync", false);
      void removeWebDAVPassword(
        String(url.value).trim(),
        String(username.value).trim(),
      ).catch((error) => Zotero.logError(error as Error));
    } else {
      void loadPassword().catch((error) => Zotero.logError(error as Error));
    }
    webDAVSyncScheduler.reconfigure();
  });
  automatic.addEventListener("command", () => {
    setWebDAVSyncSetting("autoSync", !!automatic.checked);
    webDAVSyncScheduler.reconfigure();
  });
  interval.addEventListener("change", () => {
    const minutes = Math.max(30, Number(interval.value) || 30);
    interval.value = String(minutes);
    setWebDAVSyncSetting("intervalMinutes", minutes);
    webDAVSyncScheduler.reconfigure();
  });
  notifications.addEventListener("change", () => {
    const value = String(notifications.value);
    setWebDAVSyncSetting(
      "notificationMode",
      value === "all" || value === "none" ? value : "errors",
    );
  });
  button.addEventListener("click", async () => {
    const targetURL = String(url.value).trim();
    const targetUsername = String(username.value).trim();
    const enteredPassword = String(password.value);
    const shouldRemember = !!remember.checked;
    setWebDAVSyncSetting("baseURL", targetURL);
    setWebDAVSyncSetting("username", targetUsername);
    button.disabled = true;
    for (const control of [url, username, password, remember]) {
      control.disabled = true;
    }
    status.textContent = await localized(
      doc,
      "sync-status-running",
      {},
      "Syncing…",
    );
    try {
      const result = await syncProjectsWithWebDAV(enteredPassword);
      let credentialWarning = "";
      try {
        if (shouldRemember) {
          await saveWebDAVPassword(
            targetURL,
            targetUsername,
            enteredPassword,
          );
        } else {
          await removeWebDAVPassword(
            targetURL,
            targetUsername,
          );
        }
      } catch (error) {
        Zotero.logError(error as Error);
        credentialWarning = await localized(
          doc,
          "sync-status-password-save-error",
          {},
          "Sync completed, but the application password could not be saved.",
        );
      }
      const done = await localized(
        doc,
        "sync-status-done",
        result as unknown as Record<string, unknown>,
        `Done: ${result.uploaded} uploaded, ${result.downloaded} downloaded, ` +
          `${result.merged} merged, ${result.remaining} batches remaining`,
      );
      status.textContent = credentialWarning
        ? `${done} ${credentialWarning}`
        : done;
      webDAVSyncScheduler.reconfigure();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = await localized(
        doc,
        "sync-status-error",
        { message },
        `Sync failed: ${message}`,
      );
    } finally {
      button.disabled = false;
      for (const control of [url, username, password, remember]) {
        control.disabled = false;
      }
      automatic.disabled = !remember.checked;
    }
  });
}

export async function registerPrefsScripts(_window: Window): Promise<void> {
  if (!addon.data.prefs) {
    addon.data.prefs = { window: _window };
  } else {
    addon.data.prefs.window = _window;
  }

  try {
    await bindRuntimeSettings(addon.data.prefs!.window.document);
  } catch (error) {
    // A wiring failure should disable only these groups, not take down the
    // whole settings pane.
    Zotero.logError(error as Error);
  }
}
