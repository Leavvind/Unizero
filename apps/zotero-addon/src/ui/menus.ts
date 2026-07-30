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
import { getString } from "../utils/locale";
import { showError } from "./progress";
import { noteConversionFailure, noteServiceFailure } from "./notices";

const MENU_CONVERT = `${config.addonRef}-convert-menu`;
const MENU_ANNOTATE = `${config.addonRef}-annotate-menuitem`;
const MENU_PANEL = `${config.addonRef}-panel-menuitem`;
const MENU_LITERATURE = `${config.addonRef}-literature-menuitem`;
const MENU_LITERATURE_TOOLS = `${config.addonRef}-literature-tools-menuitem`;
const MENU_LITERATURE_COLLECTION = `${config.addonRef}-literature-collection`;
const TOOLBAR_LITERATURE = `${config.addonRef}-literature-toolbar-button`;
const MENU_SEPARATOR = `${config.addonRef}-itemmenu-separator`;
const LITERATURE_ICON =
  `chrome://${config.addonRef}/content/icons/literature-explorer.svg`;

/** The add-on's item-menu commands, in the order they appear at the bottom. */
const ITEM_MENU_COMMANDS = [MENU_LITERATURE, MENU_CONVERT, MENU_ANNOTATE];

/**
 * Fallback template used when the service is unavailable or the template list
 * cannot be fetched. The runtime always ships it.
 */
const FALLBACK_TEMPLATE_ID = "paper-to-markdown";
const FALLBACK_TEMPLATE_NAME = "Generate paper Markdown";

type OpenPanel = (mainWindow: Window) => void;
type OpenLiteratureCollection = (mainWindow: Window) => void;
type OpenLiteratureItem = (mainWindow: Window, item: Zotero.Item) => void;

/**
 * Item-menu ordering listeners, one per main window, so unregistration can remove
 * exactly what registration added (AGENTS.md invariant 8).
 */
const orderListeners = new WeakMap<Window, EventListener>();
let registeredLiteratureCollectionMenuID: string | undefined;

/**
 * Put this add-on's entries, behind a separator, at the bottom of the item menu.
 *
 * Position cannot be settled once at registration time: every plugin appends to the
 * same popup as it loads, so the entries at the bottom are simply whoever registered
 * last, and load order is not ours to choose. Re-appending whenever the menu opens
 * settles it at display time instead, which is the only moment the order is visible.
 */
function selectedLiteratureItem(mainWindow: Window): Zotero.Item | null {
  const selected = (mainWindow as any).ZoteroPane?.getSelectedItems?.() as
    | Zotero.Item[]
    | undefined;
  if (!Array.isArray(selected) || selected.length !== 1) { return null; }
  const item = selected[0];
  return item?.isRegularItem?.() && !item.deleted ? item : null;
}

function moveEntriesToBottom(mainWindow: Window): void {
  const document = mainWindow.document;
  const itemMenu = document.getElementById("zotero-itemmenu");
  if (!itemMenu) { return; }
  const literatureEntry = document.getElementById(MENU_LITERATURE);
  if (literatureEntry) {
    if (selectedLiteratureItem(mainWindow)) {
      literatureEntry.removeAttribute("hidden");
    } else {
      literatureEntry.setAttribute("hidden", "true");
    }
  }
  const commands = ITEM_MENU_COMMANDS
    .map((id) => document.getElementById(id))
    .filter((element): element is HTMLElement => !!element);
  const separator = document.getElementById(MENU_SEPARATOR);
  // A separator with nothing after it is a stray line across someone else's menu.
  if (!commands.length) {
    separator?.remove();
    return;
  }
  if (separator) { itemMenu.appendChild(separator); }
  for (const command of commands) { itemMenu.appendChild(command); }
}

/** Add the separator and the ordering listener. Idempotent; safe to call per feature. */
function ensureItemMenuOrdering(mainWindow: Window): void {
  const document = mainWindow.document;
  const itemMenu = document.getElementById("zotero-itemmenu");
  if (!itemMenu) { return; }
  if (!document.getElementById(MENU_SEPARATOR)) {
    const separator = (document as any).createXULElement("menuseparator");
    separator.id = MENU_SEPARATOR;
    itemMenu.appendChild(separator);
  }
  if (!orderListeners.has(mainWindow)) {
    const listener = (event: Event) => {
      // A submenu's popupshowing bubbles up to the item menu; handle only this level.
      if (event.target !== itemMenu) { return; }
      moveEntriesToBottom(mainWindow);
    };
    itemMenu.addEventListener("popupshowing", listener);
    orderListeners.set(mainWindow, listener);
  }
  moveEntriesToBottom(mainWindow);
}

/** Drop the separator and the listener once the last of our entries is gone. */
function releaseItemMenuOrdering(mainWindow: Window): void {
  const document = mainWindow.document;
  if (ITEM_MENU_COMMANDS.some((id) => document.getElementById(id))) { return; }
  document.getElementById(MENU_SEPARATOR)?.remove();
  const listener = orderListeners.get(mainWindow);
  if (listener) {
    document.getElementById("zotero-itemmenu")?.removeEventListener("popupshowing", listener);
    orderListeners.delete(mainWindow);
  }
}

