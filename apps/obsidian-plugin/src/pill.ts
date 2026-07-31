/**
 * The inline citation element.
 *
 * One implementation serves both renderers. Reading mode wraps it in a
 * `MarkdownRenderChild`; live preview wraps it in a CodeMirror widget. Neither
 * owns how a pill looks, because a citation that renders differently depending on
 * which mode the pane happens to be in is worse than one that renders plainly in
 * both.
 *
 * A pill is created in its unresolved state and updated in place. It never blocks
 * on the bridge: an editor that stalls while Zotero starts up would be far more
 * disruptive than a label that fills in a moment later.
 */

import {
  paperRefKey,
  type CitationAction,
  type CitationToken,
  type PaperRef,
} from "./citation";
import type { BridgePaper } from "./bridge";
import type { PaperState, PaperStore } from "./paperStore";
import type { PillLabel, UnizeroSettings } from "./settings";

export interface PillHost {
  readonly store: PaperStore;
  readonly settings: UnizeroSettings;
  /** Left click: run the action the syntax names. */
  activate(action: CitationAction, ref: PaperRef, paper: BridgePaper): void;
  /** Right click: offer every action, whichever form was written. */
  showMenu(event: MouseEvent, ref: PaperRef, paper: BridgePaper): void;
}

const ACTION_MARK: Record<CitationAction, string> = {
  detail: "",
  markdown: "MD",
  pdf: "PDF",
};

function surname(author: string): string {
  const parts = String(author || "").trim().split(/\s+/);
  return parts[parts.length - 1] || author;
}

function shortLabel(paper: BridgePaper, style: PillLabel): string {
  if (style === "itemKey") {
    return `@${paper.libraryID}/${paper.itemKey}`;
  }
  if (style === "title") {
    return paper.title || `@${paper.libraryID}/${paper.itemKey}`;
  }

  const authors = paper.authors.filter(Boolean);
  const lead = authors.length ? surname(authors[0]) : "";
  const credit = !lead
    ? ""
    : authors.length === 1
      ? lead
      : authors.length === 2
        ? `${lead} & ${surname(authors[1])}`
        : `${lead} et al.`;

  if (credit && paper.year) { return `${credit} (${paper.year})`; }
  if (credit) { return credit; }
  return paper.title || `@${paper.libraryID}/${paper.itemKey}`;
}

function tooltip(paper: BridgePaper, action: CitationAction): string {
  const lines = [paper.title].filter(Boolean) as string[];
  const credit = [paper.authors.join(", "), paper.year].filter(Boolean).join(" · ");
  if (credit) { lines.push(credit); }
  if (paper.venue) { lines.push(paper.venue); }
  lines.push(`@${paper.libraryID}/${paper.itemKey}`);
  if (paper.citekey) { lines.push(`citekey ${paper.citekey}`); }
  if (paper.ambiguous) {
    lines.push("More than one item derives this citekey — pin it in Zotero's Extra field.");
  }
  lines.push(action === "markdown"
    ? "Click to open the Markdown note"
    : action === "pdf"
      ? "Click to open the PDF in Zotero"
      : "Click for references and metadata");
  return lines.join("\n");
}

/**
 * Build a pill and keep it in step with the store.
 *
 * Returns the element and the teardown its host must call. Subscribing is what
 * starts the load, so a pill that is never attached costs nothing.
 */
export function createPill(
  host: PillHost,
  token: CitationToken,
): { element: HTMLSpanElement; destroy: () => void } {
  const ref: PaperRef = { libraryID: token.libraryID, itemKey: token.itemKey };
  const element = document.createElement("span");
  element.addClass("unizero-pill");
  element.dataset.ref = paperRefKey(ref);
  element.dataset.action = token.action;

  const label = element.createSpan({ cls: "unizero-pill__label" });
  const mark = ACTION_MARK[token.action];
  if (mark) {
    element.createSpan({ cls: "unizero-pill__mark", text: mark });
  }

  let paper: BridgePaper | undefined;

  const render = (state: PaperState) => {
    element.removeClass(
      "unizero-pill--loading",
      "unizero-pill--ready",
      "unizero-pill--missing",
      "unizero-pill--error",
    );

    if (state.status === "ready") {
      paper = state.paper;
      element.addClass("unizero-pill--ready");
      element.toggleClass("unizero-pill--ambiguous", state.paper.ambiguous);
      label.setText(shortLabel(state.paper, host.settings.pillLabel));
      element.setAttr("aria-label", tooltip(state.paper, token.action));
      return;
    }

    paper = undefined;
    // Every unresolved state keeps the written address visible. The label is the
    // only thing linking the pill back to the text the user wrote.
    label.setText(`@${paperRefKey(ref)}`);

    if (state.status === "loading") {
      element.addClass("unizero-pill--loading");
      element.setAttr("aria-label", `Resolving @${paperRefKey(ref)}…`);
    } else if (state.status === "missing") {
      element.addClass("unizero-pill--missing");
      element.setAttr("aria-label", `No Zotero item at @${paperRefKey(ref)}`);
    } else {
      element.addClass("unizero-pill--error");
      element.setAttr("aria-label", `@${paperRefKey(ref)}: ${state.message}`);
    }
  };

  const unsubscribe = host.store.subscribe(ref, render);

  const onClick = (event: MouseEvent) => {
    if (!paper) { return; }
    event.preventDefault();
    event.stopPropagation();
    host.activate(token.action, ref, paper);
  };

  const onContextMenu = (event: MouseEvent) => {
    if (!paper) { return; }
    event.preventDefault();
    event.stopPropagation();
    host.showMenu(event, ref, paper);
  };

  element.addEventListener("click", onClick);
  element.addEventListener("contextmenu", onContextMenu);

  return {
    element,
    destroy() {
      element.removeEventListener("click", onClick);
      element.removeEventListener("contextmenu", onContextMenu);
      unsubscribe();
    },
  };
}
