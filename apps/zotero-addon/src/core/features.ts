import { config } from "../../package.json";
import MetadataEnrichment from "../modules/metadataEnrichment";
import { registerPrefs } from "../modules/prefs";
import Views from "../modules/views";
import { startInBackground, stopOnShutdown } from "../runtime-client/process";
import { noteServiceFailure } from "../ui/notices";
import {
  registerAnnotationMenu,
  registerConversionMenus,
  unregisterAnnotationMenu,
  unregisterConversionMenus,
} from "../ui/menus";
import { closePanel, closePanelForOwner, openPanel } from "../ui/panel";
import { FeatureRegistry, type FeatureModule } from "./featureRegistry";

const relations: FeatureModule = {
  id: "literature.relations",
  async onWindowLoad(win) {
    let views = Zotero[config.addonInstance]?.views as Views | undefined;
    if (!views) {
      views = new Views();
      await views.onInit(win);
      Zotero[config.addonInstance].views = views;
      try {
        await registerPrefs();
      } catch (error) {
        Zotero.logError(error as Error);
      }
      return;
    }
    views.onWindowLoad(win);
  },
  onWindowUnload(win) {
    Zotero[config.addonInstance]?.views?.onWindowUnload?.(win);
  },
  onShutdown() {
    Zotero[config.addonInstance]?.views?.onDestroy?.();
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
