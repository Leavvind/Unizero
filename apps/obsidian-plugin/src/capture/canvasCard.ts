/**
 * The undocumented slice of Obsidian's Canvas runtime that capture touches.
 *
 * Canvas has no public API for its nodes, so every member here is optional and
 * checked before use; a Card that offers neither writer is reported, not guessed at.
 */

import type { ItemView } from "obsidian";
import { formatIncomingText } from "./excerpt";

export interface CanvasTextCardData {
  id?: string;
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface CanvasTextCard {
  id?: string;
  nodeEl?: HTMLElement;
  containerEl?: HTMLElement;
  contentEl?: HTMLElement;
  getData?: () => CanvasTextCardData | Record<string, unknown>;
  setData?: (data: CanvasTextCardData, addHistory?: boolean) => void;
  setText?: (text: string) => void;
}

export interface CanvasRuntime {
  selection?: Set<unknown>;
  requestSave?: () => void;
}

export interface CanvasView extends ItemView {
  canvas?: CanvasRuntime;
}

/** What `editorInfoField` holds for an editor inside a Canvas text Card. */
export interface CanvasEditorInfo {
  node?: CanvasTextCard;
}

export interface SelectedCardContext {
  canvas: CanvasRuntime;
  card: CanvasTextCard;
  data: CanvasTextCardData;
  document: Document;
}

export type AppendStatus = "inserted" | "ignored" | "unsupported" | "error";

/** Append text, normalized when it is a Zotero annotation, to the end of a Card. */
export function appendToTextCard(context: SelectedCardContext, incomingText: string): AppendStatus {
  const { canvas, card, data } = context;
  const prepared = formatIncomingText(incomingText);
  if (!prepared) { return "ignored"; }

  const nextText = appendWithLineBreak(data.text, prepared);
  try {
    if (typeof card.setData === "function") {
      card.setData({ ...data, text: nextText }, true);
    } else if (typeof card.setText === "function") {
      card.setText(nextText);
    } else {
      return "unsupported";
    }
    canvas.requestSave?.();
    return "inserted";
  } catch (error) {
    console.error("UniZero: append to selected Canvas Card", error);
    return "error";
  }
}

export function appendWithLineBreak(current: string, incoming: string): string {
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  return current + separator + incoming;
}

export function isTextCardData(data: Record<string, unknown> | null): data is CanvasTextCardData {
  return data?.type === "text" && typeof data.text === "string";
}

export function getCardElement(card: CanvasTextCard, document: Document): HTMLElement | null {
  for (const key of ["nodeEl", "containerEl", "contentEl"] as const) {
    const candidate = card[key];
    if (!candidate?.closest) { continue; }
    if (candidate.matches(".canvas-node")) { return candidate; }
    const cardElement = candidate.closest<HTMLElement>(".canvas-node");
    if (cardElement) { return cardElement; }
  }
  if (!card.id) { return null; }
  return document.querySelector<HTMLElement>(
    `.canvas-node[data-node-id="${CSS.escape(card.id)}"]`,
  );
}
