import { config } from "../../package.json";
import MetadataEnrichment from "../modules/metadataEnrichment";
import { registerPrefs } from "../modules/prefs";
import Views from "../modules/views";
import { uniConnectionSync } from "../modules/uniConnectionSync";
import { startInBackground, stopOnShutdown } from "../runtime-client/process";
import { registerBridgeEndpoints, unregisterBridgeEndpoints } from "../server/bridge";
import { noteServiceFailure } from "../ui/notices";
import {
  registerAnnotationMenu,
  registerConversionMenus,
  registerUniConnectionMenu,
  unregisterAnnotationMenu,
  unregisterConversionMenus,
  unregisterUniConnectionMenu,
} from "../ui/menus";
import { closePanel, closePanelForOwner, openPanel } from "../ui/panel";
import { UnizeroHome } from "../ui/unizeroHome";
import { FeatureRegistry, type FeatureModule } from "./featureRegistry";

/** Unizero Home tabs; one owner for every main window. */
let home: UnizeroHome | undefined;

const relations: FeatureModule = {
  id: "literature.relations",
  async onWindowLoad(win) {
    let views = Zotero[config.addonInstance]?.views as Views | undefined;
    if (!views) {
      views = new Views();
      await views.onInit(win);
      Zotero[config.addonInstance].views = views;
      uniConnectionSync.register();
      addon.api.uniConnectionSync = uniConnectionSync;
      try {
        await registerPrefs();
      } catch (error) {
        Zotero.logError(error as Error);
      }
      registerUniConnectionMenu(win, (mainWindow, item) => views!.openFull(mainWindow, item));
      home ||= new UnizeroHome({ openFull: (mainWindow, item) => views!.openFull(mainWindow, item) });
      home.register(win);
      return;
    }
    views.onWindowLoad(win);
    uniConnectionSync.register();
    addon.api.uniConnectionSync = uniConnectionSync;
    registerUniConnectionMenu(win, (mainWindow, item) => views!.openFull(mainWindow, item));
    home ||= new UnizeroHome({ openFull: (mainWindow, item) => views!.openFull(mainWindow, item) });
    home.register(win);
  },
  onWindowUnload(win) {
    home?.unregister(win);
    unregisterUniConnectionMenu(win);
    Zotero[config.addonInstance]?.views?.onWindowUnload?.(win);
  },
  onShutdown() {
    uniConnectionSync.unregister();
    home?.shutdown();
    home = undefined;
    Zotero[config.addonInstance]?.views?.onDestroy?.();
  },
  onAppShutdown() {
    uniConnectionSync.unregister();
  },
};

const metadata: FeatureModule = {
  id: "library.metadata",
  onWindowLoad(win) {
    addon.data.metadataEnrichment ||= new MetadataEnrichment();
    addon.data.metadataEnrichment.register(win);
  },
  onShutdown() {
    addon.data.metadataEnrichment?.unregisterAll();
  },
};

const conversion: FeatureModule = {
  id: "document.convert",
  onWindowLoad(win) {
    registerConversionMenus(win, openPanel);
    // Not awaited: the service takes up to a minute to answer its first health
    // check, and window load must not wait on an optional local process. Failures
    // surface in the panel's Jobs list through noteServiceFailure.
    void startInBackground({ reportError: noteServiceFailure })
      .catch((error) => Zotero.logError(error as Error));
  },
  onWindowUnload(win) {
    unregisterConversionMenus(win);
    closePanelForOwner(win);
  },
  onAppShutdown() {
    stopOnShutdown();
  },
  onShutdown() {
    closePanel();
    stopOnShutdown();
  },
};

const annotations: FeatureModule = {
  id: "annotations",
  onWindowLoad(win) {
    registerAnnotationMenu(win);
  },
  onWindowUnload(win) {
    unregisterAnnotationMenu(win);
  },
};

/**
 * Read-only HTTP endpoints on Zotero's existing localhost server, used by editors
 * that cannot be loaded into this process. The endpoint table is process-wide, so
 * registration is idempotent and the per-window hook is only a convenient point at
 * which Zotero is known to be up.
 */
const bridge: FeatureModule = {
  id: "obsidian.bridge",
  onWindowLoad() {
    registerBridgeEndpoints();
  },
  onAppShutdown() {
    unregisterBridgeEndpoints();
  },
  onShutdown() {
    unregisterBridgeEndpoints();
  },
};

export const featureRegistry = new FeatureRegistry([
  relations,
  metadata,
  conversion,
  annotations,
  bridge,
]);
