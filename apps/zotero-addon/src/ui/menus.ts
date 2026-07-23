/**
 * 条目右键菜单与工具菜单的注册。
 *
 * 端口自 ZoMiner `modules/plugin.js` 的菜单部分。这里用原生 XUL 而不是 ztoolkit 的
 * MenuManager：模板子菜单需要在 popupshowing 时才去查 runtime（见下），ztoolkit 的
 * 声明式注册表达不了这种延迟填充。
 *
 * 按 AGENTS.md 不变量 8，注册和注销必须对称——unregisterMenus() 要能把这里加的每个
 * 元素都摘干净。
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

/** 服务不可用、模板列表拿不到时用的兜底模板。runtime 一定内置了它。 */
const FALLBACK_TEMPLATE_ID = "paper-to-markdown";
const FALLBACK_TEMPLATE_NAME = "生成论文 Markdown";

type OpenPanel = (mainWindow: Window) => void;

/**
 * 构造"使用模板生成 Markdown"子菜单。
 *
 * 模板列表在菜单弹出时才拉取，不在启动时预取：预取会让 Zotero 启动去连一个多半没开
 * 的本地服务，而用户改了模板之后也需要看到最新列表。
 */
function buildConvertMenu(mainWindow: Window, document: Document): Element {
  const convert = (document as any).createXULElement("menu");
  convert.id = MENU_CONVERT;
  convert.setAttribute("label", "使用模板生成 Markdown");

  const templatePopup = (document as any).createXULElement("menupopup");
  const loading = (document as any).createXULElement("menuitem");
  loading.setAttribute("label", "读取模板…");
  loading.setAttribute("disabled", "true");
  templatePopup.appendChild(loading);

  templatePopup.addEventListener("popupshowing", async (event: Event) => {
    // 子菜单自己的 popupshowing 会冒泡上来，只处理本级。
    if (event.target !== templatePopup) { return; }
    templatePopup.textContent = "";
    try {
      if (!(await ensure({ reportError: showError }))) {
        throw new Error("本地服务未启动");
      }
      const response = await runtimeClient.templates();
      const templates = response.templates || [];
      if (!templates.length) { throw new Error("没有可用模板"); }

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
      // 拿不到模板列表也要让用户能转换：给一个默认模板入口，而不是一个空菜单。
      const fallback = (document as any).createXULElement("menuitem");
      fallback.setAttribute("label", `${FALLBACK_TEMPLATE_NAME}（默认模板）`);
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
    panel.setAttribute("label", "UniZero 面板…");
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
  annotate.setAttribute("label", "注入批注到 MD");
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
