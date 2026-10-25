/**
 * Canvas capture: MarginNote-style excerpting into Canvas text Cards. Everything
 * is registered through the plugin, so unloading it releases all of it.
 */

import { EditorView, type ViewUpdate } from "@codemirror/view";
import { clipboard } from "electron";
import { ItemView, Notice, editorInfoField } from "obsidian";
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
  editor: "Editing Card auto capture",
  selected: "Selected Card paste and drop",
  off: "Off",
};

const STATUS_LABELS: Record<CaptureMode, string> = {
  editor: "Capture: Editing Card",
  selected: "Capture: Selected Card",
  off: "Capture: Off",
};

const POLL_INTERVAL = 800;

export function isCaptureMode(value: unknown): value is CaptureMode {
  return CAPTURE_MODES.includes(value as CaptureMode);
}

export class CanvasCapture {
  private lastClipboardText = "";
  private activeCardEditor: EditorView | null = null;
  private pollTimer: number | null = null;
  private statusBarItem: HTMLElement | null = null;

  constructor(private readonly plugin: UnizeroPlugin) {}

  get mode(): CaptureMode {
    return this.plugin.settings.captureMode;
  }

  register(): void {
    const { plugin } = this;

    plugin.registerEditorExtension(EditorView.updateListener.of((update) => {
      this.rememberCardEditor(update);
    }));
    plugin.registerDomEvent(document, "paste", (event) => this.handlePaste(event), true);
    plugin.registerDomEvent(document, "drop", (event) => this.handleDrop(event), true);
    plugin.registerDomEvent(document, "copy", () => this.ignoreOwnCopy());
    plugin.registerDomEvent(document, "cut", () => this.ignoreOwnCopy());
    plugin.register(() => this.stopPolling());
    this.syncPolling();

    this.statusBarItem = plugin.addStatusBarItem();
    this.statusBarItem.setAttribute("aria-label", "UniZero Canvas capture: click to switch mode");
    this.statusBarItem.addClass("mod-clickable");
    plugin.registerDomEvent(this.statusBarItem, "click", () => { void this.cycleMode(); });
    this.updateStatusBar();

    for (const mode of CAPTURE_MODES) {
      plugin.addCommand({
        id: `capture-mode-${mode}`,
        name: `Canvas capture: ${mode === "off" ? "Turn off" : `Set mode: ${CAPTURE_MODE_LABELS[mode]}`}`,
        callback: () => { void this.setMode(mode); },
      });
    }
    plugin.addCommand({
      id: "capture-cycle-mode",
      name: "Canvas capture: Cycle mode",
      callback: () => { void this.cycleMode(); },
    });
    plugin.addCommand({
      id: "capture-show-status",
      name: "Canvas capture: Show status",
      callback: () => {
        const editor = this.usableCardEditor()
          ? "an edited Card is remembered"
          : "no edited Card remembered yet";
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

  private updateStatusBar(): void {
    this.statusBarItem?.setText(STATUS_LABELS[this.mode]);
  }

  // --- Editing Card auto capture -----------------------------------------

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

  private rememberCardEditor(update: ViewUpdate): void {
    let info: CanvasEditorInfo;
    try {
      info = update.state.field(editorInfoField) as unknown as CanvasEditorInfo;
    } catch {
      return;
    }
    if (info?.node && update.view.hasFocus) {
      this.activeCardEditor = update.view;
    }
  }

  // `activeElement`, unlike `hasFocus`, survives the window losing focus to Zotero.
  private usableCardEditor(): EditorView | null {
    const editor = this.activeCardEditor;
    if (!editor) { return null; }
    if (!editor.dom.isConnected) {
      this.activeCardEditor = null;
      return null;
    }
    const canvas = this.activeCanvasView();
    if (!canvas || !canvas.containerEl.contains(editor.dom)) { return null; }
    return editor.dom.ownerDocument.activeElement === editor.contentDOM ? editor : null;
  }

  private pollClipboard(): void {
    try {
      const text = clipboard.readText();
      if (!text || text === this.lastClipboardText) { return; }
      this.lastClipboardText = text;

      const excerpt = parseZoteroExcerpt(text);
      if (!excerpt) { return; }

      const editor = this.usableCardEditor();
      if (!editor) {
        new Notice("UniZero: Zotero annotation copied, but no Canvas Card is being edited.");
        return;
      }

      const insert = `\n${formatExcerpt(excerpt)}\n`;
      const { from, to } = editor.state.selection.main;
      editor.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      new Notice("UniZero: excerpt inserted into the edited Canvas Card.");
    } catch (error) {
      console.error("UniZero: Canvas capture", error);
      new Notice("UniZero: could not insert into the Canvas Card; see the developer console.");
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
