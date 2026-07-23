/**
 * 决定"用什么命令把 paper runtime 拉起来"。
 *
 * ZoMiner 只有一种启动方式：`<python> <server.py>`，两个路径都要用户手填。runtime 现在
 * 是可安装包（console script `unizero-runtime`，以及 `python -m unizero_runtime`），
 * 于是绝大多数情况下这两个路径都能自己推出来。
 *
 * 解析顺序里有一条不可动摇：**用户显式配置永远优先于自动发现**。已经填了
 * serverScript 的用户（包括从 ZoMiner 迁移过来、指向旧 paper_service/server.py 的）
 * 必须继续跑他们指定的那份，否则就是在背地里换掉他们的服务端。
 */

import { getRuntimePref } from "./settings";

/** 探测某个解释器是否装了指定模块时的超时，秒。 */
const PROBE_TIMEOUT_S = 3;

/** 装了本包就意味着 fastapi/uvicorn/pydantic/mineru 都在（它们是硬依赖）。 */
const RUNTIME_PACKAGE = "unizero_runtime";

/** legacy 脚本模式没有包可探，只能逐个查依赖。 */
const LEGACY_MODULES = ["fastapi", "uvicorn", "pydantic", "mineru"];

/** pip 生成的 console script 名，来自 pyproject.toml 的 [project.scripts]。 */
const CONSOLE_SCRIPT = "unizero-runtime";

export type LaunchMode = "module" | "console-script" | "legacy-script";

export interface LaunchPlan {
  mode: LaunchMode;
  /** nsIFile，实际被执行的那个文件。 */
  executable: any;
  args: string[];
  /** 日志与错误信息里用的可读描述。 */
  description: string;
  /** 仅 legacy-script 模式有值。日志位置的兜底查找需要它。 */
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
    // WindowsApps 里的是应用商店占位符，运行它只会弹出商店页面。
    if (!directory || (Zotero.isWin && /WindowsApps/i.test(directory))) { continue; }
    entries.push(directory);
  }
  return entries;
}

function join(directory: string, name: string): string {
  return directory + (Zotero.isWin ? "\\" : "/") + name;
}

/**
 * 过滤出真实存在的文件，并按路径去重。
 *
 * 去重不是洁癖：PATH 里出现重复目录很常见，而每个候选解释器最多要花 PROBE_TIMEOUT_S
 * 秒去探测，重复探同一个解释器就是白等 3 秒。
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
      // 路径语法在当前平台上非法，跳过。
    }
  }
  return found;
}

/**
 * 用候选解释器跑一句 import 探测。
 *
 * 比"文件存在"强得多的判据：PATH 上第一个 python 往往不是装了依赖的那个，
 * 而两者在文件系统层面看起来完全一样。
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

/** 用户填的是 python.exe 时优先换成 pythonw.exe：前者会常驻一个黑色控制台窗口。 */
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

/** PATH 上所有存在的解释器，按"更可能是对的那个"排序。 */
function pathPythons(): any[] {
  const candidates: string[] = [];
  for (const directory of pathEntries()) {
    // pythonw 在前：Windows 上它不带控制台窗口。Unix 上没有这个文件，自然跳过。
    for (const name of Zotero.isWin
      ? ["pythonw.exe", "python.exe"]
      : ["python3", "python"]) {
      candidates.push(join(directory, name));
    }
  }
  return existingFiles(candidates);
}

/** legacy 模式：venv 相对 server.py 的位置，见 services/paper-runtime/scripts/server.py。 */
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
      // isExecutable 在某些卷上会抛，别因此丢掉候选。
    }
    return file;
  }
  return null;
}

function normalizeScriptPath(script: string): string {
  // macOS/Linux 下常见手误：从别处粘贴绝对路径时漏了开头的 "/"
  if (!Zotero.isWin && /^Users\//.test(script)) { return `/${script}`; }
  return script;
}

/**
 * legacy：`<python> <script>`。
 *
 * 保留是因为迁移过来的 ZoMiner 用户的 serverScript 可能指向旧的
 * paper_service/server.py —— 那份脚本不认 --port，会静默忽略它，行为与迁移前一致。
 */
function legacyPlan(script: string, port: number): LaunchPlan {
  let scriptFile: any;
  try {
    scriptFile = localFile(script);
  } catch (error) {
    throw new Error(`server.py 路径无效: ${script}`);
  }
  if (!scriptFile.exists()) {
    throw new Error(
      `server.py 不存在: ${script}\n` +
      "请在 工具 → UniZero 面板 → 插件运行 中修改或清空 server.py 路径\n" +
      "（清空后会自动查找已安装的 unizero-runtime）",
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

  // 一个都没装全依赖时仍用第一个：让服务真的启动一次，失败信息比"找不到 Python"具体。
  if (candidates.length) {
    return {
      mode: "legacy-script",
      executable: candidates[0],
      args: [script, "--port", String(port)],
      description: `${candidates[0].path} ${script}`,
      scriptPath: script,
    };
  }
  throw new Error("找不到 Python（请在 UniZero 面板中设置 Python 路径）");
}

/**
 * 解析启动方式。失败时抛出的信息要能直接指导用户下一步做什么。
 */
export function resolveLaunchPlan(port: number): LaunchPlan {
  const script = String(getRuntimePref("serverScript") || "").trim();
  if (script) { return legacyPlan(normalizeScriptPath(script), port); }

  const portArgs = ["--port", String(port)];

  // 用户指定了解释器：只认这一个，装没装包都用它——显式配置不该被自动发现绕过。
  const explicit = configuredPython();
  if (explicit) {
    return {
      mode: "module",
      executable: explicit,
      args: ["-m", RUNTIME_PACKAGE, ...portArgs],
      description: `${explicit.path} -m ${RUNTIME_PACKAGE}`,
    };
  }

  // PATH 上装了本包的解释器。放在 console script 前面：Windows 上这条能选到
  // pythonw.exe，而 pip 生成的 unizero-runtime.exe 是控制台程序，会留一个黑窗口。
  for (const file of pathPythons()) {
    if (!pythonHasModules(file, [RUNTIME_PACKAGE])) { continue; }
    return {
      mode: "module",
      executable: file,
      args: ["-m", RUNTIME_PACKAGE, ...portArgs],
      description: `${file.path} -m ${RUNTIME_PACKAGE}`,
    };
  }

  // console script 自带绝对解释器路径，所以在 venv 未激活、python 不在 PATH 上时
  // 反而是唯一能用的入口（pipx 安装就是这种形态）。
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
    "找不到 paper runtime。\n\n" +
    "请任选一种：\n" +
    "· 安装 runtime 后重试：在 services/paper-runtime 下执行\n" +
    "  uv venv --python 3.12 && uv pip install -e .\n" +
    "· 在 工具 → UniZero 面板 → 插件运行 中填写 Python 路径\n" +
    "  （指向已装 unizero-runtime 的解释器，例如 .venv/Scripts/pythonw.exe）\n" +
    "· 或填写 server.py 路径，指向 services/paper-runtime/scripts/server.py",
  );
}

/**
 * runtime 存放可变状态的目录，与 services/paper-runtime/.../paths.py 保持一致。
 *
 * 这里必须重复实现一遍：add-on 读不到 Python 侧的代码，而它需要知道 server.log 在哪
 * 才能在启动失败时给出具体原因。两边任一改动都要同时改另一边。
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
