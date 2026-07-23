/**
 * Local process management for the paper runtime.
 *
 * Ported from ZoMiner's `modules/service.js`. Choosing the launch command now
 * lives in launch.ts — ZoMiner had only the `<python> <server.py>` shape, and
 * there are three today.
 */

import { runtimeClient } from "./client";
import { getRuntimePref, servicePort } from "./settings";
import { resolveLaunchPlan, runtimeHome, type LaunchPlan } from "./launch";
import type { HealthResponse } from "./contracts";

/**
 * Upper bound on waiting for the health check after start. MinerU's first model
 * load is slow, so 60s is not generous.
 */
const STARTUP_TIMEOUT_S = 60;

let process: any = null;
let startedByPlugin = false;
let lastPlan: LaunchPlan | null = null;

function startProcess(): void {
  // Pass the port to the child explicitly instead of letting it read config.json:
  // if each side reads its own, the service runs happily on one port while the
  // add-on waits forever for a health check on another.
  const plan = resolveLaunchPlan(servicePort());

  const child = Components.classes["@mozilla.org/process/util;1"]
    .createInstance(Components.interfaces.nsIProcess);
  child.init(plan.executable);
  // runw avoids a console window on Windows; Unix makes no such distinction.
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

/** Health check; null on failure — callers care whether it works, not why not. */
export async function health(): Promise<HealthResponse | null> {
  try {
    return await runtimeClient.health();
  } catch (error) {
    return null;
  }
}

/**
 * Read the last few lines of server.log.
 *
 * When the process exits immediately after starting, this file holds the only
 * diagnostic; without it the user sees "the service exited immediately after
 * starting", which says nothing.
 *
 * Both candidate locations are tried: the new runtime writes under the runtime
 * home, while ZoMiner's old server.py wrote next to the script. Guessing wrong
 * costs exactly this function's entire reason to exist.
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
  /** Show a failure message. Injected by the caller: process management should
   *  not decide the UI. */
  reportError(message: string): void;
}

/**
 * Ensure the runtime is available: return immediately if it is already running,
 * otherwise try to start it as configured.
 *
 * Returns a boolean rather than throwing: the correct behaviour for callers (the
 * conversion and annotation commands) when the service is unavailable is to stop
 * quietly. The user has already been told through reportError, and throwing again
 * would only duplicate the message.
 */
export async function ensure({ reportError }: EnsureOptions): Promise<boolean> {
  if (await health()) { return true; }

  if (!getRuntimePref("autoStart")) {
    reportError(
      "The local conversion service is not running.\nRun: unizero-runtime\n" +
      "(or enable automatic start under Settings → UniZero → Local service)",
    );
    return false;
  }

  const progress = new Zotero.ProgressWindow({ closeOnClick: false });
  progress.changeHeadline("UniZero");
  const line = new progress.ItemProgress("", "Starting the local conversion service…");
  line.setProgress(30);
  progress.show();

  try {
    startProcess();
  } catch (error) {
    progress.close();
    reportError(`Could not start the local conversion service: ${(error as Error).message || error}`);
    return false;
  }

  for (let attempt = 0; attempt < STARTUP_TIMEOUT_S; attempt++) {
    await Zotero.Promise.delay(1000);
    if (await health()) {
      line.setProgress(100);
      line.setText("Service started");
      progress.startCloseTimer(1500);
      return true;
    }
    // If the process is already dead, do not wait out the full 60s — the failure
    // can be reported now.
    if (process && !process.isRunning) {
      progress.close();
      const tail = await readLogTail();
      let message = "The conversion service exited immediately after starting.\n";
      message += `Launch mode [${lastPlan?.mode}]: ${lastPlan?.description}\n`;
      message += tail
        ? `\nEnd of server.log:\n${tail}`
        : "\nCheck that this Python has unizero-runtime and its dependencies " +
          "(including mineru) installed.";
      reportError(message);
      process = null;
      startedByPlugin = false;
      return false;
    }
  }

  progress.close();
  reportError(
    `The conversion service timed out on startup (${STARTUP_TIMEOUT_S}s).\n` +
    `Launch mode [${lastPlan?.mode}]: ${lastPlan?.description}\n` +
    `Check server.log under ${runtimeHome()}.`,
  );
  return false;
}

/** Stop deliberately: ask for a graceful shutdown first, then kill as a fallback. */
export async function stop(): Promise<void> {
  try {
    await runtimeClient.shutdown();
  } catch (error) {
    // The service may already be gone, or was never started by us.
  }
  await Zotero.Promise.delay(700);
  try {
    if (process && process.isRunning) { process.kill(); }
  } catch (error) {
    // The process has already exited.
  }
  process = null;
  startedByPlugin = false;
}

/**
 * Cleanup when the add-on is unloaded or Zotero shuts down.
 *
 * Only kills processes we started ourselves: a service the user launched by hand
 * should not disappear because Zotero closed. Nothing here may await — the
 * shutdown hook is synchronous, so asynchronous cleanup is simply discarded.
 */
export function stopOnShutdown(): void {
  if (!startedByPlugin || !getRuntimePref("autoStopOnQuit")) { return; }
  try {
    if (process && process.isRunning) { process.kill(); }
    ztoolkit.log("runtime stopped on shutdown");
  } catch (error) {
    // Already exited.
  }
  process = null;
  startedByPlugin = false;
}

export function isStartedByPlugin(): boolean {
  return startedByPlugin;
}
