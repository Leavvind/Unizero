/**
 * Registration of the item context menu and the Tools menu.
 *
 * Ported from the menu half of ZoMiner's `modules/plugin.js`. This uses native XUL
 * rather than ztoolkit's MenuManager, because the template submenu only queries
 * the runtime on popupshowing (see below) and ztoolkit's declarative registration
 * cannot express that deferred fill.
 *
 * Per AGENTS.md invariant 8, registration and unregistration must be symmetric —
 * unregisterMenus() has to remove every element added here.
 */

import { config } from "../../package.json";
import { convertSelected } from "../features/conversion/commands";
import { annotateSelected } from "../features/annotations/commands";
import { ensure } from "../runtime-client/process";
import { runtimeClient } from "../runtime-client/client";
import { showError } from "./progress";

const MENU_CONVERT = `${config.addonRef}-convert-menu`;
const MENU_ANNOTATE = `${config.addonRef}-annotate-menuitem`;
const MENU_PANEL = `${config.addonRef}-panel-menuitem`;

/**
 * Fallback template used when the service is unavailable or the template list
 * cannot be fetched. The runtime always ships it.
 */
const FALLBACK_TEMPLATE_ID = "paper-to-markdown";
const FALLBACK_TEMPLATE_NAME = "Generate paper Markdown";

type OpenPanel = (mainWindow: Window) => void;

/**
 * Build the "Generate Markdown from template" submenu.
 *
 * The template list is fetched when the menu opens rather than prefetched at
 * startup: prefetching would make Zotero's startup contact a local service that is
 * usually not running, and users need to see an up-to-date list after editing
 * their templates.
 */
function buildConvertMenu(mainWindow: Window, document: Document): Element {
  const convert = (document as any).createXULElement("menu");
  convert.id = MENU_CONVERT;
  convert.setAttribute("label", "Generate Markdown from template");

  const templatePopup = (document as any).createXULElement("menupopup");
  const loading = (document as any).createXULElement("menuitem");
  loading.setAttribute("label", "Loading templates…");
  loading.setAttribute("disabled", "true");
  templatePopup.appendChild(loading);

  templatePopup.addEventListener("popupshowing", async (event: Event) => {
    // A submenu's own popupshowing bubbles up here; handle only this level.
    if (event.target !== templatePopup) { return; }
    templatePopup.textContent = "";
    try {
      if (!(await ensure({ reportError: showError }))) {
        throw new Error("The local service is not running");
      }
      const response = await runtimeClient.templates();
      const templates = response.templates || [];
      if (!templates.length) { throw new Error("No templates available"); }

      for (const template of templates) {
        const entry = (document as any).createXULElement("menuitem");
        entry.setAttribute("label", template.name || template.id);
        entry.setAttribute("tooltiptext", template.description || template.id);
        entry.addEventListener("command", () => {
          convertSelected(mainWindow, template.id, template.name)
            .catch((error) => {
              ztoolkit.log(`convertSelected error: ${error}`);
              showError(String(error));
            });
        });
        templatePopup.appendChild(entry);
      }
    } catch (error) {
      // Converting must stay possible without the template list: offer the default
      // template rather than an empty menu.
      const fallback = (document as any).createXULElement("menuitem");
      fallback.setAttribute("label", `${FALLBACK_TEMPLATE_NAME} (default template)`);
      fallback.addEventListener("command", () => {
        convertSelected(mainWindow, FALLBACK_TEMPLATE_ID, FALLBACK_TEMPLATE_NAME)
          .catch((convertError) => {
            showError(String(convertError));
          });
      });
      templatePopup.appendChild(fallback);
    }
  });

  convert.appendChild(templatePopup);
  return convert;
}

/** Conversion and runtime-panel contribution. Idempotent per main window. */
export function registerConversionMenus(
  mainWindow: Window,
  openPanel: OpenPanel,
): void {
  const document = mainWindow.document;
  const itemMenu = document.getElementById("zotero-itemmenu");
  if (itemMenu && !document.getElementById(MENU_CONVERT)) {
    itemMenu.appendChild(buildConvertMenu(mainWindow, document));
  }
  const toolsMenu = document.getElementById("menu_ToolsPopup");
  if (toolsMenu && !document.getElementById(MENU_PANEL)) {
    const panel = (document as any).createXULElement("menuitem");
    panel.id = MENU_PANEL;
    panel.setAttribute("label", "UniZero Panel…");
    panel.addEventListener("command", () => openPanel(mainWindow));
    toolsMenu.appendChild(panel);
  }
}

/** Annotation command contribution. Idempotent per main window. */
export function registerAnnotationMenu(mainWindow: Window): void {
  const document = mainWindow.document;
  if (document.getElementById(MENU_ANNOTATE)) { return; }
  const itemMenu = document.getElementById("zotero-itemmenu");
  if (!itemMenu) { return; }
  const annotate = (document as any).createXULElement("menuitem");
  annotate.id = MENU_ANNOTATE;
  annotate.setAttribute("label", "Inject annotations into MD");
  annotate.addEventListener("command", () => {
    annotateSelected(mainWindow).catch((error) => {
      ztoolkit.log(`annotateSelected error: ${error}`);
      showError(String(error));
    });
  });
  itemMenu.appendChild(annotate);
}

export function unregisterConversionMenus(mainWindow: Window): void {
  for (const id of [MENU_CONVERT, MENU_PANEL]) {
    const element = mainWindow.document.getElementById(id);
    if (element) { element.remove(); }
  }
}

export function unregisterAnnotationMenu(mainWindow: Window): void {
  mainWindow.document.getElementById(MENU_ANNOTATE)?.remove();
}
