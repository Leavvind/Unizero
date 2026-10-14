/**
 * Annotation tools in the note editor: `Alt+1` highlight, with `1`–`4` picking a color
 * and selecting text with the mouse applying it; `Alt+2` eraser, which clears the colors
 * of the selection, or of the colored run that is clicked; `Esc` leaves the tool. The
 * keys mirror the PDF reader's.
 *
 * The editor core already has the commands: its color plugins expose `setColor` and
 * `removeColor`, which act on the current selection. They are reached through
 * `wrappedJSObject`, like the editor probe does, so nothing is injected into the page;
 * the listeners sit on the iframe's document and `detachTools` removes them. Every
 * reach into the core is guarded: it is a private structure that Zotero can change.
 */

import { config } from "../../package.json";
import { TOOL_COLORS, toolAction, type ToolName } from "../notes/noteTools";
import { editorRoot } from "./noteNavigation";

const BADGE_ID = `${config.addonRef}-note-tool`;
const STYLE_ID = `${config.addonRef}-note-tools-style`;
const ATTRIBUTE = "data-uz-tool";
/** Selection state in the editor lags the DOM selection a little after a mouse-up. */
const APPLY_ATTEMPTS_MS = [0, 40, 120];
const ERASE_DELAY_MS = 60;
const TOOL_LABEL: Record<ToolName, string> = { highlight: "Highlight", erase: "Erase" };
const TOOL_HINT: Record<ToolName, string> = {
  highlight: `1–${TOOL_COLORS.length} color · Esc exit`,
  erase: "select or click to clear · Esc exit",
};
/** What the eraser takes off: every mark that carries a color. */
const CLEARED_PLUGINS = ["highlightColor", "underlineColor", "textColor"];

/** Master switch for the tools. */
export const TOOLS_PREF = `${config.addonRef}.noteEditor.tools`;

const disposers = new WeakMap<Document, () => void>();

/** Turn the tools on in this editor window. Replaces any it already has. */
export function attachTools(win: Window, css: string): void {
  detachTools(win);
  if (!Zotero.Prefs.get(TOOLS_PREF)) { return; }
  const doc = win.document;
  const parent = doc.body;
  if (!parent) { return; }

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  (doc.head || doc.documentElement).appendChild(style);

  const badge = doc.createElement("div");
  badge.id = BADGE_ID;
  badge.hidden = true;
  const swatch = doc.createElement("span");
  swatch.className = "uz-tool-swatch";
  const name = doc.createElement("span");
  name.className = "uz-tool-name";
  const hint = doc.createElement("span");
  hint.className = "uz-tool-hint";
  badge.append(swatch, name, hint);
  parent.appendChild(badge);

  let tool: ToolName | undefined;
  let colorIndex = 0;
  let timers: number[] = [];

  const render = () => {
    badge.hidden = !tool;
    if (tool) { doc.documentElement.setAttribute(ATTRIBUTE, tool); } else { doc.documentElement.removeAttribute(ATTRIBUTE); }
    swatch.hidden = tool !== "highlight";
    swatch.style.background = TOOL_COLORS[colorIndex].value;
    name.textContent = !tool ? "" : tool === "highlight" ? `${TOOL_LABEL[tool]} · ${TOOL_COLORS[colorIndex].name}` : TOOL_LABEL[tool];
    hint.textContent = tool ? TOOL_HINT[tool] : "";
  };

  const cancelTimers = () => { timers.forEach((timer) => win.clearTimeout(timer)); timers = []; };

  /** Apply the active color to the selection; false when there is nothing selected. */
  const applyColor = (): boolean => {
    if (tool !== "highlight") { return false; }
    const core = editorCore(win);
    try {
      if (!core || core.view.state.selection.empty) { return false; }
      core.pluginState.highlightColor.setColor(TOOL_COLORS[colorIndex].value);
      return true;
    } catch (error) {
      Zotero.debug(`UniZero: note tool could not apply a color: ${error}`);
      return false;
    }
  };

  /** With a selection this clears it; with a caret, the colored run the caret is in. */
  const clearColors = () => {
    const core = editorCore(win);
    try {
      if (!core) { return; }
      for (const plugin of CLEARED_PLUGINS) { core.pluginState[plugin].removeColor(); }
    } catch (error) {
      Zotero.debug(`UniZero: note tool could not clear colors: ${error}`);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) { return; }
    const action = toolAction(event, tool);
    if (!action) { return; }
    // Taken keys must not also reach the editor, or a digit would be typed.
    event.preventDefault();
    event.stopPropagation();
    switch (action.type) {
      case "tool":
        tool = tool === action.tool ? undefined : action.tool;
        break;
      case "color":
        colorIndex = action.index;
        applyColor();
        break;
      case "exit":
        tool = undefined;
        break;
    }
    render();
  };

  const onMouseUp = (event: MouseEvent) => {
    if (!tool || event.button !== 0) { return; }
    const root = editorRoot(win);
    if (!root || !root.contains(event.target as Node)) { return; }
    cancelTimers();
    if (tool === "erase") {
      timers.push(win.setTimeout(clearColors, ERASE_DELAY_MS));
      return;
    }
    if (win.getSelection()?.isCollapsed) { return; }
    APPLY_ATTEMPTS_MS.forEach((delay) => {
      timers.push(win.setTimeout(() => {
        if (timers.length && applyColor()) { cancelTimers(); }
      }, delay));
    });
  };

  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("mouseup", onMouseUp, true);
  render();

  disposers.set(doc, () => {
    cancelTimers();
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("mouseup", onMouseUp, true);
    badge.remove();
    style.remove();
    doc.documentElement.removeAttribute(ATTRIBUTE);
  });
}

/** Turn the tools off in this editor window, if they are on. */
export function detachTools(win: Window): void {
  const doc = win.document;
  disposers.get(doc)?.();
  disposers.delete(doc);
}

/** What the editor core offers for colors, for the editor probe. */
export function describeColorPlugins(win: Window): Record<string, string> {
  const report: Record<string, string> = {};
  const core = editorCore(win);
  for (const plugin of CLEARED_PLUGINS) {
    const state = core?.pluginState?.[plugin];
    report[plugin] = `${typeof state?.setColor}/${typeof state?.removeColor}`;
  }
  return report;
}

/** The editor core inside the iframe: a private structure, so callers must expect it to be missing. */
function editorCore(win: Window): any {
  try {
    return (win as any).wrappedJSObject?._currentEditorInstance?._editorCore;
  } catch {
    return undefined;
  }
}
