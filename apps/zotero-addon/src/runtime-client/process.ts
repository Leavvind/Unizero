/**
 * Paper runtime 的本地进程管理。
 *
 * 端口自 ZoMiner `modules/service.js`，行为保持一致。
 *
 * 这里的复杂度几乎全部来自一件事：**找到一个装了依赖的 Python**。用户机器上通常有好
 * 几个解释器（系统的、Windows Store 的、conda 的、项目 venv 的），只有装了 mineru 的
 * 那个能跑起来，而选错的表现是"服务启动后立刻退出"——一个非常难自助排查的症状。
 */

import { runtimeClient } from "./client";
import { getRuntimePref } from "./settings";
import type { HealthResponse } from "./contracts";

/** 启动后等待健康检查通过的上限。MinerU 首次加载模型很慢，60s 不算宽裕。 */
const STARTUP_TIMEOUT_S = 60;

/** 探测某个解释器是否装了依赖时的超时，秒。 */
const PROBE_TIMEOUT_S = 3;

let process: any = null;
let startedByPlugin = false;
let lastPythonPath = "";

function localFile(path: string): any {
  const file = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile);
  file.initWithPath(path);
  return file;
}

function environmentVariable(name: string): string {
  const environment = Components.classes["@mozilla.org/process/environment;1"]
    .getService(Components.interfaces.nsIEnvironment);
  return environment.get(name) || "";
}

/**
 * 用候选解释器跑一句 import 探测。
 *
 * 比"文件存在"强得多的判据：PATH 上第一个 python 往往不是装了 mineru 的那个，
 * 而两者在文件系统层面看起来完全一样。
 */
function pythonHasDeps(pythonFile: any): boolean {
  try {
    const probe = Components.classes["@mozilla.org/process/util;1"]
      .createInstance(Components.interfaces.nsIProcess);
    probe.init(pythonFile);
    const code =
      "import importlib.util as u,sys;" +
      "sys.exit(0 if all(u.find_spec(m) for m in " +
      "('fastapi','uvicorn','pydantic','mineru')) else 3)";
    probe.run(true, ["-c", code], PROBE_TIMEOUT_S);
    return probe.exitValue === 0;
  } catch (error) {
    return false;
  }
}

function existingFiles(paths: string[]): any[] {
  const found: any[] = [];
  for (const candidate of paths) {
    try {
      const file = localFile(candidate);
      if (file.exists() && file.isFile()) { found.push(file); }
    } catch (error) {
      // 路径语法在当前平台上非法，跳过。
    }
  }
  return found;
}

function findPythonUnix(script: string): any {
  const candidates: string[] = [];
  // 优先项目虚拟环境：server.py 位于 <repo>/paper_service/，venv 在 <repo>/.venv/
  if (script) {
    const repoRoot = script.replace(/[\\/][^\\/]*[\\/][^\\/]*$/, "");
    candidates.push(`${repoRoot}/.venv/bin/python`);
    candidates.push(`${repoRoot}/.venv/bin/python3`);
  }
  for (let directory of environmentVariable("PATH").split(":")) {
    directory = directory.trim();
    if (!directory) { continue; }
    candidates.push(`${directory}/python3`);
    candidates.push(`${directory}/python`);
  }

  const existing = existingFiles(candidates);
  for (const file of existing) {
    if (pythonHasDeps(file)) {
      ztoolkit.log(`auto-selected python (deps ok): ${file.path}`);
      return file;
    }
  }
  // 一个都没装全依赖时仍返回第一个：让服务真的启动一次，失败信息比"找不到 Python"具体。
  return existing.length ? existing[0] : null;
}

function findPythonWindows(): any {
  const candidates: string[] = [];
  for (let directory of environmentVariable("PATH").split(";")) {
    directory = directory.trim();
    // WindowsApps 里的是应用商店占位符，运行它只会弹出商店页面。
    if (!directory || /WindowsApps/i.test(directory)) { continue; }
    for (const name of ["pythonw.exe", "python.exe"]) {
      candidates.push(`${directory}\\${name}`);
    }
  }

  const existing = existingFiles(candidates);
  for (const file of existing) {
    if (pythonHasDeps(file)) {
      ztoolkit.log(`auto-selected python (deps ok): ${file.path}`);
      return file;
    }
  }
  return existing.length ? existing[0] : null;
}

function findPython(script: string): any {
  const preferred = String(getRuntimePref("pythonPath") || "").trim();
  if (preferred) {
    const candidates: string[] = [];
    // 用户填的是 python.exe 时优先换成 pythonw.exe：前者会常驻一个黑色控制台窗口。
    if (/python\.exe$/i.test(preferred)) {
      candidates.push(preferred.replace(/python\.exe$/i, "pythonw.exe"));
    }
    candidates.push(preferred);
    const existing = existingFiles(candidates);
    return existing.length ? existing[0] : null;
  }

  return Zotero.isWin ? findPythonWindows() : findPythonUnix(script);
}

