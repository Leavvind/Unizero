/**
 * The right-sidebar Detail pane.
 *
 * The counterpart of a Unizero Home paper tab, reduced to what an editor needs:
 * the paper's own metadata, the jump targets, and four lists:
 *
 * - Links: links into the paper that are not paper-to-paper relations;
 * - References / Citations: paper-to-paper relations written as links in papers'
 *   Raw and Canvas, recomputed from the shared link index (paperRelations.ts);
 * - Bibliography: the provider References / Citations / Relation lists.
 *
 * Bibliography inherits the add-on's cache policy rather than reimplementing it. Opening the
 * pane reads what has been saved and nothing more; a paper with nothing cached
 * shows a prompt instead of an empty list, and only pressing that prompt is
 * allowed to reach the providers. Clicking a citation must never become a silent
 * round of network work, and an empty list must never be mistaken for a paper
 * that genuinely has no references.
 */

import { ItemView, Menu, Notice, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import {
  type BridgeRelatedPaper,
  type BridgeRelations,
  type RelationKind,
} from "./bridge";
import { enableCitationDrag, paperRefKey, type PaperRef } from "./citation";
import type { PaperState } from "./paperStore";
import type UnizeroPlugin from "./main";
import { renderOccurrences } from "./backlinksView";
import { occurrenceSnippet } from "./documentLinks";
import type { LinkOccurrence } from "./linkIndex";
import { openLinkOccurrence } from "./linkOpening";
import { paperCitations, paperLinks, paperReferences, pdfAnchorPage, type RelatedPaper } from "./paperRelations";
import {
  addCanvasItems,
  addRawItems,
  artifactState,
  chooseTemplateAndConvert,
  convertToMarkdown,
  hasRaw,
  openCanvas,
  openPdfAnchor,
  openRaw,
  openZoteroPdf,
} from "./actions";

export const DETAIL_VIEW_TYPE = "unizero-detail";

export type DetailTabKind = "links" | "references" | "citations" | "bibliography";

const TABS: { kind: DetailTabKind; label: string }[] = [
  { kind: "links", label: "Links" },
  { kind: "references", label: "References" },
  { kind: "citations", label: "Citations" },
  { kind: "bibliography", label: "Bibliography" },
];

const PROVIDER_LISTS: { kind: RelationKind; label: string }[] = [
  { kind: "references", label: "References" },
  { kind: "citations", label: "Citations" },
  { kind: "relation", label: "Relation" },
];

/**
 * A related paper's web page, or undefined.
 *
 * The URL comes from a provider record, not from this plugin, and Electron hands
 * whatever `window.open` gets to the OS. Only http(s) may leave; anything else —
 * `file:`, an app's custom scheme — falls back to the DOI page or no button.
 */
function sourceUrl(related: BridgeRelatedPaper): string | undefined {
  if (related.url) {
    try {
      const url = new URL(related.url);
      if (url.protocol === "https:" || url.protocol === "http:") { return url.href; }
    } catch {
      // Not a URL at all; try the DOI.
    }
  }
  return related.doi ? `https://doi.org/${encodeURI(related.doi)}` : undefined;
}

export class UnizeroDetailView extends ItemView {
  private ref?: PaperRef;
  private kind: DetailTabKind = "links";
  /** Which provider list the Bibliography tab shows. */
  private providerKind: RelationKind = "references";
  private renderQueued = false;
  private unsubscribeStore?: () => void;
  private unsubscribeVaultIndex?: () => void;
  private relations?: BridgeRelations;
  private relationsError?: string;
  private busy = false;
  /** Guards against a slow response overwriting a newer selection. */
  private generation = 0;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: UnizeroPlugin) {
    super(leaf);
  }

  getViewType(): string { return DETAIL_VIEW_TYPE; }
  getDisplayText(): string {
    return this.ref ? `@${paperRefKey(this.ref)}` : "UniZero";
  }
  getIcon(): string { return "graduation-cap"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("unizero-detail");
    this.render();
    this.unsubscribeVaultIndex = this.plugin.vaultIndex.links.subscribe(() => {
      if (this.kind !== "bibliography") {
        this.render();
      }
    });
  }

  async onClose(): Promise<void> {
    this.generation += 1;
    this.busy = false;
    this.unsubscribeStore?.();
    this.unsubscribeStore = undefined;
    this.unsubscribeVaultIndex?.();
    this.unsubscribeVaultIndex = undefined;
  }

  /** Point the pane at a paper. Safe to call repeatedly with the same ref. */
  show(ref: PaperRef): void {
    if (
      this.ref &&
      this.ref.libraryID === ref.libraryID &&
      this.ref.itemKey === ref.itemKey
    ) {
      return;
    }
    this.ref = { libraryID: ref.libraryID, itemKey: ref.itemKey };
    this.relations = undefined;
    this.relationsError = undefined;
    this.busy = false;
    this.generation += 1;

    this.unsubscribeStore?.();
    this.unsubscribeStore = this.plugin.store.subscribe(this.ref, () => {
      this.render();
      if (this.kind === "bibliography") {
        void this.loadRelations(false);
      }
    });
  }

  private async loadRelations(fetch: boolean): Promise<void> {
    if (this.busy) { return; }
    if (this.kind !== "bibliography") { return; }
    const ref = this.ref;
    if (!ref) { return; }
    const state = this.plugin.store.peek(ref);
    if (state?.status !== "ready") { return; }
    if (this.relations && this.relations.kind === this.providerKind && !fetch) { return; }

    const generation = this.generation;
    const kind = this.providerKind;
    this.busy = true;
    this.relationsError = undefined;
    this.render();

    try {
      const relations = await this.plugin.bridge.relations(ref, kind, { fetch });
      if (generation !== this.generation || kind !== this.providerKind) { return; }
      this.relations = relations;
    } catch (error) {
      if (generation !== this.generation || kind !== this.providerKind) { return; }
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

    if (!this.ref) {
      container.createDiv({
        cls: "unizero-detail__empty",
        text: "Click an @citation to see the paper here.",
      });
      return;
    }

    const state = this.plugin.store.peek(this.ref);
    if (!state || state.status === "loading") {
      container.createDiv({
        cls: "unizero-detail__empty",
        text: `Resolving @${paperRefKey(this.ref)}…`,
      });
      return;
    }
    if (state.status !== "ready") {
      this.renderUnresolved(container, state);
      return;
    }

    this.renderHeader(container, state);
    this.renderTabs(container);
    if (this.kind === "links") {
      this.renderVault(container);
    } else if (this.kind === "bibliography") {
      this.renderProviderTabs(container);
      this.renderRelations(container);
    } else {
      this.renderPaperRelations(container, this.kind);
    }
  }

  /** Coalesces re-renders asked for by paper titles arriving one by one. */
  private scheduleRender(): void {
    if (this.renderQueued) { return; }
    this.renderQueued = true;
    const generation = this.generation;
    window.setTimeout(() => {
      this.renderQueued = false;
      if (generation === this.generation && this.ref) { this.render(); }
    }, 0);
  }

  private renderUnresolved(container: HTMLElement, state: PaperState): void {
    const box = container.createDiv({ cls: "unizero-detail__empty" });
    box.createEl("h3", { text: `@${paperRefKey(this.ref!)}` });
    box.createEl("p", {
      text: state.status === "missing"
        ? "No Zotero item matches this libraryID/itemKey."
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
    const selfRef: PaperRef = {
      libraryID: paper.libraryID,
      itemKey: paper.itemKey,
    };
    // Drag the open paper into a note (same affordance as library rows).
    enableCitationDrag(header, paper);
    header.setAttr(
      "title",
      `Drag into a note to insert @${paper.libraryID}/${paper.itemKey}`,
    );

    header.createEl("h2", {
      cls: "unizero-detail__title",
      text: paper.title || `@${paper.libraryID}/${paper.itemKey}`,
    });

    const credit = [paper.authors.join(", "), paper.year].filter(Boolean).join(" · ");
    if (credit) {
      header.createDiv({ cls: "unizero-detail__credit", text: credit });
    }
    if (paper.venue) {
      header.createDiv({ cls: "unizero-detail__venue", text: paper.venue });
    }

    const badges = header.createDiv({ cls: "unizero-detail__badges" });
    badges.createSpan({
      cls: "unizero-badge",
      text: `${paper.libraryID}/${paper.itemKey}`,
    });
    if (paper.citekey) {
      badges.createSpan({
        cls: "unizero-badge unizero-badge--muted",
        text: paper.citekey,
      }).setAttr(
        "aria-label",
        paper.citekeyPinned
          ? "Pinned citation key in Zotero Extra"
          : "Derived citation key (not the note address)",
      );
    }
    if (paper.doi) { badges.createSpan({ cls: "unizero-badge", text: paper.doi }); }
    if (typeof paper.citationCount === "number") {
      badges.createSpan({ cls: "unizero-badge", text: `${paper.citationCount} citations` });
    }

    const actions = header.createDiv({ cls: "unizero-detail__actions" });
    this.actionButton(actions, "file-text", "PDF", () => openZoteroPdf(paper));
    const artifacts = artifactState(paper);
    const ref = { libraryID: paper.libraryID, itemKey: paper.itemKey };
    if (hasRaw(paper)) {
      const raw = this.actionButton(actions, "file-symlink", "Raw", () =>
        openRaw(paper, this.plugin.actionContext()));
      raw.setAttr("aria-label", "Open Raw; right-click to re-convert, restore, or trash");
      this.contextMenu(raw, (menu, event) =>
        addRawItems(menu, this.plugin.actionContext(), paper, artifacts, event));
    } else {
      const convert = this.actionButton(actions, "file-down", "Convert", () =>
        convertToMarkdown(
          this.plugin.bridge, ref, paper, this.plugin.settings.defaultTemplate,
        ));
      convert.setAttr("aria-label", "Convert with the default template; right-click to choose");
      convert.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (!artifacts.hasRawBackup) {
          void chooseTemplateAndConvert(
            this.plugin.bridge, ref, event, this.plugin.settings.defaultTemplate, paper,
          );
          return;
        }
        // Raw was trashed but its backup remains: offer it beside the templates.
        const menu = new Menu();
        menu.addItem((item) => item
          .setTitle("Convert with template…")
          .setIcon("list")
          .onClick(() => {
            void chooseTemplateAndConvert(
              this.plugin.bridge, ref, event, this.plugin.settings.defaultTemplate, paper,
            );
          }));
        addRawItems(menu, this.plugin.actionContext(), paper, artifacts, event);
        menu.showAtMouseEvent(event);
      });
    }
    // Hand-made note surface: the paper's Canvas attachment, created on first open.
    const canvas = this.actionButton(actions, "layout-dashboard", "Canvas", () =>
      openCanvas(this.plugin.actionContext(), paper));
    if (artifacts.hasCanvas) {
      canvas.setAttr("aria-label", "Open Canvas; right-click to move it to the trash");
      this.contextMenu(canvas, (menu) =>
        addCanvasItems(menu, this.plugin.actionContext(), paper, artifacts));
    }

    if (paper.abstract) {
      const abstract = header.createEl("details", { cls: "unizero-detail__abstract" });
      abstract.createEl("summary", { text: "Abstract" });
      abstract.createEl("p", { text: paper.abstract });
    }
  }

  /** Show a menu built by `build` when `target` is right-clicked. */
  private contextMenu(
    target: HTMLElement,
    build: (menu: Menu, event: MouseEvent) => void,
  ): void {
    target.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const menu = new Menu();
      build(menu, event);
      menu.showAtMouseEvent(event);
    });
  }

  private actionButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    run: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "unizero-detail__action" });
    setIcon(button.createSpan(), icon);
    button.createSpan({ text: label });
    button.addEventListener("click", () => { void run(); });
    return button;
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
        this.generation += 1;
        this.busy = false;
        this.kind = tab.kind;
        this.relations = undefined;
        this.relationsError = undefined;
        this.render();
        if (this.kind === "bibliography") { void this.loadRelations(false); }
      });
    }
  }

  private renderProviderTabs(container: HTMLElement): void {
    const tabs = container.createDiv({ cls: "unizero-detail__tabs unizero-detail__tabs--sub" });
    for (const list of PROVIDER_LISTS) {
      const button = tabs.createEl("button", { cls: "unizero-detail__tab", text: list.label });
      button.toggleClass("is-active", list.kind === this.providerKind);
      button.addEventListener("click", () => {
        if (this.providerKind === list.kind) { return; }
        this.generation += 1;
        this.busy = false;
        this.providerKind = list.kind;
        this.relations = undefined;
        this.relationsError = undefined;
        this.render();
        void this.loadRelations(false);
      });
    }
  }

  /** References / Citations written as links in papers' Raw and Canvas. */
  private renderPaperRelations(container: HTMLElement, kind: "references" | "citations"): void {
    const body = container.createDiv({ cls: "unizero-detail__list" });
    const ref = this.ref;
    if (!ref) { return; }
    if (!this.plugin.settings.indexZoteroSources) {
      body.createDiv({
        cls: "unizero-detail__empty",
        text: "References and Citations come from links written in papers' Raw and Canvas. "
          + "Turn on “Index Zotero documents” in UniZero settings to see them.",
      });
      return;
    }
    const index = this.plugin.vaultIndex.links;
    const groups = kind === "references" ? paperReferences(index, ref) : paperCitations(index, ref);
    const coverage = index.coverage;
    if (!groups.length) {
      const text = !coverage.lastSuccess && (coverage.state === "unbuilt" || coverage.state === "updating")
        ? "Indexing Zotero documents…"
        : coverage.state === "failed" ? `Zotero documents could not be indexed: ${coverage.error || "unknown error"}`
        : kind === "references" ? "This paper's Raw and Canvas link to no other paper."
        : "No other paper's Raw or Canvas links to this paper.";
      body.createDiv({ cls: "unizero-detail__empty", text });
      return;
    }
    const mentions = groups.reduce((sum, group) => sum + group.mentions.length, 0);
    const summary = [`${groups.length} paper${groups.length === 1 ? "" : "s"}`,
      `${mentions} link${mentions === 1 ? "" : "s"}`,
      ["partial", "offline", "failed"].includes(coverage.state) ? `Zotero index ${coverage.state}` : ""];
    body.createDiv({ cls: "unizero-detail__summary", text: summary.filter(Boolean).join(" · ") });
    for (const group of groups) { this.renderRelatedPaper(body, group, kind); }
  }

  private renderRelatedPaper(parent: HTMLElement, group: RelatedPaper, kind: "references" | "citations"): void {
    const box = parent.createDiv({ cls: "unizero-links__group" });
    const header = box.createDiv({ cls: "unizero-links__source" });
    let title = group.title;
    let meta: { authors?: string[]; year?: string; title?: string } = { title };
    if (kind === "references") {
      const state = this.plugin.store.peek(group.paper);
      if (!state) {
        void this.plugin.store.load(group.paper).then(() => this.scheduleRender());
      } else if (state.status === "ready") {
        title = state.paper.title;
        meta = state.paper;
        const credit = [state.paper.authors[0], state.paper.year].filter(Boolean).join(", ");
        if (credit) { header.title = credit; }
      } else if (state.status === "missing") {
        title = `Not in Zotero · ${group.paper.libraryID}/${group.paper.itemKey}`;
      }
    }
    const name = header.createEl("a", { cls: "unizero-links__name", text: title || `${group.paper.libraryID}/${group.paper.itemKey}` });
    name.onclick = () => { void this.plugin.showInDetailView(group.paper); };
    enableCitationDrag(header, { ...group.paper, ...meta });
    if (group.mentions.length > 1) {
      header.createSpan({ cls: "unizero-links__count", text: String(group.mentions.length) });
    }
    for (const occurrence of group.mentions) { this.renderMention(box, occurrence); }
  }

  /** One passage: where it is written, its paragraph, and jumps to the note and the PDF. */
  private renderMention(parent: HTMLElement, occurrence: LinkOccurrence): void {
    const source = occurrence.source;
    const el = parent.createDiv({ cls: "unizero-link-occurrence unizero-relation", attr: { role: "button", tabindex: "0" } });
    const file = source.kind === "zotero" && source.purpose === "canvas" ? "Canvas" : "Raw";
    el.title = `${file} · ${source.title}`;
    const place = el.createSpan({ cls: "unizero-link-occurrence__line" });
    place.appendText(`${occurrence.stale ? "stale " : ""}${file}${occurrence.nodeId ? "" : ` L${occurrence.line + 1}`}`);
    el.createSpan({
      cls: "unizero-link-occurrence__text",
      text: occurrence.unit?.text || occurrenceSnippet(occurrence.lineText, occurrence.ch),
    });
    const jumps = el.createDiv({ cls: "unizero-relation__jumps" });
    const openNote = () => { void openLinkOccurrence(this.plugin, occurrence).catch((error) => this.plugin.reportError(error)); };
    const note = jumps.createEl("button", { text: file });
    note.setAttr("aria-label", `Open this passage in the ${file}`);
    note.onclick = (event) => { event.stopPropagation(); openNote(); };
    for (const url of occurrence.unit?.pdf || []) {
      const page = pdfAnchorPage(url);
      const pdf = jumps.createEl("button", { text: page ? `PDF p. ${page}` : "PDF" });
      pdf.setAttr("aria-label", "Open the annotated passage in Zotero");
      pdf.onclick = (event) => { event.stopPropagation(); void openPdfAnchor(url); };
    }
    el.onclick = openNote;
    el.onkeydown = (event) => { if (event.key === "Enter" && event.target === el) { openNote(); } };
  }

  private renderVault(container: HTMLElement): void {
    const body = container.createDiv({ cls: "unizero-detail__list" });
    if (!this.ref) { return; }
    renderOccurrences(body, this.plugin, paperLinks(this.plugin.vaultIndex.links, this.ref));
    body.createEl("button", { text: "Insert citation" }).onclick = () => { if (this.ref) { this.plugin.insertCitation(this.ref); } };
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
    if (
      related.inLibrary &&
      typeof related.libraryID === "number" &&
      related.itemKey
    ) {
      const ref: PaperRef = {
        libraryID: related.libraryID,
        itemKey: related.itemKey,
      };
      enableCitationDrag(row, { ...ref, authors: related.authors, year: related.year, title: related.title });
      row.setAttr(
        "title",
        `Drag into a note to insert @${ref.libraryID}/${ref.itemKey}`,
      );

      const open = actions.createEl("button", { text: "Open" });
      open.addEventListener("click", () => this.show(ref));

      const insert = actions.createEl("button", { text: "Insert" });
      insert.setAttr(
        "aria-label",
        "Insert this citation at the cursor of the last open note",
      );
      insert.addEventListener("click", () => this.plugin.insertCitation(ref));
    } else if (related.inLibrary) {
      actions.createSpan({ cls: "unizero-row__note", text: "in library" });
    } else {
      actions.createSpan({ cls: "unizero-row__note", text: "not in library" });
    }

    const source = sourceUrl(related);
    if (source) {
      const link = actions.createEl("button", { text: "Source" });
      link.addEventListener("click", () => { window.open(source, "_blank"); });
    }
  }

  /** Re-read the current paper and its relations, ignoring what is cached here. */
  refresh(): void {
    if (!this.ref) {
      new Notice("No paper is open in the UniZero pane.");
      return;
    }
    this.relations = undefined;
    void this.loadRelations(false);
  }
}
