/**
 * Zotero 设置里的 UniZero 面板。
 *
 * 面板里有两类设置，读写方式不同：
 *
 * - **文献关系那几组**用 XUL 的 `preference=` 声明式绑定，Zotero 自己负责读写和即时生效。
 * - **本地服务 / 转换那两组**在这里手工接线，走 `getRuntimePref` / `setRuntimePref`。
 *
 * 后者不用声明式绑定不是为了写得复杂：这些键已经有一套带类型的访问器（port 是整数，
 * 其余是布尔和字符串），面板此前也是通过它们写的。再挂一条声明式写路径，等于让同一批
 * 键有两个写入口，绕过 RuntimeSettings 的类型，还得指望 XUL 那边的类型转换和 Prefs
 * 里声明的类型正好对上。
 */

import { config } from "../../package.json";
import { runtimeClient } from "../runtime-client/client";
import {
  getRuntimePref,
  servicePort,
  setRuntimePref,
  type RuntimeSettings,
} from "../runtime-client/settings";
import {
  getConversionPref,
  setConversionPref,
  type ConversionSettings,
} from "../features/conversion/settings";

export async function registerPrefs(): Promise<void> {
  const prefOptions = {
    pluginID: config.addonID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: "UniZero",
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  };
  await (Zotero as any).PreferencePanes.register(prefOptions);
}

/** 元素 id 在 XHTML 里都带 addonRef 前缀，这里统一补上。 */
function element(doc: Document, suffix: string): any {
  return doc.getElementById(`${config.addonRef}-${suffix}`);
}

const RUNTIME_TEXT_FIELDS: Array<[string, "pythonPath" | "serverScript"]> = [
  ["runtime-python-path", "pythonPath"],
  ["runtime-server-script", "serverScript"],
];

const RUNTIME_CHECKBOXES: Array<[string, "autoStart" | "autoStopOnQuit"]> = [
  ["runtime-auto-start", "autoStart"],
  ["runtime-auto-stop", "autoStopOnQuit"],
];

const CONVERSION_CHECKBOXES: Array<[string, keyof ConversionSettings]> = [
  ["conversion-md-snapshot", "mdSnapshot"],
];

/**
 * 端口改了之后，同步给正在运行的 runtime。
 *
 * 插件自己拉起服务时端口是命令行传的，`config.json` 不参与——但用户手动跑
 * `python -m unizero_runtime` 时它就是权威值。不同步的话，手动启动的服务继续听着旧端口，
 * 而插件已经去敲新端口了，症状是一个明明活着的服务永远健康检查失败。
 *
 * 失败不报错：服务没开是常态而不是异常，何况新端口已经存进 prefs，下次启动照样对。
 */
function syncPortToRuntime(currentPort: number, nextPort: number): void {
  // Contact the service on the port it is listening on now. serviceURL() already
  // points at nextPort by the time this asynchronous request starts.
  runtimeClient.saveConfigAtPort(currentPort, { port: nextPort }).catch((error) => {
    ztoolkit.log(`runtime port not synced, service likely offline: ${error}`);
  });
}

/**
 * 即时生效，不设保存按钮——和同一面板里那些声明式绑定的项保持一致。面板里一半改完就生效、
 * 另一半要按保存，是比多点一次按钮更糟的事。
 */
function bindRuntimeSettings(doc: Document): void {
  for (const [id, name] of RUNTIME_TEXT_FIELDS) {
    const input = element(doc, id);
    if (!input) { continue; }
    input.value = getRuntimePref(name) || "";
    input.addEventListener("change", () => {
      setRuntimePref(name, String(input.value).trim());
    });
  }

  const port = element(doc, "runtime-port");
  if (port) {
    port.value = String(servicePort());
    port.addEventListener("change", () => {
      // 空值或垃圾输入退回默认端口，而不是把 NaN 写进一个整数 pref。
      const parsed = parseInt(String(port.value), 10);
      const currentPort = servicePort();
      const value = parsed > 0 && parsed <= 65535 ? parsed : currentPort;
      port.value = String(value);
      setRuntimePref("port", value);
      if (value !== currentPort) {
        syncPortToRuntime(currentPort, value);
      }
    });
  }

  for (const [id, name] of RUNTIME_CHECKBOXES) {
    const box = element(doc, id);
    if (!box) { continue; }
    box.checked = !!getRuntimePref(name as keyof RuntimeSettings);
    box.addEventListener("command", () => {
      setRuntimePref(name, !!box.checked);
    });
  }

  for (const [id, name] of CONVERSION_CHECKBOXES) {
    const box = element(doc, id);
    if (!box) { continue; }
    box.checked = !!getConversionPref(name);
    box.addEventListener("command", () => {
      setConversionPref(name, !!box.checked);
    });
  }
}

export function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = { window: _window };
  } else {
    addon.data.prefs.window = _window;
  }

  try {
    bindRuntimeSettings(addon.data.prefs!.window.document);
  } catch (error) {
    // 接线失败只该让这两组设置失灵，不该带走整个设置面板。
    Zotero.logError(error as Error);
  }
}
