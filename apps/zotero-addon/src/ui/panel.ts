/**
 * UniZero 面板：服务状态、job 列表、服务端目录和模板编辑器。
 *
 * 端口自 ZoMiner `modules/plugin.js` 的面板部分。
 *
 * 面板本体（addon/chrome/content/panel.{xhtml,js}）是**原样迁移**的：它运行在独立的
 * dialog 窗口里，不进 esbuild bundle，且只通过下面这个 api 对象与插件交互。把 600 多行
 * DOM 代码改写成 TypeScript 对行为没有任何好处，只会制造一个无法逐行核对的大 diff。
 *
 * 面板里**没有** Zotero 偏好设置。存在 Zotero prefs 里的项（Python 路径、端口、自动
 * 启停、MD 副本）都在 设置 → UniZero 里，见 src/modules/prefs.ts。留在这儿的只有服务端
 * 的 config.json——它得向 runtime 要，服务停着就读不到，放进偏好面板会得到一组时灵时
 * 不灵的输入框。分界线是"存在哪、什么时候能读到"，不是"属于哪个功能"。
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

/** 面板通过 window.arguments[0].api 拿到的全部能力。 */
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

/** 单例：已经开着就聚焦，不开第二个。 */
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

/** 插件卸载时把面板一起关掉，否则它会留在屏幕上引用已失效的 api。 */
export function closePanel(): void {
  if (panelWindow && !panelWindow.closed) {
    try {
      panelWindow.close();
    } catch (error) {
      // 窗口已经在关闭流程里了。
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
