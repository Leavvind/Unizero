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
function bindRuntimeSettings(doc: Document): void {
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
}

export function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = { window: _window };
  } else {
    addon.data.prefs.window = _window;
  }

  try {
    bindRuntimeSettings(addon.data.prefs!.window.document);
  } catch (error) {
    // A wiring failure should disable only these two groups, not take down the
    // whole settings pane.
    Zotero.logError(error as Error);
  }
}
