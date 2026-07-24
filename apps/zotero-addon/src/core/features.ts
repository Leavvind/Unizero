import { config } from "../../package.json";
import MetadataEnrichment from "../modules/metadataEnrichment";
import { registerPrefs } from "../modules/prefs";
import Views from "../modules/views";
import { uniConnectionSync } from "../modules/uniConnectionSync";
import { startInBackground, stopOnShutdown } from "../runtime-client/process";
import { noteServiceFailure } from "../ui/notices";
import {
  registerAnnotationMenu,
  registerConversionMenus,
  registerLiteratureExplorerMenus,
  unregisterAnnotationMenu,
  unregisterConversionMenus,
  unregisterLiteratureExplorerMenus,
  unregisterLiteratureExplorerMenusAll,
} from "../ui/menus";
import { closePanel, closePanelForOwner, openPanel } from "../ui/panel";
import {
  closeLiteratureExplorer,
  closeLiteratureExplorerForOwner,
  openLiteratureExplorer,
  openLiteratureExplorerForCollection,
} from "../ui/literatureExplorer";
import { FeatureRegistry, type FeatureModule } from "./featureRegistry";

const relations: FeatureModule = {
  id: "literature.relations",
  async onWindowLoad(win) {
    let views = Zotero[config.addonInstance]?.views as Views | undefined;
    if (!views) {
      views = new Views();
      views.setExplorerOpener((mainWindow, item, kind) =>
        openLiteratureExplorer(mainWindow, item, kind, views!));
      await views.onInit(win);
      Zotero[config.addonInstance].views = views;
      uniConnectionSync.register();
      addon.api.uniConnectionSync = uniConnectionSync;
      try {
        await registerPrefs();
      } catch (error) {
        Zotero.logError(error as Error);
      }
      registerLiteratureExplorerMenus(win, (mainWindow) =>
        openLiteratureExplorerForCollection(mainWindow, views!));
      return;
    }
    views.setExplorerOpener((mainWindow, item, kind) =>
      openLiteratureExplorer(mainWindow, item, kind, views!));
    views.onWindowLoad(win);
    uniConnectionSync.register();
    addon.api.uniConnectionSync = uniConnectionSync;
    registerLiteratureExplorerMenus(win, (mainWindow) =>
      openLiteratureExplorerForCollection(mainWindow, views!));
  },
  onWindowUnload(win) {
    unregisterLiteratureExplorerMenus(win);
    Zotero[config.addonInstance]?.views?.onWindowUnload?.(win);
    closeLiteratureExplorerForOwner(win);
  },
  onShutdown() {
    uniConnectionSync.unregister();
    closeLiteratureExplorer();
    unregisterLiteratureExplorerMenusAll();
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

export const featureRegistry = new FeatureRegistry([
  relations,
  metadata,
  conversion,
  annotations,
]);
