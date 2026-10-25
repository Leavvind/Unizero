/**
 * Canvas capture: MarginNote-style excerpting into Canvas text Cards and Markdown
 * notes. Everything is registered through the plugin, so unloading it releases all of it.
 */

import { EditorView } from "@codemirror/view";
import { clipboard } from "electron";
import { ItemView, Menu, Notice, editorInfoField } from "obsidian";
import type UnizeroPlugin from "../main";
import {
  appendToTextCard,
  getCardElement,
  isTextCardData,
  type AppendStatus,
  type CanvasEditorInfo,
  type CanvasTextCard,
  type CanvasView,
  type SelectedCardContext,
} from "./canvasCard";
import { formatExcerpt, parseZoteroExcerpt } from "./excerpt";

export type CaptureMode = "editor" | "selected" | "off";

export const CAPTURE_MODES: readonly CaptureMode[] = ["editor", "selected", "off"];

export const CAPTURE_MODE_LABELS: Record<CaptureMode, string> = {
  editor: "Auto capture into the edited Card or note",
  selected: "Selected Card paste and drop",
  off: "Off",
};

const STATUS_LABELS: Record<CaptureMode, string> = {
  editor: "Capture: Auto",
  selected: "Capture: Selected Card",
  off: "Capture: Off",
};

const POLL_INTERVAL = 800;

export function isCaptureMode(value: unknown): value is CaptureMode {
  return CAPTURE_MODES.includes(value as CaptureMode);
}

export class CanvasCapture {
  private lastClipboardText = "";
  private pollTimer: number | null = null;
  private statusBarItem: HTMLElement | null = null;

  constructor(private readonly plugin: UnizeroPlugin) {}

  get mode(): CaptureMode {
    return this.plugin.settings.captureMode;
  }

  register(): void {
    const { plugin } = this;

    plugin.registerDomEvent(document, "paste", (event) => this.handlePaste(event), true);
    plugin.registerDomEvent(document, "drop", (event) => this.handleDrop(event), true);
    plugin.registerDomEvent(document, "copy", () => this.ignoreOwnCopy());
    plugin.registerDomEvent(document, "cut", () => this.ignoreOwnCopy());
    plugin.register(() => this.stopPolling());
    this.syncPolling();

    this.statusBarItem = plugin.addStatusBarItem();
    this.statusBarItem.setAttribute("aria-label", "UniZero Canvas capture: click to choose a mode");
    this.statusBarItem.addClass("mod-clickable");
    plugin.registerDomEvent(this.statusBarItem, "click", (event) => this.showModeMenu(event));
    this.updateStatusBar();

    for (const mode of CAPTURE_MODES) {
      plugin.addCommand({
        id: `capture-mode-${mode}`,
        name: `Canvas capture: ${mode === "off" ? "Turn off" : `Set mode: ${CAPTURE_MODE_LABELS[mode]}`}`,
        callback: () => { void this.setMode(mode); },
      });
    }
    plugin.addCommand({
      id: "capture-toggle-auto",
      name: "Canvas capture: Toggle auto capture",
      callback: () => { void this.setMode(this.mode === "editor" ? "off" : "editor"); },
    });
    plugin.addCommand({
      id: "capture-cycle-mode",
      name: "Canvas capture: Cycle mode",
      callback: () => { void this.cycleMode(); },
    });
    plugin.addCommand({
      id: "capture-show-status",
      name: "Canvas capture: Show status",
      callback: () => {
        const target = focusedEditor();
        const editor = target ? `editing ${targetName(target)}` : "no Card or note is being edited";
        new Notice(`UniZero Canvas capture: ${CAPTURE_MODE_LABELS[this.mode]}; ${editor}.`, 6000);
      },
    });
  }

  async setMode(mode: CaptureMode): Promise<void> {
    this.plugin.settings.captureMode = mode;
    this.syncPolling();
    await this.plugin.saveSettings("none");
    this.updateStatusBar();
    new Notice(`UniZero Canvas capture: ${CAPTURE_MODE_LABELS[mode]}.`);
  }

  private async cycleMode(): Promise<void> {
    const next = CAPTURE_MODES[(CAPTURE_MODES.indexOf(this.mode) + 1) % CAPTURE_MODES.length];
    await this.setMode(next);
  }

