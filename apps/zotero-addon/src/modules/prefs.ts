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
import { health } from "../runtime-client/process";
import {
  getRuntimePref,
  servicePort,
  setRuntimePref,
  type RuntimeSettings,
} from "../runtime-client/settings";
import {
  defaultTemplateId,
  getConversionPref,
  setConversionPref,
  TEMPLATE_ID,
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

  await bindDefaultTemplate(doc);
}

/**
 * The default-template dropdown. Templates live in the runtime, so the list comes
 * from a service that is already running; opening the settings never starts it
 * (the same rule as the item menu). The saved choice is always listed, so the
 * pane shows and keeps it while the service is stopped.
 *
 * A XUL menulist, not `html:select`: this pane lives in a chrome window, where an
 * HTML select's popup does not open.
 */
async function bindDefaultTemplate(doc: Document): Promise<void> {
  const menulist = element(doc, "conversion-default-template");
  const popup = menulist?.querySelector("menupopup");
  if (!menulist || !popup) { return; }
  const saved = defaultTemplateId();

  let listed: Array<{ id: string; name?: string }> = [];
  try {
    if (await health()) { listed = (await runtimeClient.templates()).templates || []; }
  } catch (error) {
    ztoolkit.log(`default-template list unavailable: ${error}`);
  }
  if (!listed.some((template) => template.id === saved)) {
    listed = [{ id: saved }, ...listed];
  }

  popup.textContent = "";
  for (const template of listed) {
    const item = (doc as any).createXULElement("menuitem");
    item.setAttribute("value", template.id);
    item.setAttribute(
      "label",
      template.name ? `${template.name} (${template.id})` : template.id,
    );
    popup.appendChild(item);
  }
  menulist.value = saved;
  menulist.addEventListener("command", () => {
    const value = String(menulist.value || "");
    if (TEMPLATE_ID.test(value)) { setConversionPref("defaultTemplate", value); }
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
