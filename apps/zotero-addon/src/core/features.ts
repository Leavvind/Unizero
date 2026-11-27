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
import { paperLinks } from "../zotero/paperLinkSources";
import { vaultMentions } from "../zotero/vaultMentionStore";
import { FeatureRegistry, type FeatureModule } from "./featureRegistry";

/** Uniconnection tabs (internally still "Home"); one owner for every main window. */
let home: UnizeroHome | undefined;

function uniconnection(views: Views): UnizeroHome {
  home ||= new UnizeroHome({
    cachedBibliography: (item, kind) => views.getCachedLiteratureSnapshot(item, kind),
    fetchBibliography: (item, kind, refresh) => views.getLiteratureSnapshot(item, kind, refresh),
    loadMoreCitations: (item) => views.loadMoreLiteratureCitations(item),
  });
  return home;
}

const relations: FeatureModule = {
  id: "literature.relations",
  async onWindowLoad(win) {
    let views = Zotero[config.addonInstance]?.views as Views | undefined;
    if (!views) {
      views = new Views();
      await views.onInit();
      Zotero[config.addonInstance].views = views;
      try {
        await registerPrefs();
      } catch (error) {
        Zotero.logError(error as Error);
      }
    }
    uniConnectionSync.register();
    addon.api.uniConnectionSync = uniConnectionSync;
    const tab = uniconnection(views);
    tab.register(win);
    registerUniConnectionMenu(win, (mainWindow, item) => tab.openPaper(mainWindow, item));
  },
  onWindowUnload(win) {
    home?.unregister(win);
    unregisterUniConnectionMenu(win);
  },
  onShutdown() {
    uniConnectionSync.unregister();
    home?.shutdown();
    home = undefined;
    paperLinks.clear();
    vaultMentions.shutdown();
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
