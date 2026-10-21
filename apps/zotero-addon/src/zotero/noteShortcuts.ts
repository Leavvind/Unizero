/**
 * Selection shortcuts in the note editor (see `src/notes/editShortcuts.ts`): highlight
 * the selection in a color, or clear its formatting.
 *
 * The editor core already has what is needed: its `highlightColor` plugin's `setColor`
 * acts on the selection, and clearing removes every mark but links through a
 * ProseMirror transaction. The core is reached through `wrappedJSObject`, like the
 * editor probe does, so nothing is injected into the page; the listener sits on the
 * iframe's document and `detachShortcuts` removes it. Every reach into the core is
 * guarded: it is a private structure that Zotero can change.
 */

import { EDIT_SHORTCUTS_PREF, HIGHLIGHT_COLORS, editAction, type EditAction } from "../notes/editShortcuts";
import { editorCore } from "./noteNavigation";

/** Marks that carry a target rather than formatting, so clearing keeps them. */
const KEPT_MARKS = new Set(["link"]);

const disposers = new WeakMap<Document, () => void>();

/** Turn the shortcuts on in this editor window. Replaces any it already has. */
export function attachShortcuts(win: Window): void {
  detachShortcuts(win);
  if (!Zotero.Prefs.get(EDIT_SHORTCUTS_PREF)) { return; }
  const doc = win.document;

  const onKeyDown = (event: KeyboardEvent) => {
    // The switch is read per key, so turning it off takes effect in open notes.
    if (event.isComposing || !Zotero.Prefs.get(EDIT_SHORTCUTS_PREF)) { return; }
    const action = editAction(event, Zotero.isMac);
    if (!action) { return; }
    // Taken keys must not also reach the editor.
    event.preventDefault();
    event.stopPropagation();
    // A held key repeats; one press is one edit.
    if (event.repeat) { return; }
    apply(win, action);
  };

  doc.addEventListener("keydown", onKeyDown, true);
  disposers.set(doc, () => doc.removeEventListener("keydown", onKeyDown, true));
}

/** Turn the shortcuts off in this editor window, if they are on. */
export function detachShortcuts(win: Window): void {
  const doc = win.document;
  disposers.get(doc)?.();
  disposers.delete(doc);
}

/** Both actions need a selection; with only a caret they do nothing. */
function apply(win: Window, action: EditAction): void {
  const core = editorCore(win);
  try {
    const view = core?.view;
    if (!view || view.state.selection.empty) { return; }
    if (action.type === "highlight") {
      // The editor stores highlight colors with a 50% alpha suffix.
      core.pluginState.highlightColor.setColor(`${HIGHLIGHT_COLORS[action.color]}80`);
      return;
    }
    const { state } = view;
    const { from, to } = state.selection;
    const tr = state.tr;
    for (const name of Object.keys(state.schema.marks)) {
      if (!KEPT_MARKS.has(name)) { tr.removeMark(from, to, state.schema.marks[name]); }
    }
    if (tr.docChanged) { view.dispatch(tr); }
  } catch (error) {
    Zotero.debug(`UniZero: note shortcut ${action.type} failed: ${error}`);
  }
}

/** What the shortcuts rely on in the editor core, for the editor probe. */
export function describeShortcutHandles(win: Window): Record<string, unknown> {
  const core = editorCore(win);
  try {
    return {
      setColor: typeof core?.pluginState?.highlightColor?.setColor,
      marks: Object.keys(core?.view?.state?.schema?.marks ?? {}),
    };
  } catch (error) {
    return { error: String(error) };
  }
}
