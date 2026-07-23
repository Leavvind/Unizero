/**
 * UniZero 面板：服务状态、job 列表、运行时设置和模板编辑器。
 *
 * 端口自 ZoMiner `modules/plugin.js` 的面板部分。
 *
 * 面板本体（addon/chrome/content/panel.{xhtml,js}）是**原样迁移**的：它运行在独立的
 * dialog 窗口里，不进 esbuild bundle，且只通过下面这个 api 对象与插件交互。把 662 行
 * DOM 代码改写成 TypeScript 对行为没有任何好处，只会制造一个无法逐行核对的大 diff。
 *
 * 这里唯一的适配工作是把面板期望的扁平 getPref/setPref 映射到 UniZero 拆开的两组设置。
 */

import { config } from "../../package.json";
import { runtimeClient } from "../runtime-client/client";
import {
  RUNTIME_PREF_DEFAULTS,
  getRuntimePref,
  serviceURL,
  setRuntimePref,
  type RuntimeSettings,
} from "../runtime-client/settings";
import {
  CONVERSION_PREF_DEFAULTS,
  getConversionPref,
  setConversionPref,
  type ConversionSettings,
} from "../features/conversion/settings";
import { ensure, isStartedByPlugin, stop } from "../runtime-client/process";
import { showError } from "./progress";

const PANEL_URL = `chrome://${config.addonRef}/content/panel.xhtml`;
const PANEL_WINDOW_NAME = `${config.addonRef}-panel`;

let panelWindow: Window | null = null;

/**
 * 面板看到的是一份扁平的设置视图（ZoMiner 的原始形状），而 UniZero 内部按归属把
 * 它们拆成了 runtime 连接设置和转换设置。这两个函数负责在边界上转换。
 */
type PanelPrefName = keyof RuntimeSettings | keyof ConversionSettings;

const PANEL_PREF_DEFAULTS = {
  ...RUNTIME_PREF_DEFAULTS,
  ...CONVERSION_PREF_DEFAULTS,
};

function isConversionPref(name: PanelPrefName): name is keyof ConversionSettings {
  return name in CONVERSION_PREF_DEFAULTS;
}

function getPanelPref(name: PanelPrefName): unknown {
  return isConversionPref(name)
    ? getConversionPref(name)
    : getRuntimePref(name as keyof RuntimeSettings);
}

function setPanelPref(name: PanelPrefName, value: unknown): void {
  if (isConversionPref(name)) {
    setConversionPref(name, value as boolean);
  } else {
    setRuntimePref(name as keyof RuntimeSettings, value as never);
  }
}

/** 面板通过 window.arguments[0].api 拿到的全部能力。 */
function panelApi() {
  return {
    Zotero,
    prefDefaults: PANEL_PREF_DEFAULTS,
    getPref: (name: PanelPrefName) => getPanelPref(name),
    setPref: (name: PanelPrefName, value: unknown) => setPanelPref(name, value),
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
}
