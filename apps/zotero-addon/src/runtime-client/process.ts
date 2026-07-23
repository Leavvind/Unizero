/**
 * Paper runtime 的本地进程管理。
 *
 * 端口自 ZoMiner `modules/service.js`。启动命令的选择已经拆到 launch.ts —— ZoMiner 只
 * 有 `<python> <server.py>` 一种形态，现在有三种。
 */

import { runtimeClient } from "./client";
import { getRuntimePref, servicePort } from "./settings";
import { resolveLaunchPlan, runtimeHome, type LaunchPlan } from "./launch";
import type { HealthResponse } from "./contracts";

/** 启动后等待健康检查通过的上限。MinerU 首次加载模型很慢，60s 不算宽裕。 */
const STARTUP_TIMEOUT_S = 60;

let process: any = null;
let startedByPlugin = false;
let lastPlan: LaunchPlan | null = null;

function startProcess(): void {
  // 端口显式传给子进程，而不是让它自己读 config.json：两边各读各的时，服务会在
  // 一个端口上正常运行，而 add-on 在另一个端口上永远等不到健康检查通过。
  const plan = resolveLaunchPlan(servicePort());

  const child = Components.classes["@mozilla.org/process/util;1"]
    .createInstance(Components.interfaces.nsIProcess);
  child.init(plan.executable);
  // runw 避免 Windows 上弹控制台窗口；Unix 上没有这个区分。
  if (Zotero.isWin) {
    child.runw(false, plan.args, plan.args.length);
  } else {
    child.run(false, plan.args, plan.args.length);
  }

  process = child;
  startedByPlugin = true;
  lastPlan = plan;
  ztoolkit.log(`runtime spawned [${plan.mode}]: ${plan.description}`);
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
 *
 * 两个候选位置都试：新 runtime 写在 runtime home 下，而 ZoMiner 的旧 server.py 写在
 * 脚本旁边。猜错位置的代价正好是这个函数存在的意义全部丢失。
 */
async function readLogTail(maxLines = 15): Promise<string> {
  const separator = Zotero.isWin ? "\\" : "/";
  const candidates = [runtimeHome() + separator + "server.log"];
  if (lastPlan?.scriptPath) {
    const directory = lastPlan.scriptPath.replace(/[\\/][^\\/]*$/, "");
    candidates.push(directory + separator + "server.log");
  }

  for (const path of candidates) {
    try {
      if (!(await IOUtils.exists(path))) { continue; }
      const contents = await Zotero.File.getContentsAsync(path);
      const lines = String(contents).replace(/\s+$/, "").split(/\r?\n/);
      return `${path}\n${lines.slice(-maxLines).join("\n")}`;
    } catch (error) {
      ztoolkit.log(`readLogTail failed for ${path}: ${error}`);
    }
  }
  return "";
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
      "本地转换服务未启动。\n请运行: unizero-runtime\n" +
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
      let message = "转换服务启动后立即退出。\n";
      message += `启动方式[${lastPlan?.mode}]: ${lastPlan?.description}\n`;
      message += tail
        ? `\nserver.log 末尾：\n${tail}`
        : "\n请确认该 Python 已安装 unizero-runtime 及其依赖（含 mineru）。";
      reportError(message);
      process = null;
      startedByPlugin = false;
      return false;
    }
  }

  progress.close();
  reportError(
    `转换服务启动超时（${STARTUP_TIMEOUT_S}s）。\n` +
    `启动方式[${lastPlan?.mode}]: ${lastPlan?.description}\n` +
    `请查看 ${runtimeHome()} 下的 server.log。`,
  );
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
