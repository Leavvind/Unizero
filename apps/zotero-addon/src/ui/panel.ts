/**
 * The UniZero panel: service status, job list, server directories, and the
 * template editor.
 *
 * Ported from the panel half of ZoMiner's `modules/plugin.js`.
 *
 * The panel itself (addon/chrome/content/panel.{xhtml,js}) was migrated **as is**:
 * it runs in its own dialog window, stays out of the esbuild bundle, and talks to
 * the add-on only through the api object below. Rewriting 600-odd lines of DOM
 * code as TypeScript would change no behaviour and would only produce a diff too
 * large to check line by line.
 *
 * The panel holds **no** Zotero preferences. Everything stored in Zotero prefs —
 * Python path, port, auto start/stop, MD copy — lives under Settings → UniZero;
 * see src/modules/prefs.ts. What stays here is the server's config.json, which has
 * to be requested from the runtime and is unreadable while the service is stopped;
 * putting it in the preferences pane would produce a set of inputs that work only
 * sometimes. The dividing line is where a setting lives and when it can be read,
 * not which feature it belongs to.
 */

import { config } from "../../package.json";
import { runtimeClient } from "../runtime-client/client";
import { serviceURL } from "../runtime-client/settings";
import { ensure, isStartedByPlugin, stop } from "../runtime-client/process";
import { showError } from "./progress";

const PANEL_URL = `chrome://${config.addonRef}/content/panel.xhtml`;
const PANEL_WINDOW_NAME = `${config.addonRef}-panel`;

let panelWindow: Window | null = null;
let panelOwner: Window | null = null;

/** Everything the panel receives through window.arguments[0].api. */
function panelApi() {
  return {
    Zotero,
    serviceURL: () => serviceURL(),
    client: runtimeClient,
    ensureService: () => ensure({ reportError: showError }),
    stopService: () => stop(),
    isStartedByPlugin: () => isStartedByPlugin(),
  };
}

/** Singleton: focus the existing panel rather than opening a second one. */
export function openPanel(mainWindow: Window): void {
  if (panelWindow && !panelWindow.closed) {
    panelWindow.focus();
    return;
  }
  panelWindow = (mainWindow as any).openDialog(
    PANEL_URL,
    PANEL_WINDOW_NAME,
    "chrome,centerscreen,resizable=yes,dialog=no,width=1040,height=860",
    { api: panelApi() },
  );
  panelOwner = mainWindow;
}

/** Close the panel when the add-on unloads; otherwise it stays on screen holding a dead api. */
export function closePanel(): void {
  if (panelWindow && !panelWindow.closed) {
    try {
      panelWindow.close();
    } catch (error) {
      // The window is already closing.
    }
  }
  panelWindow = null;
  panelOwner = null;
}

/** Close only the panel belonging to the main window that is being unloaded. */
export function closePanelForOwner(mainWindow: Window): void {
  if (panelOwner === mainWindow) {
    closePanel();
  }
}
