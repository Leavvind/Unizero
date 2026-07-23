/**
 * Decide what command starts the paper runtime.
 *
 * ZoMiner had exactly one launch mode, `<python> <server.py>`, with both paths
 * typed in by the user. The runtime is now an installable package (console script
 * `unizero-runtime`, plus `python -m unizero_runtime`), so in the vast majority of
 * cases both paths can be inferred.
 *
 * One rule in the resolution order is immovable: **an explicit user setting always
 * beats auto-discovery.** Users who have already filled in serverScript —
 * including those migrated from ZoMiner and still pointing at the old
 * paper_service/server.py — must keep running the file they named; anything else
 * swaps out their server behind their back.
 */

import { getRuntimePref } from "./settings";

/** Timeout, in seconds, when probing whether an interpreter has given modules. */
const PROBE_TIMEOUT_S = 3;

/**
 * Having this package installed implies fastapi/uvicorn/pydantic/mineru are too,
 * since they are hard dependencies.
 */
const RUNTIME_PACKAGE = "unizero_runtime";

/** Legacy script mode has no package to probe, so check dependencies one by one. */
const LEGACY_MODULES = ["fastapi", "uvicorn", "pydantic", "mineru"];

/** Name of the pip-generated console script, from [project.scripts] in pyproject.toml. */
const CONSOLE_SCRIPT = "unizero-runtime";

export type LaunchMode = "module" | "console-script" | "legacy-script";

export interface LaunchPlan {
  mode: LaunchMode;
  /** nsIFile: the file actually executed. */
  executable: any;
  args: string[];
  /** Human-readable description used in logs and error messages. */
  description: string;
  /** Set only in legacy-script mode; the log-location fallback search needs it. */
  scriptPath?: string;
}