  private showModeMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const mode of CAPTURE_MODES) {
      menu.addItem((item) => item
        .setTitle(CAPTURE_MODE_LABELS[mode])
        .setChecked(mode === this.mode)
        .onClick(() => { void this.setMode(mode); }));
    }
    menu.showAtMouseEvent(event);
  }

  private updateStatusBar(): void {
    this.statusBarItem?.setText(STATUS_LABELS[this.mode]);
  }

  // --- Auto capture into the edited Card or note --------------------------

  private syncPolling(): void {
    if (this.mode !== "editor") {
      this.stopPolling();
      return;
    }
    if (this.pollTimer !== null) { return; }
    // Don't paste what was copied before the switch.
    this.lastClipboardText = clipboard.readText();
    this.pollTimer = window.setInterval(() => this.pollClipboard(), POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (this.pollTimer === null) { return; }
    window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private ignoreOwnCopy(): void {
    if (this.pollTimer === null) { return; }
    // The clipboard is written after the event's handlers have run.
    window.setTimeout(() => { this.lastClipboardText = clipboard.readText(); }, 0);
  }

  private pollClipboard(): void {
    try {
      const text = clipboard.readText();
      if (!text || text === this.lastClipboardText) { return; }
      this.lastClipboardText = text;

      const excerpt = parseZoteroExcerpt(text);
      if (!excerpt) { return; }

      const editor = focusedEditor();
      if (!editor) {
        new Notice("UniZero: Zotero annotation copied, but no Canvas Card or note is being edited.");
        return;
      }

      const insert = `\n${formatExcerpt(excerpt)}\n`;
      const { from, to } = editor.state.selection.main;
      editor.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      new Notice(`UniZero: excerpt inserted into ${targetName(editor)}.`);
    } catch (error) {
      console.error("UniZero: Canvas capture", error);
      new Notice("UniZero: could not insert the excerpt; see the developer console.");
    }
  }

  // --- Selected Card paste and drop --------------------------------------

  private handlePaste(event: ClipboardEvent): void {
    if (this.mode !== "selected") { return; }
    const target = asElement(event.target);
    if (isEditable(target)) { return; }

    const text = event.clipboardData?.getData("text/plain");
    if (!text) { return; }
    const context = this.singleSelectedTextCard();
    if (!context) { return; }
    // Only a paste aimed at the Canvas or at nothing in particular.
    const container = this.activeCanvasView()?.containerEl;
    if (target && target !== context.document.body && !container?.contains(target)) { return; }

    const status = appendToTextCard(context, text);
    if (status === "ignored") { return; }
    event.preventDefault();
    event.stopPropagation();
    reportAppend(status, "Pasted");
  }

  private handleDrop(event: DragEvent): void {
    if (this.mode !== "selected") { return; }
    if (event.dataTransfer?.files.length) { return; }

    const text = event.dataTransfer?.getData("text/plain");
    if (!text) { return; }
    const context = this.singleSelectedTextCard();
    if (!context) { return; }

    // Only a drop onto the selected Card itself; elsewhere Canvas makes a new Card.
    const dropCard = asElement(event.target)?.closest<HTMLElement>(".canvas-node");
    const selectedCard = getCardElement(context.card, context.document);
    if (!dropCard || !selectedCard || dropCard !== selectedCard) { return; }

    const status = appendToTextCard(context, text);
    if (status === "ignored") { return; }
    event.preventDefault();
    event.stopPropagation();
    reportAppend(status, "Dropped");
  }

  private activeCanvasView(): CanvasView | null {
    const view = this.plugin.app.workspace.getActiveViewOfType(ItemView);
    return view?.getViewType() === "canvas" ? view as CanvasView : null;
  }

  private singleSelectedTextCard(): SelectedCardContext | null {
    const view = this.activeCanvasView();
    if (!view?.canvas) { return null; }

    const selection = Array.from(view.canvas.selection ?? []);
    if (selection.length !== 1) { return null; }

    const card = selection[0] as CanvasTextCard;
    const data = (card.getData?.() ?? null) as Record<string, unknown> | null;
    if (!isTextCardData(data)) { return null; }

    return { canvas: view.canvas, card, data, document: view.containerEl.ownerDocument };
  }
}

/**
 * The Obsidian editor holding keyboard focus. Canvas renders each Card's editor
 * inside an iframe, so focus is followed down through frames. `activeElement`,
 * unlike `hasFocus`, survives the window losing focus to Zotero.
 */
function focusedEditor(): EditorView | null {
  let element = activeDocument.activeElement;
  while (element?.tagName === "IFRAME") {
    element = (element as HTMLIFrameElement).contentDocument?.activeElement ?? null;
  }
  if (!element?.classList.contains("cm-content")) { return null; }
  const editor = EditorView.findFromDOM(element as HTMLElement);
  // Only Obsidian's own note and Card editors carry editor info.
  return editor?.state.field(editorInfoField, false) ? editor : null;
}

function targetName(editor: EditorView): string {
  const info = editor.state.field(editorInfoField, false) as unknown as CanvasEditorInfo | undefined;
  return info?.node ? "the edited Canvas Card" : "the edited note";
}

function reportAppend(status: AppendStatus, action: "Pasted" | "Dropped"): void {
  if (status === "inserted") {
    new Notice(`UniZero: ${action} onto the end of the selected Canvas Card.`);
  } else if (status === "unsupported") {
    new Notice("UniZero: the selected Canvas Card offers no way to write its text.");
  } else if (status === "error") {
    new Notice(`UniZero: ${action.toLowerCase()} text could not be added; see the developer console.`);
  }
}

function isEditable(element: Element | null): boolean {
  if (!element) { return false; }
  if ((element as HTMLElement).isContentEditable) { return true; }
  return element.closest(".cm-editor, input, textarea, select, [contenteditable]:not([contenteditable='false']), .modal-container") !== null;
}

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === "function"
    ? (target as Element)
    : null;
}
