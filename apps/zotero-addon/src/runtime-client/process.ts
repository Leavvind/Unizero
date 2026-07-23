/**
 * Local process management for the paper runtime.
 *
 * Ported from ZoMiner's `modules/service.js`. Choosing the launch command now
 * lives in launch.ts — ZoMiner had only the `<python> <server.py>` shape, and
 * there are three today.
 *
 * The service's lifetime follows Zotero's: startInBackground() brings it up shortly
 * after a main window loads, stopOnShutdown() takes it down on quit. Nothing here
 * shows the user a service to operate — that was the panel's Service status card, and
 * a service that manages itself does not need one.
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

/**
 * Delay before the automatic start that follows Zotero's own startup.
 *
 * Resolving the launch plan runs synchronous interpreter probes (see launch.ts) that
 * block the UI thread for as long as the probed Python takes to boot. Paying that
 * during Zotero's first paint would be felt as a freeze; nothing needs the service
 * earlier, because the soonest anything can ask for it is a click away.
 */
const AUTO_START_DELAY_MS = 4000;

let process: any = null;
let startedByPlugin = false;
let lastPlan: LaunchPlan | null = null;

/** A start attempt in flight. Concurrent callers join it rather than spawning twice. */
let pendingStart: Promise<StartOutcome> | null = null;

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
  /**
   * Show the "Starting…" progress window while waiting. On by default, because a
   * start the user triggered has to look like it is happening; off for the automatic
   * background start, which nobody asked for and must not interrupt anything.
   */
  showProgress?: boolean;
}

interface StartOutcome {
  ok: boolean;
  /** Set only on failure; already phrased for the user. */
  message?: string;
}

/**
 * Spawn the process and wait for it to answer a health check.
 *
 * Deliberately free of UI so it can be shared: whoever asked for the start reports
 * the outcome in whatever way suits them, and a second caller arriving mid-start
 * joins this promise instead of launching a rival process.
 */
async function startAndWait(): Promise<StartOutcome> {
  try {
    startProcess();
  } catch (error) {
    return {
      ok: false,
      message: `Could not start the local conversion service: ${(error as Error).message || error}`,
    };
  }

  try {
    for (let attempt = 0; attempt < STARTUP_TIMEOUT_S; attempt++) {
      await Zotero.Promise.delay(1000);
      if (await health()) { return { ok: true }; }
      // If the process is already dead, do not wait out the full 60s — the failure
      // can be reported now.
      if (process && !process.isRunning) {
        const tail = await readLogTail();
        let message = "The conversion service exited immediately after starting.\n";
        message += `Launch mode [${lastPlan?.mode}]: ${lastPlan?.description}\n`;
        message += tail
          ? `\nEnd of server.log:\n${tail}`
          : "\nCheck that this Python has unizero-runtime and its dependencies " +
            "(including mineru) installed.";
        process = null;
        startedByPlugin = false;
        return { ok: false, message };
      }
    }
  } catch (error) {
    return { ok: false, message: `Waiting for the conversion service failed: ${error}` };
  }

  return {
    ok: false,
    message:
      `The conversion service timed out on startup (${STARTUP_TIMEOUT_S}s).\n` +
      `Launch mode [${lastPlan?.mode}]: ${lastPlan?.description}\n` +
      `Check server.log under ${runtimeHome()}.`,
  };
}

/** The "Starting…" window, as the two states ensure() actually needs from it. */
function startingProgress() {
  const progress = new Zotero.ProgressWindow({ closeOnClick: false });
  progress.changeHeadline("UniZero");
  const line = new progress.ItemProgress("", "Starting the local conversion service…");
  line.setProgress(30);
  progress.show();
  return {
    started(): void {
      line.setProgress(100);
      line.setText("Service started");
      progress.startCloseTimer(1500);
    },
    close(): void {
      progress.close();
    },
  };
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
export async function ensure({
  reportError,
  showProgress = true,
}: EnsureOptions): Promise<boolean> {
  if (await health()) { return true; }

  if (!getRuntimePref("autoStart")) {
    reportError(
      "The local conversion service is not running.\nRun: unizero-runtime\n" +
      "(or turn automatic start back on under Settings → UniZero → Local service)",
    );
    return false;
  }

  const progress = showProgress ? startingProgress() : null;
  if (!pendingStart) {
    const attempt = startAndWait();
    pendingStart = attempt;
    // Cleared on completion, not before: until then every caller has to join this
    // attempt. The identity check keeps a late completion from clearing a newer one.
    void attempt.then(() => {
      if (pendingStart === attempt) { pendingStart = null; }
    });
  }

  const outcome = await pendingStart;
  if (outcome.ok) {
    progress?.started();
    return true;
  }
  progress?.close();
  reportError(outcome.message || "The local conversion service could not be started.");
  return false;
}

/**
 * Start the service in the background, as Zotero comes up.
 *
 * Silent throughout: no progress window, and a failure goes wherever the caller's
 * reportError puts it — the panel's Jobs list — rather than into a dialog over a
 * session that may have nothing to do with conversion. Doing nothing when automatic
 * start is off is the whole meaning of that preference.
 */
export async function startInBackground(options: EnsureOptions): Promise<void> {
  if (!getRuntimePref("autoStart")) { return; }
  await Zotero.Promise.delay(AUTO_START_DELAY_MS);
  // A second main window opening must not start a second service: ensure() joins an
  // attempt already in flight, and its health check covers a service already up.
  await ensure({ ...options, showProgress: false });
}

/**
 * Cleanup when the add-on is unloaded or Zotero shuts down. The only way the service
 * is ever stopped, now that the panel has no Stop button.
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
