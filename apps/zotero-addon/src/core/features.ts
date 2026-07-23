import { config } from "../../package.json";
import MetadataEnrichment from "../modules/metadataEnrichment";
import { registerPrefs } from "../modules/prefs";
import Views from "../modules/views";
import { stopOnShutdown } from "../runtime-client/process";
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