function resolveServerScript(): string {
  let script = String(getRuntimePref("serverScript") || "").trim();
  if (!script) {
    throw new Error("未配置 server.py 路径（工具 → UniZero 面板 → 运行时设置）");
  }
  // macOS/Linux 下常见手误：从别处粘贴绝对路径时漏了开头的 "/"
  if (!Zotero.isWin && /^Users\//.test(script)) { script = `/${script}`; }
  return script;
}

function startProcess(): void {
  const script = resolveServerScript();
  let scriptFile: any;
  try {
    scriptFile = localFile(script);
  } catch (error) {
    throw new Error(`server.py 路径无效: ${script}`);
  }
  if (!scriptFile.exists()) {
    throw new Error(
      `server.py 不存在: ${script}\n` +
      "请在 工具 → UniZero 面板 → 运行时设置 中修改 server.py 路径",
    );
  }

  const python = findPython(script);
  if (!python) {
    throw new Error("找不到 Python（请在 UniZero 面板中设置 Python 路径）");
  }

  const child = Components.classes["@mozilla.org/process/util;1"]
    .createInstance(Components.interfaces.nsIProcess);
  child.init(python);
  // runw 避免 Windows 上弹控制台窗口；Unix 上没有这个区分。
  if (Zotero.isWin) {
    child.runw(false, [script], 1);
  } else {
    child.run(false, [script], 1);
  }

  process = child;
  startedByPlugin = true;
  lastPythonPath = python.path;
  ztoolkit.log(`runtime spawned: ${python.path} ${script}`);
}

/** 健康检查，失败返回 null——调用方关心的是"能不能用"，不是失败原因。 */
export async function health(): Promise<HealthResponse | null> {
  try {
    return await runtimeClient.health();
  } catch (error) {
    return null;
  }
}

/**
 * 读 server.log 末尾若干行。
 *
 * 进程启动后立刻退出时，唯一的诊断信息就在这个文件里；不读出来用户只能看到
 * "服务启动后立即退出"，等于没说。
 */
async function readLogTail(maxLines = 15): Promise<string> {
  try {
    const script = resolveServerScript();
    const directory = script.replace(/[\\/][^\\/]*$/, "");
    const path = directory + (Zotero.isWin ? "\\" : "/") + "server.log";
    if (!(await IOUtils.exists(path))) { return ""; }
    const contents = await Zotero.File.getContentsAsync(path);
    const lines = String(contents).replace(/\s+$/, "").split(/\r?\n/);
    return lines.slice(-maxLines).join("\n");
  } catch (error) {
    ztoolkit.log(`readLogTail failed: ${error}`);
    return "";
  }
}

export interface EnsureOptions {
  /** 展示失败信息。由调用方注入，进程管理不该自己决定 UI 形态。 */
  reportError(message: string): void;
}

/**
 * 保证 runtime 可用：已在跑就直接返回，否则按设置尝试拉起来。
 *
 * 返回 boolean 而不是抛错：调用方（转换/批注命令）在服务不可用时的正确行为是安静收手，
 * 错误信息已经通过 reportError 给过用户了，再抛一次只会变成重复提示。
 */
export async function ensure({ reportError }: EnsureOptions): Promise<boolean> {
  if (await health()) { return true; }

  if (!getRuntimePref("autoStart")) {
    reportError(
      "本地转换服务未启动。\n请运行: python paper_service/server.py\n" +
      "（或在 UniZero 面板中开启自动启动）",
    );
    return false;
  }

  const progress = new Zotero.ProgressWindow({ closeOnClick: false });
  progress.changeHeadline("UniZero");
  const line = new progress.ItemProgress("", "正在启动本地转换服务…");
  line.setProgress(30);
  progress.show();

  try {
    startProcess();
  } catch (error) {
    progress.close();
    reportError(`无法启动本地转换服务：${(error as Error).message || error}`);
    return false;
  }

  for (let attempt = 0; attempt < STARTUP_TIMEOUT_S; attempt++) {
    await Zotero.Promise.delay(1000);
    if (await health()) {
      line.setProgress(100);
      line.setText("服务已启动");
      progress.startCloseTimer(1500);
      return true;
    }
    // 进程已经死了就别等满 60s——失败信息现在就能给。
    if (process && !process.isRunning) {
      progress.close();
      const tail = await readLogTail();
      let message = `转换服务启动后立即退出。\nPython: ${lastPythonPath}\n`;
      message += tail
        ? `\nserver.log 末尾：\n${tail}`
        : "\n请确认该 Python 已安装 fastapi、uvicorn、pydantic 和 mineru。";
      reportError(message);
      process = null;
      startedByPlugin = false;
      return false;
    }
  }

  progress.close();
  reportError(`转换服务启动超时（${STARTUP_TIMEOUT_S}s）。请查看 server.log 排查。`);
  return false;
}

/** 主动停止：先请求优雅关闭，再兜底 kill。 */
export async function stop(): Promise<void> {
  try {
    await runtimeClient.shutdown();
  } catch (error) {
    // 服务可能已经不在了，或者根本不是我们启动的。
  }
  await Zotero.Promise.delay(700);
  try {
    if (process && process.isRunning) { process.kill(); }
  } catch (error) {
    // 进程已退出。
  }
  process = null;
  startedByPlugin = false;
}

/**
 * 插件卸载/关闭时的清理。
 *
 * 只杀我们自己启动的进程：用户手动跑起来的服务不该因为关掉 Zotero 就没了。
 * 这里不能 await——shutdown 钩子是同步的，异步清理会被直接丢弃。
 */
export function stopOnShutdown(): void {
  if (!startedByPlugin || !getRuntimePref("autoStopOnQuit")) { return; }
  try {
    if (process && process.isRunning) { process.kill(); }
    ztoolkit.log("runtime stopped on shutdown");
  } catch (error) {
    // 已经退出了。
  }
  process = null;
  startedByPlugin = false;
}

export function isStartedByPlugin(): boolean {
  return startedByPlugin;
}
