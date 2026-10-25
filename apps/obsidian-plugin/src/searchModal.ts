/**
 * "Search the Zotero library" command: the `@` search in a modal, without the
 * library pane, and a direct jump to the hit's PDF, Raw, or Canvas.
 *
 * Choosing a hit is what triggers bridge work; typing only searches.
 */

import { Notice, SuggestModal, type App } from "obsidian";
import {
  convertToMarkdown,
  hasRaw,
  openCanvas,
  openRaw,
  openZoteroPdf,
} from "./actions";
import type { BridgePaper, BridgeSuggestion } from "./bridge";
import { confirm } from "./choiceModal";
import type { PaperRef } from "./citation";
import type UnizeroPlugin from "./main";
import { LibrarySearch, renderSuggestion } from "./suggest";

type SearchAction = "pane" | "pdf" | "raw" | "canvas";

const ACTION_BUTTONS: { action: SearchAction; label: string; title: string }[] = [
  { action: "pdf", label: "PDF", title: "Open the PDF in Zotero" },
  { action: "raw", label: "Raw", title: "Open Raw" },
  { action: "canvas", label: "Canvas", title: "Open Canvas" },
];

/** The undocumented chooser behind `SuggestModal`; checked before use. */
interface Chooser {
  useSelectedItem?: (event: KeyboardEvent) => boolean;
}

export class LibrarySearchModal extends SuggestModal<BridgeSuggestion> {
  private readonly library: LibrarySearch;

  constructor(app: App, private readonly plugin: UnizeroPlugin) {
    super(app);
    this.library = new LibrarySearch(plugin);
    this.setPlaceholder("Search Zotero by author, title, year, or citekey");
    this.emptyStateText = "Type to search the Zotero library.";
    this.setInstructions([
      { command: "↵", purpose: "paper pane" },
      { command: "mod ↵", purpose: "PDF" },
      { command: "shift ↵", purpose: "Raw" },
      { command: "alt ↵", purpose: "Canvas" },
      { command: "esc", purpose: "dismiss" },
    ]);
    for (const modifier of ["Mod", "Shift", "Alt"] as const) {
      this.scope.register([modifier], "Enter", (event) => {
        const chooser = (this as unknown as { chooser?: Chooser }).chooser;
        chooser?.useSelectedItem?.(event);
        return false;
      });
    }
  }

  getSuggestions(query: string): BridgeSuggestion[] | Promise<BridgeSuggestion[]> {
    return query.trim() ? this.library.search(query) : [];
  }

  renderSuggestion(suggestion: BridgeSuggestion, element: HTMLElement): void {
    element.addClass("unizero-search");
    renderSuggestion(suggestion, element.createDiv({ cls: "unizero-search__body" }));
    const buttons = element.createDiv({ cls: "unizero-search__actions" });
    for (const { action, label, title } of ACTION_BUTTONS) {
      const button = buttons.createEl("button", {
        cls: "unizero-search__action",
        text: label,
        attr: { "aria-label": title },
      });
      // The chooser picks the row on click; the button must win.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        void runSearchAction(this.plugin, action, suggestion);
      });
    }
  }

  onChooseSuggestion(suggestion: BridgeSuggestion, event: MouseEvent | KeyboardEvent): void {
    void runSearchAction(this.plugin, actionFor(event), suggestion);
  }
}

function actionFor(event: MouseEvent | KeyboardEvent): SearchAction {
  if (event.metaKey || event.ctrlKey) { return "pdf"; }
  if (event.shiftKey) { return "raw"; }
  if (event.altKey) { return "canvas"; }
  return "pane";
}

async function runSearchAction(
  plugin: UnizeroPlugin,
  action: SearchAction,
  suggestion: BridgeSuggestion,
): Promise<void> {
  const ref: PaperRef = { libraryID: suggestion.libraryID, itemKey: suggestion.itemKey };
  if (action === "pane") {
    await plugin.showInDetailView(ref);
    return;
  }
  if (action === "canvas") {
    await openCanvas(plugin.actionContext(), suggestion);
    return;
  }

  let paper: BridgePaper;
  try {
    paper = await plugin.bridge.paper(ref);
  } catch (error) {
    new Notice(`UniZero: could not read the paper — ${(error as Error).message}`);
    return;
  }
  if (action === "pdf") {
    await openZoteroPdf(paper);
  } else if (hasRaw(paper)) {
    await openRaw(paper, plugin.actionContext());
  } else if (await confirm(plugin.app, {
    title: "No Raw yet",
    message: `“${paper.title || `${ref.libraryID}/${ref.itemKey}`}” has no Raw in Zotero. `
      + "Convert its PDF to Markdown now?",
    action: "Convert to Markdown",
  })) {
    await convertToMarkdown(plugin.bridge, ref, paper, plugin.settings.defaultTemplate);
  }
}
