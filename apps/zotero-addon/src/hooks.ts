import { config } from "../package.json";
import { featureRegistry } from "./core/features";
import { registerPrefsScripts } from "./modules/prefs";
import { migrateLegacyPrefs } from "./modules/migrate";
import { migrateLegacyRuntimePrefs } from "./runtime-client/settings";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  await onMainWindowLoad(window);
}

async function onMainWindowLoad(win: Window): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  // Must run before any Prefs.get: once a pane has read a default value it is
  // already too late.
  migrateLegacyPrefs();
  migrateLegacyRuntimePrefs();

  await featureRegistry.onWindowLoad(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  await featureRegistry.onWindowUnload(win);
}

/** Normal application exit: only external resources need explicit synchronous cleanup. */
function onAppShutdown(): void {
  featureRegistry.onAppShutdown();
}

async function onShutdown(): Promise<void> {
  await featureRegistry.onShutdown();
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  addon.data.dialog?.window?.close();
  delete Zotero[config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintian.

export default {
  onStartup,
  onAppShutdown,
  onShutdown,
  onPrefsEvent,
  onMainWindowLoad,
  onMainWindowUnload
};
