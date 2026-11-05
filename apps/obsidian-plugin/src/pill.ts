/** Legacy bare citations rendered as ordinary links; new Markdown labels are untouched. */

import {
  paperRefKey,
  type CitationAction,
  type CitationToken,
  type PaperRef,
} from "./citation";
import type { BridgePaper } from "./bridge";
import type { PaperState, PaperStore } from "./paperStore";
import type { UnizeroSettings } from "./settings";
import { paperLabel, serializeLinkTarget, type LinkTarget } from "./linkTarget";

export interface PillHost {
  readonly store: PaperStore;
  readonly settings: UnizeroSettings;
  openLink(target: LinkTarget): void;
  linkMenu(event: MouseEvent, target: LinkTarget): void;
  /** Left click: run the action the syntax names (`page` from `.pdf:{page}`). */
  activate(action: CitationAction, ref: PaperRef, paper: BridgePaper, page?: number): void;
  /** Right click: offer every action, whichever form was written. */
  showMenu(event: MouseEvent, ref: PaperRef, paper: BridgePaper): void;
}

export function createPill(
  host: PillHost,
  token: CitationToken,
): { element: HTMLAnchorElement; destroy: () => void } {
  const ref: PaperRef = { libraryID: token.libraryID, itemKey: token.itemKey };
  const element = document.createElement("a");
  element.addClass("external-link", "unizero-pill", "unizero-legacy-link");
  element.href = serializeLinkTarget({ kind: "paper", ...ref, action: token.action, ...(token.page ? { page: token.page } : {}) });
  element.dataset.ref = paperRefKey(ref);
  element.dataset.action = token.action;

  const label = element.createSpan({ cls: "unizero-pill__label" });
  let paper: BridgePaper | undefined;

  const render = (state: PaperState) => {
    // Settings can repaint a live pill from cached state without recreating the
    // reading-mode child or CodeMirror widget.
    element.removeClass(
      "unizero-pill--loading",
      "unizero-pill--ready",
      "unizero-pill--missing",
      "unizero-pill--error",
      "unizero-pill--ambiguous",
    );

    if (state.status === "ready") {
      paper = state.paper;
      element.addClass("unizero-pill--ready");
      element.toggleClass("unizero-pill--ambiguous", state.paper.ambiguous);
      label.setText(paperLabel(state.paper, token.page));
      element.setAttr("aria-label", `${state.paper.title}\n${token.raw}`);
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

  // Stop the contenteditable parent from claiming the pointer before our click
  // handler runs. Without this, Live Preview can move the caret into the
  // citation span, drop the replace decoration, and look like "click to edit".
  const onPointerDown = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!paper) { return; }
    host.activate(token.action, ref, paper, token.page);
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!paper) { return; }
    host.showMenu(event, ref, paper);
  };

  element.setAttr("contenteditable", "false");
  element.addEventListener("mousedown", onPointerDown);
  element.addEventListener("click", onClick);
  element.addEventListener("contextmenu", onContextMenu);

  return {
    element,
    destroy() {
      element.removeEventListener("mousedown", onPointerDown);
      element.removeEventListener("click", onClick);
      element.removeEventListener("contextmenu", onContextMenu);
      unsubscribe();
    },
  };
}
