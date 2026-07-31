/**
 * The right-sidebar Detail pane.
 *
 * The counterpart of Unizero Home's third column, reduced to what an editor needs:
 * the paper's own metadata, the jump targets, and the cached References /
 * Citations / Relation lists.
 *
 * It inherits the add-on's cache policy rather than reimplementing it. Opening the
 * pane reads what has been saved and nothing more; a paper with nothing cached
 * shows a prompt instead of an empty list, and only pressing that prompt is
 * allowed to reach the providers. Clicking a citation must never become a silent
 * round of network work, and an empty list must never be mistaken for a paper
 * that genuinely has no references.
 */

import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  type BridgeRelatedPaper,
  type BridgeRelations,
  type RelationKind,
} from "./bridge";
import type { PaperState } from "./paperStore";
import type UnizeroPlugin from "./main";
import { openInZotero, openMarkdownNote, openZoteroPdf } from "./actions";

export const DETAIL_VIEW_TYPE = "unizero-detail";

const TABS: { kind: RelationKind; label: string }[] = [
  { kind: "references", label: "References" },
  { kind: "citations", label: "Citations" },
  { kind: "relation", label: "Relation" },
];

export class UnizeroDetailView extends ItemView {
  private citekey?: string;
  private kind: RelationKind = "references";
  private unsubscribe?: () => void;
  private relations?: BridgeRelations;
  private relationsError?: string;
  private busy = false;
  /** Guards against a slow response overwriting a newer selection. */
  private generation = 0;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: UnizeroPlugin) {
    super(leaf);
  }

  getViewType(): string { return DETAIL_VIEW_TYPE; }
  getDisplayText(): string { return this.citekey ? `@${this.citekey}` : "UniZero"; }
  getIcon(): string { return "graduation-cap"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("unizero-detail");
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Point the pane at a paper. Safe to call repeatedly with the same key. */
  show(citekey: string): void {
    if (this.citekey === citekey) { return; }
    this.citekey = citekey;
    this.relations = undefined;
    this.relationsError = undefined;
    this.generation += 1;

    this.unsubscribe?.();
    this.unsubscribe = this.plugin.store.subscribe(citekey, () => {
      this.render();
      void this.loadRelations(false);
    });
  }

  private async loadRelations(fetch: boolean): Promise<void> {
    const citekey = this.citekey;
    if (!citekey) { return; }
    const state = this.plugin.store.peek(citekey);
    if (state?.status !== "ready") { return; }
    if (this.relations && this.relations.kind === this.kind && !fetch) { return; }

    const generation = this.generation;
    const kind = this.kind;
    this.busy = true;
    this.relationsError = undefined;
    this.render();

    try {
      const relations = await this.plugin.bridge.relations(citekey, kind, { fetch });
      if (generation !== this.generation || kind !== this.kind) { return; }
      this.relations = relations;
    } catch (error) {
      if (generation !== this.generation || kind !== this.kind) { return; }
      this.relations = undefined;
      this.relationsError = (error as Error).message;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.render();
      }
    }
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();

    if (!this.citekey) {
      container.createDiv({
        cls: "unizero-detail__empty",
        text: "Click an @citation to see the paper here.",
      });
      return;
    }

    const state = this.plugin.store.peek(this.citekey);
    if (!state || state.status === "loading") {
      container.createDiv({
        cls: "unizero-detail__empty",
        text: `Resolving @${this.citekey}…`,
      });
      return;
    }
    if (state.status !== "ready") {
      this.renderUnresolved(container, state);
      return;
    }

    this.renderHeader(container, state);
    this.renderTabs(container);
    this.renderRelations(container);
  }

  private renderUnresolved(container: HTMLElement, state: PaperState): void {
    const box = container.createDiv({ cls: "unizero-detail__empty" });
    box.createEl("h3", { text: `@${this.citekey}` });
    box.createEl("p", {
      text: state.status === "missing"
        ? "No item in any open Zotero library derives this citekey."
        : `Could not reach Zotero: ${state.status === "error" ? state.message : ""}`,
    });
    if (state.status === "error") {
      box.createEl("button", { text: "Retry" }).addEventListener("click", () => {
        this.plugin.store.invalidate();
      });
    }
  }

  private renderHeader(container: HTMLElement, state: PaperState): void {
    if (state.status !== "ready") { return; }
    const paper = state.paper;
    const header = container.createDiv({ cls: "unizero-detail__header" });

    header.createEl("h2", { cls: "unizero-detail__title", text: paper.title || paper.citekey });

    const credit = [paper.authors.join(", "), paper.year].filter(Boolean).join(" · ");
    if (credit) {
      header.createDiv({ cls: "unizero-detail__credit", text: credit });
    }
    if (paper.venue) {
      header.createDiv({ cls: "unizero-detail__venue", text: paper.venue });
    }

    const badges = header.createDiv({ cls: "unizero-detail__badges" });
    badges.createSpan({ cls: "unizero-badge", text: `@${paper.citekey}` });
    if (!paper.citekeyPinned) {
      // A derived key is a convenience, not an identity. Saying so where the key
      // is shown is what stops a user from treating it as one.
      badges.createSpan({
        cls: "unizero-badge unizero-badge--muted",
        text: "derived key",
      }).setAttr(
        "aria-label",
        "Derived from the metadata. Add `Citation Key: …` to the item's Extra field in Zotero to make it permanent.",
      );
    }
    if (paper.ambiguous) {
      badges.createSpan({
        cls: "unizero-badge unizero-badge--warn",
        text: "ambiguous",
      }).setAttr("aria-label", "More than one item derives this citekey.");
    }
    if (paper.doi) { badges.createSpan({ cls: "unizero-badge", text: paper.doi }); }
    if (typeof paper.citationCount === "number") {
      badges.createSpan({ cls: "unizero-badge", text: `${paper.citationCount} citations` });
    }

    const actions = header.createDiv({ cls: "unizero-detail__actions" });
    this.actionButton(actions, "external-link", "Zotero", () => openInZotero(paper));
    this.actionButton(actions, "file-text", "PDF", () => openZoteroPdf(paper));
    this.actionButton(actions, "file-symlink", "Note", () =>
      openMarkdownNote(this.app, paper, this.plugin.settings));

    if (paper.abstract) {
      const abstract = header.createEl("details", { cls: "unizero-detail__abstract" });
      abstract.createEl("summary", { text: "Abstract" });
      abstract.createEl("p", { text: paper.abstract });
    }
  }

  private actionButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    run: () => void | Promise<void>,
  ): void {
    const button = parent.createEl("button", { cls: "unizero-detail__action" });
    setIcon(button.createSpan(), icon);
    button.createSpan({ text: label });
    button.addEventListener("click", () => { void run(); });
  }

  private renderTabs(container: HTMLElement): void {
    const tabs = container.createDiv({ cls: "unizero-detail__tabs" });
    for (const tab of TABS) {
      const button = tabs.createEl("button", {
        cls: "unizero-detail__tab",
        text: tab.label,
      });
      button.toggleClass("is-active", tab.kind === this.kind);
      button.addEventListener("click", () => {
        if (this.kind === tab.kind) { return; }
        this.kind = tab.kind;
        this.relations = undefined;
        this.relationsError = undefined;
        void this.loadRelations(false);
      });
    }
  }

  private renderRelations(container: HTMLElement): void {
    const body = container.createDiv({ cls: "unizero-detail__list" });

    if (this.busy) {
      body.createDiv({ cls: "unizero-detail__empty", text: "Reading saved data…" });
      return;
    }
    if (this.relationsError) {
      body.createDiv({ cls: "unizero-detail__empty", text: this.relationsError });
      return;
    }

    const relations = this.relations;
    if (!relations) {
      void this.loadRelations(false);
      return;
    }

    if (!relations.loaded) {
      const prompt = body.createDiv({ cls: "unizero-detail__empty" });
      prompt.createEl("p", { text: "Nothing saved for this paper yet." });
      prompt.createEl("button", { text: "Fetch from providers" })
        .addEventListener("click", () => { void this.loadRelations(true); });
      return;
    }

    if (!relations.items.length) {
      body.createDiv({ cls: "unizero-detail__empty", text: "No papers found." });
      return;
    }

    const summary = [
      `${relations.count} of ${relations.total || relations.count}`,
      relations.source,
    ].filter(Boolean).join(" · ");
    body.createDiv({ cls: "unizero-detail__summary", text: summary });

    for (const related of relations.items) {
      this.renderRelatedRow(body, related);
    }

    if (relations.hasMore) {
      body.createDiv({
        cls: "unizero-detail__summary",
        text: "More results are available in Unizero Home.",
      });
    }
  }

  private renderRelatedRow(parent: HTMLElement, related: BridgeRelatedPaper): void {
    const row = parent.createDiv({ cls: "unizero-row" });
    row.toggleClass("unizero-row--in-library", related.inLibrary);

    const title = row.createDiv({ cls: "unizero-row__title", text: related.title || "Untitled" });
    if (related.isInfluential) {
      title.createSpan({ cls: "unizero-badge unizero-badge--warn", text: "influential" });
    }

    const meta = [
      related.authors.slice(0, 3).join(", ") + (related.authors.length > 3 ? " et al." : ""),
      related.year,
      related.venue,
      typeof related.citationCount === "number" ? `${related.citationCount} cited` : undefined,
    ].filter(Boolean).join(" · ");
    if (meta) { row.createDiv({ cls: "unizero-row__meta", text: meta }); }

    const actions = row.createDiv({ cls: "unizero-row__actions" });
    if (related.citekey) {
      const open = actions.createEl("button", { text: `@${related.citekey}` });
      open.addEventListener("click", () => this.show(related.citekey!));

      const insert = actions.createEl("button", { text: "Insert" });
      insert.setAttr("aria-label", "Insert this citation at the cursor");
      insert.addEventListener("click", () => this.plugin.insertCitation(related.citekey!));
    } else if (related.inLibrary) {
      // In the library but not addressable: the item exists, yet nothing here can
      // name it. Saying which of the two is missing is more useful than hiding it.
      actions.createSpan({ cls: "unizero-row__note", text: "in library, no citekey" });
    } else {
      actions.createSpan({ cls: "unizero-row__note", text: "not in library" });
    }

    if (related.doi || related.url) {
      const link = actions.createEl("button", { text: "Source" });
      link.addEventListener("click", () => {
        const url = related.url || `https://doi.org/${related.doi}`;
        window.open(url, "_blank");
      });
    }
  }

  /** Re-read the current paper and its relations, ignoring what is cached here. */
  refresh(): void {
    if (!this.citekey) {
      new Notice("No paper is open in the UniZero pane.");
      return;
    }
    this.relations = undefined;
    void this.loadRelations(false);
  }
}
