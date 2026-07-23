import { config } from "../package.json";
import { registerPrefsScripts, registerPrefs } from "./modules/prefs";
import { migrateLegacyPrefs } from "./modules/migrate";
import Views from "./modules/views";
import MetadataEnrichment from "./modules/metadataEnrichment";

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

  // 必须早于任何 Prefs.get：面板一旦读到默认值就已经晚了。
  migrateLegacyPrefs();

  // Register the visible section first. Optional preference modules
  // must not be able to prevent the main UI from appearing.
  if (!Zotero[config.addonInstance]?.views) {
    const views = new Views();
    await views.onInit();
    Zotero[config.addonInstance].views = views;

    try {
      registerPrefs();
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }

  addon.data.metadataEnrichment ||= new MetadataEnrichment();
  addon.data.metadataEnrichment.register(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  addon.data.metadataEnrichment?.unregister(win);
  Zotero[config.addonInstance]?.views?.onDestroy?.();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}


function onShutdown(): void {
  addon.data.metadataEnrichment?.unregisterAll();
  Zotero[config.addonInstance]?.views?.onDestroy?.();
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
  onShutdown,
  onPrefsEvent,
  onMainWindowLoad,
  onMainWindowUnload
};