/**
 * Build the "Generate Markdown from template" submenu.
 *
 * The template list is fetched when the menu opens rather than prefetched at
 * startup: a list captured at startup would be stale for anyone who has since edited
 * their templates, and the service may still be coming up at that point anyway.
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
      // Reported as a notice rather than a popup: the user is only browsing a menu,
      // and the fallback entry below still lets them convert.
      if (!(await ensure({ reportError: noteServiceFailure }))) {
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
            .catch((error) => noteConversionFailure(String(error)));
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
          .catch((convertError) => noteConversionFailure(String(convertError)));
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
  ensureItemMenuOrdering(mainWindow);
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
  ensureItemMenuOrdering(mainWindow);
}

/**
 * Unizero Home contributions.
 *
 * The item context menu opens the selected paper directly. Tools, the Collection
 * context menu, and the item-toolbar button open the current Collection/library
 * overview, including when there is no paper to right-click.
 */
export function registerLiteratureExplorerMenus(
  mainWindow: Window,
  openCollection: OpenLiteratureCollection,
  openItem: OpenLiteratureItem,
): void {
  const document = mainWindow.document;
  (mainWindow as any).MozXULElement?.insertFTLIfNeeded?.(
    `${config.addonRef}-addon.ftl`,
  );
  const label = getString("literature-explorer-menu-label") ||
    "Unizero Home…";
  const itemMenu = document.getElementById("zotero-itemmenu");
  if (itemMenu && !document.getElementById(MENU_LITERATURE)) {
    const itemEntry = (document as any).createXULElement("menuitem");
    itemEntry.id = MENU_LITERATURE;
    itemEntry.setAttribute("label", label);
    itemEntry.addEventListener("command", () => {
      const item = selectedLiteratureItem(mainWindow);
      if (item) { openItem(mainWindow, item); }
    });
    itemMenu.appendChild(itemEntry);
  }

  const toolsMenu = document.getElementById("menu_ToolsPopup");
  if (toolsMenu && !document.getElementById(MENU_LITERATURE_TOOLS)) {
    const toolsEntry = (document as any).createXULElement("menuitem");
    toolsEntry.id = MENU_LITERATURE_TOOLS;
    toolsEntry.setAttribute("label", label);
    toolsEntry.addEventListener("command", () => openCollection(mainWindow));
    toolsMenu.appendChild(toolsEntry);
  }

  const itemToolbar = document.getElementById("zotero-items-toolbar");
  if (itemToolbar && !document.getElementById(TOOLBAR_LITERATURE)) {
    const button = (document as any).createXULElement("toolbarbutton");
    button.id = TOOLBAR_LITERATURE;
    button.classList.add("zotero-tb-button");
    button.setAttribute("tabindex", "-1");
    button.setAttribute("tooltiptext", label);
    button.style.listStyleImage = `url("${LITERATURE_ICON}")`;
    button.addEventListener("command", () => openCollection(mainWindow));
    // Keep the command with Zotero's creation buttons, before the flexible spacer
    // that pushes search to the right. This is the same toolbar extension point
    // used by zotero-style's Graph View button.
    const spacer = Array.from(itemToolbar.children).find((child) =>
      child.localName === "spacer" && child.getAttribute("flex") === "1");
    itemToolbar.insertBefore(button, spacer || null);
  }

  const menuManager = (Zotero as any).MenuManager;
  if (!registeredLiteratureCollectionMenuID && menuManager?.registerMenu) {
    registeredLiteratureCollectionMenuID = menuManager.registerMenu({
      menuID: MENU_LITERATURE_COLLECTION,
      pluginID: config.addonID,
      target: "main/library/collection",
      menus: [{
        menuType: "menuitem",
        l10nID: `${config.addonRef}-literature-explorer-menu-label`,
        onShowing: (_event: Event, context: any) => {
          const row = context.collectionTreeRow;
          context.setVisible(Boolean(
            row?.isCollection?.() || row?.isLibrary?.() || row?.isGroup?.(),
          ));
        },
        onCommand: (event: Event) => {
          const target = event.currentTarget as Element | null;
          const win = target?.ownerDocument?.defaultView || Zotero.getMainWindow();
          if (win) { openCollection(win); }
        },
      }],
    });
  }
  ensureItemMenuOrdering(mainWindow);
}

export function unregisterConversionMenus(mainWindow: Window): void {
  for (const id of [MENU_CONVERT, MENU_PANEL]) {
    const element = mainWindow.document.getElementById(id);
    if (element) { element.remove(); }
  }
  releaseItemMenuOrdering(mainWindow);
}

export function unregisterAnnotationMenu(mainWindow: Window): void {
  mainWindow.document.getElementById(MENU_ANNOTATE)?.remove();
  releaseItemMenuOrdering(mainWindow);
}

export function unregisterLiteratureExplorerMenus(mainWindow: Window): void {
  mainWindow.document.getElementById(MENU_LITERATURE)?.remove();
  mainWindow.document.getElementById(MENU_LITERATURE_TOOLS)?.remove();
  mainWindow.document.getElementById(TOOLBAR_LITERATURE)?.remove();
  releaseItemMenuOrdering(mainWindow);
}

export function unregisterLiteratureExplorerMenusAll(): void {
  if (!registeredLiteratureCollectionMenuID) { return; }
  (Zotero as any).MenuManager?.unregisterMenu?.(
    registeredLiteratureCollectionMenuID,
  );
  registeredLiteratureCollectionMenuID = undefined;
}