export function localFile(path: string): any {
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

function pathEntries(): string[] {
  const separator = Zotero.isWin ? ";" : ":";
  const entries: string[] = [];
  for (let directory of environmentVariable("PATH").split(separator)) {
    directory = directory.trim();
    // Entries under WindowsApps are Store stubs; running one just opens the Store.
    if (!directory || (Zotero.isWin && /WindowsApps/i.test(directory))) { continue; }
    entries.push(directory);
  }
  return entries;
}

function join(directory: string, name: string): string {
  return directory + (Zotero.isWin ? "\\" : "/") + name;
}

/**
 * Keep only files that really exist, deduplicated by path.
 *
 * The deduplication is not fastidiousness: duplicate directories on PATH are
 * common, and probing each candidate interpreter can cost up to PROBE_TIMEOUT_S
 * seconds, so probing the same interpreter twice wastes three seconds.
 */
function existingFiles(paths: string[]): any[] {
  const found: any[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    try {
      const file = localFile(candidate);
      if (!file.exists() || !file.isFile()) { continue; }
      const key = file.path.toLowerCase();
      if (seen.has(key)) { continue; }
      seen.add(key);
      found.push(file);
    } catch (error) {
      // The path syntax is invalid on this platform; skip it.
    }
  }
  return found;
}

/**
 * Run a one-line import probe with a candidate interpreter.
 *
 * A far stronger test than "the file exists": the first python on PATH is often
 * not the one with the dependencies, and the two look identical at the filesystem
 * level.
 */
function pythonHasModules(pythonFile: any, modules: string[]): boolean {
  try {
    const probe = Components.classes["@mozilla.org/process/util;1"]
      .createInstance(Components.interfaces.nsIProcess);
    probe.init(pythonFile);
    const names = modules.map((name) => `'${name}'`).join(",");
    const code =
      "import importlib.util as u,sys;" +
      `sys.exit(0 if all(u.find_spec(m) for m in (${names},)) else 3)`;
    probe.run(true, ["-c", code], PROBE_TIMEOUT_S);
    return probe.exitValue === 0;
  } catch (error) {
    return false;
  }
}

/** When the user names python.exe, prefer pythonw.exe: the former leaves a console window open. */
function preferWindowless(path: string): string[] {
  if (/python\.exe$/i.test(path)) {
    return [path.replace(/python\.exe$/i, "pythonw.exe"), path];
  }
  return [path];
}

function configuredPython(): any {
  const preferred = String(getRuntimePref("pythonPath") || "").trim();
  if (!preferred) { return null; }
  const existing = existingFiles(preferWindowless(preferred));
  return existing.length ? existing[0] : null;
}

/** Every interpreter present on PATH, ordered by how likely it is to be the right one. */
function pathPythons(): any[] {
  const candidates: string[] = [];
  for (const directory of pathEntries()) {
    // pythonw first: on Windows it has no console window. On Unix the file does
    // not exist, so it is skipped naturally.
    for (const name of Zotero.isWin
      ? ["pythonw.exe", "python.exe"]
      : ["python3", "python"]) {
      candidates.push(join(directory, name));
    }
  }
  return existingFiles(candidates);
}

/** Legacy mode: the venv's location relative to server.py; see services/paper-runtime/scripts/server.py. */
function scriptRelativePythons(script: string): any[] {
  if (!script) { return []; }
  // <root>/scripts/server.py → <root>/.venv/
  const root = script.replace(/[\\/][^\\/]*[\\/][^\\/]*$/, "");
  const candidates = Zotero.isWin
    ? [`${root}\\.venv\\Scripts\\pythonw.exe`, `${root}\\.venv\\Scripts\\python.exe`]
    : [`${root}/.venv/bin/python3`, `${root}/.venv/bin/python`];
  return existingFiles(candidates);
}

function findConsoleScript(): any {
  const name = Zotero.isWin ? `${CONSOLE_SCRIPT}.exe` : CONSOLE_SCRIPT;
  const candidates = pathEntries().map((directory) => join(directory, name));
  for (const file of existingFiles(candidates)) {
    try {
      if (!Zotero.isWin && !file.isExecutable()) { continue; }
    } catch (error) {
      // isExecutable throws on some volumes; do not drop the candidate over it.
    }
    return file;
  }
  return null;
}

function normalizeScriptPath(script: string): string {
  // Common slip on macOS/Linux: an absolute path pasted from elsewhere lost its
  // leading "/".
  if (!Zotero.isWin && /^Users\//.test(script)) { return `/${script}`; }
  return script;
}

/**
 * Legacy: `<python> <script>`.
 *
 * Kept because a migrated ZoMiner user's serverScript may still point at the old
 * paper_service/server.py — that script does not know --port and silently ignores
 * it, which matches pre-migration behaviour.
 */
function legacyPlan(script: string, port: number): LaunchPlan {
  let scriptFile: any;
  try {
    scriptFile = localFile(script);
  } catch (error) {
    throw new Error(`Invalid server.py path: ${script}`);
  }
  if (!scriptFile.exists()) {
    throw new Error(
      `server.py does not exist: ${script}\n` +
      "Change or clear the server.py path under Settings → UniZero → Local service\n" +
      "(clearing it makes the add-on look for an installed unizero-runtime)",
    );
  }

  const explicit = configuredPython();
  const candidates = explicit
    ? [explicit]
    : [...scriptRelativePythons(script), ...pathPythons()];

  for (const file of candidates) {
    if (explicit || pythonHasModules(file, LEGACY_MODULES)) {
      return {
        mode: "legacy-script",
        executable: file,
        args: [script, "--port", String(port)],
        description: `${file.path} ${script}`,
        scriptPath: script,
      };
    }
  }

  // If none has the full dependency set, still use the first: actually starting
  // the service yields a more specific failure than "no Python found".
  if (candidates.length) {
    return {
      mode: "legacy-script",
      executable: candidates[0],
      args: [script, "--port", String(port)],
      description: `${candidates[0].path} ${script}`,
      scriptPath: script,
    };
  }
  throw new Error(
    "No Python found (set the Python path under Settings → UniZero → Local service)",
  );
}

/**
 * Resolve the launch mode. A thrown message must tell the user what to do next.
 */
export function resolveLaunchPlan(port: number): LaunchPlan {
  const script = String(getRuntimePref("serverScript") || "").trim();
  if (script) { return legacyPlan(normalizeScriptPath(script), port); }

  const portArgs = ["--port", String(port)];

  // The user named an interpreter: use only that one, package installed or not —
  // an explicit setting must not be bypassed by auto-discovery.
  const explicit = configuredPython();
  if (explicit) {
    return {
      mode: "module",
      executable: explicit,
      args: ["-m", RUNTIME_PACKAGE, ...portArgs],
      description: `${explicit.path} -m ${RUNTIME_PACKAGE}`,
    };
  }

  // An interpreter on PATH that has the package. Tried before the console script:
  // on Windows this path can pick pythonw.exe, whereas pip's unizero-runtime.exe
  // is a console program and leaves a black window behind.
  for (const file of pathPythons()) {
    if (!pythonHasModules(file, [RUNTIME_PACKAGE])) { continue; }
    return {
      mode: "module",
      executable: file,
      args: ["-m", RUNTIME_PACKAGE, ...portArgs],
      description: `${file.path} -m ${RUNTIME_PACKAGE}`,
    };
  }

  // The console script embeds an absolute interpreter path, so when no venv is
  // active and python is not on PATH it is the only usable entry point — which is
  // exactly what a pipx install looks like.
  const consoleScript = findConsoleScript();
  if (consoleScript) {
    return {
      mode: "console-script",
      executable: consoleScript,
      args: portArgs,
      description: consoleScript.path,
    };
  }

  throw new Error(
    "The paper runtime was not found.\n\n" +
    "Choose any one of these:\n" +
    "· Install the runtime and retry: from services/paper-runtime, run\n" +
    "  uv venv --python 3.12 && uv pip install -e .\n" +
    "· Set the Python path under Settings → UniZero → Local service\n" +
    "  (point it at an interpreter with unizero-runtime installed, e.g.\n" +
    "  .venv/Scripts/pythonw.exe)\n" +
    "· Or set the server.py path to services/paper-runtime/scripts/server.py",
  );
}

/**
 * Directory where the runtime keeps mutable state; kept in step with
 * services/paper-runtime/.../paths.py.
 *
 * The duplication is unavoidable: the add-on cannot read the Python side, yet it
 * needs to know where server.log is to explain a failed start. A change on either
 * side has to be made on both.
 */
export function runtimeHome(): string {
  const override = environmentVariable("UNIZERO_RUNTIME_HOME").trim();
  if (override) { return override; }

  if (Zotero.isWin) {
    const base = environmentVariable("LOCALAPPDATA") ||
      join(environmentVariable("USERPROFILE"), "AppData\\Local");
    return `${base}\\UniZero\\runtime`;
  }
  const xdg = environmentVariable("XDG_DATA_HOME").trim();
  const base = xdg || join(environmentVariable("HOME"), ".local/share");
  return `${base}/unizero/runtime`;
}
