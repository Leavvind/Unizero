/**
 * The left-sidebar library pane.
 *
 * Counterpart of Unizero Home's first column (COLLECTION PAPERS): browse the
 * papers in a chosen Zotero library or collection, filter them locally, and
 * open one in the detail pane. Scope is user-selected here rather than taken
 * from Zotero's current collection row, because Obsidian has no live selection
 * in Zotero's tree.
 */

import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type {
  BridgeCollection,
  BridgeCollectionItem,
  BridgeCollections,
  BridgeLibrary,
} from "./bridge";
import type { PaperRef } from "./citation";
import { openInZotero, openMarkdownNote, openZoteroPdf } from "./actions";
import type UnizeroPlugin from "./main";

export const LIBRARY_VIEW_TYPE = "unizero-library";

interface CollectionOption {
  /** Empty key = whole library. */
  collectionKey: string;
  label: string;
  depth: number;
}

export class UnizeroLibraryView extends ItemView {
  private catalog?: BridgeCollections;
  private items: BridgeCollectionItem[] = [];
  private scopeName = "";
  private filter = "";
  private libraryID: number | null = null;
  private collectionKey = "";
  private selectedKey?: string;
  private busy = false;
  private error?: string;
  /** Guards against a slow response overwriting a newer selection. */
  private generation = 0;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: UnizeroPlugin) {
    super(leaf);
  }

  getViewType(): string { return LIBRARY_VIEW_TYPE; }
  getDisplayText(): string { return "UniZero library"; }
  getIcon(): string { return "library"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("unizero-library");
    this.libraryID = this.plugin.settings.lastLibraryID;
    this.collectionKey = this.plugin.settings.lastCollectionKey || "";
    this.render();
    await this.loadCatalogAndItems();
  }

  async onClose(): Promise<void> {
    // Nothing held across close beyond DOM, which Obsidian discards.
  }

  /** Re-fetch catalog + current scope from Zotero. */
  async refresh(): Promise<void> {
    await this.loadCatalogAndItems();
  }

  private async loadCatalogAndItems(): Promise<void> {
    const generation = ++this.generation;
    this.busy = true;
    this.error = undefined;
    this.render();

    try {
      const catalog = await this.plugin.bridge.collections();
      if (generation !== this.generation) { return; }
      this.catalog = catalog;
      this.ensureValidScope(catalog);

      const libraryID = this.libraryID;
      if (libraryID === null) {
        this.items = [];
        this.scopeName = "";
        this.error = "No Zotero library is available.";
        return;
      }

      const payload = await this.plugin.bridge.collectionItems(
        libraryID,
        this.collectionKey || undefined,
      );
      if (generation !== this.generation) { return; }
      this.items = payload.items || [];
      this.scopeName = payload.scope.name;
    } catch (error) {
      if (generation !== this.generation) { return; }
      this.items = [];
      this.error = (error as Error).message;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.render();
      }
    }
  }

  private async loadItemsOnly(): Promise<void> {
    if (this.libraryID === null) { return; }
    const generation = ++this.generation;
    this.busy = true;
    this.error = undefined;
    this.render();

    try {
      const payload = await this.plugin.bridge.collectionItems(
        this.libraryID,
        this.collectionKey || undefined,
      );
      if (generation !== this.generation) { return; }
      this.items = payload.items || [];
      this.scopeName = payload.scope.name;
    } catch (error) {
      if (generation !== this.generation) { return; }
      this.items = [];
      this.error = (error as Error).message;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.render();
      }
    }
  }

  private ensureValidScope(catalog: BridgeCollections): void {
    const libraries = catalog.libraries || [];
    if (!libraries.length) {
      this.libraryID = null;
      this.collectionKey = "";
      return;
    }

    const known = new Set(libraries.map((library) => library.libraryID));
    if (this.libraryID === null || !known.has(this.libraryID)) {
      this.libraryID = libraries[0].libraryID;
    }

    const inLibrary = (catalog.collections || [])
      .filter((collection) => collection.libraryID === this.libraryID);
    if (
      this.collectionKey &&
      !inLibrary.some((collection) => collection.collectionKey === this.collectionKey)
    ) {
      this.collectionKey = "";
    }

    void this.persistScope();
  }

  private async persistScope(): Promise<void> {
    const settings = this.plugin.settings;
    if (
      settings.lastLibraryID === this.libraryID &&
      settings.lastCollectionKey === this.collectionKey
    ) {
      return;
    }
    settings.lastLibraryID = this.libraryID;
    settings.lastCollectionKey = this.collectionKey;
    await this.plugin.saveData(settings);
  }

  private visibleItems(): BridgeCollectionItem[] {
    const query = this.filter.trim().toLocaleLowerCase();
    if (!query) { return this.items; }
    const words = query.split(/\s+/).filter(Boolean);
    return this.items.filter((item) => {
      const haystack = [
        item.title,
        item.authors.join(" "),
        item.year || "",
        item.venue || "",
        item.itemKey,
      ].join(" ").toLocaleLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }

  private collectionOptions(libraryID: number): CollectionOption[] {
    const collections = (this.catalog?.collections || [])
      .filter((collection) => collection.libraryID === libraryID);
    const byKey = new Map(collections.map((collection) => [
      collection.collectionKey,
      collection,
    ]));

    const depthOf = (collection: BridgeCollection, seen = new Set<string>()): number => {
      if (!collection.parentKey || !byKey.has(collection.parentKey)) { return 0; }
      if (seen.has(collection.collectionKey)) { return 0; }
      seen.add(collection.collectionKey);
      return 1 + depthOf(byKey.get(collection.parentKey)!, seen);
    };

    const childrenOf = (parentKey: string | undefined): BridgeCollection[] =>
      collections
        .filter((collection) => (collection.parentKey || undefined) === parentKey)
        .sort((a, b) => a.name.localeCompare(b.name));

    const ordered: CollectionOption[] = [{
      collectionKey: "",
      label: "All items",
      depth: 0,
    }];

    const walk = (parentKey: string | undefined): void => {
      for (const collection of childrenOf(parentKey)) {
        ordered.push({
          collectionKey: collection.collectionKey,
          label: collection.name,
          depth: depthOf(collection),
        });
        walk(collection.collectionKey);
      }
    };
    walk(undefined);
    return ordered;
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();

    this.renderToolbar(container);

    const body = container.createDiv({ cls: "unizero-library__body" });
    this.renderBody(body);
  }

  /** Rebuild only the status line + list (keeps the search field focused). */
  private renderBody(body?: HTMLElement): void {
    const host = body ??
      (this.contentEl.querySelector(".unizero-library__body") as HTMLElement | null);
    if (!host) { return; }
    host.empty();

    this.renderStatus(host);

    if (this.busy && !this.items.length) {
      host.createDiv({
        cls: "unizero-library__empty",
        text: "Reading Zotero…",
      });
      return;
    }

    if (this.error && !this.items.length) {
      const box = host.createDiv({ cls: "unizero-library__empty" });
      box.createEl("p", { text: this.error });
      box.createEl("button", { text: "Retry" }).addEventListener("click", () => {
        void this.refresh();
      });
      return;
    }

    const visible = this.visibleItems();
    if (!visible.length) {
      host.createDiv({
        cls: "unizero-library__empty",
        text: this.items.length
          ? "No papers match this search."
          : "This collection has no papers.",
      });
      return;
    }

    const list = host.createDiv({ cls: "unizero-library__list" });
    for (const item of visible) {
      this.renderRow(list, item);
    }
  }

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "unizero-library__toolbar" });

    const libraries = this.catalog?.libraries || [];
    if (libraries.length > 1) {
      const libraryRow = toolbar.createDiv({ cls: "unizero-library__field" });
      libraryRow.createEl("label", {
        cls: "unizero-library__label",
        text: "Library",
      });
      const librarySelect = libraryRow.createEl("select", {
        cls: "unizero-library__select",
      });
      for (const library of libraries) {
        librarySelect.createEl("option", {
          text: libraryLabel(library),
          value: String(library.libraryID),
        }).selected = library.libraryID === this.libraryID;
      }
      librarySelect.addEventListener("change", () => {
        this.libraryID = Number(librarySelect.value);
        this.collectionKey = "";
        this.selectedKey = undefined;
        void this.persistScope();
        void this.loadItemsOnly();
      });
    }

    const collectionRow = toolbar.createDiv({ cls: "unizero-library__field" });
    collectionRow.createEl("label", {
      cls: "unizero-library__label",
      text: "Collection",
    });
    const collectionSelect = collectionRow.createEl("select", {
      cls: "unizero-library__select",
    });
    const options = this.libraryID === null
      ? [{ collectionKey: "", label: "All items", depth: 0 }]
      : this.collectionOptions(this.libraryID);
    for (const option of options) {
      const prefix = option.depth > 0 ? `${"· ".repeat(option.depth)}` : "";
      collectionSelect.createEl("option", {
        text: `${prefix}${option.label}`,
        value: option.collectionKey,
      }).selected = option.collectionKey === this.collectionKey;
    }
    collectionSelect.disabled = this.libraryID === null || this.busy;
    collectionSelect.addEventListener("change", () => {
      this.collectionKey = collectionSelect.value;
      this.selectedKey = undefined;
      void this.persistScope();
      void this.loadItemsOnly();
    });

    const searchRow = toolbar.createDiv({ cls: "unizero-library__search-row" });
    const search = searchRow.createEl("input", {
      cls: "unizero-library__search",
      type: "search",
      placeholder: "Search this collection",
      value: this.filter,
    });
    search.addEventListener("input", () => {
      this.filter = search.value;
      this.renderBody();
    });

    const refresh = searchRow.createEl("button", {
      cls: "unizero-library__refresh",
      attr: { "aria-label": "Refresh from Zotero", title: "Refresh" },
    });
    setIcon(refresh, "refresh-cw");
    refresh.disabled = this.busy;
    refresh.addEventListener("click", () => { void this.refresh(); });
  }

  private renderStatus(container: HTMLElement): void {
    const visible = this.visibleItems().length;
    const total = this.items.length;
    const name = this.scopeName || "Library";
    const text = this.busy && total
      ? `Refreshing… · ${name}`
      : `${visible}/${total} · ${name}`;
    container.createDiv({ cls: "unizero-library__status", text });
  }

  private renderRow(parent: HTMLElement, item: BridgeCollectionItem): void {
    const row = parent.createEl("button", { cls: "unizero-library__item" });
    row.toggleClass(
      "is-selected",
      this.selectedKey === item.itemKey && this.libraryID === item.libraryID,
    );
    row.setAttr("title", item.title || "Untitled");

    row.createDiv({
      cls: "unizero-library__item-title",
      text: item.title || "Untitled",
    });
    const meta = [
      item.authors[0],
      item.year,
    ].filter(Boolean).join(" · ");
    if (meta) {
      row.createDiv({ cls: "unizero-library__item-meta", text: meta });
    }

    const badges = row.createDiv({ cls: "unizero-library__item-badges" });
    if (item.hasPDF) {
      badges.createSpan({ cls: "unizero-badge", text: "PDF" });
    }
    if (item.hasMarkdown) {
      badges.createSpan({ cls: "unizero-badge", text: "MD" });
    }

    row.addEventListener("click", () => {
      this.selectedKey = item.itemKey;
      this.renderBody();
      const ref: PaperRef = {
        libraryID: item.libraryID,
        itemKey: item.itemKey,
      };
      void this.plugin.showInDetailView(ref);
    });

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showItemMenu(event, item);
    });
  }

  private showItemMenu(event: MouseEvent, item: BridgeCollectionItem): void {
    const ref: PaperRef = {
      libraryID: item.libraryID,
      itemKey: item.itemKey,
    };
    const menu = new Menu();

    menu.addItem((entry) => entry
      .setTitle("Open paper pane")
      .setIcon("graduation-cap")
      .onClick(() => {
        this.selectedKey = item.itemKey;
        this.renderBody();
        void this.plugin.showInDetailView(ref);
      }));

    menu.addItem((entry) => entry
      .setTitle("Insert citation")
      .setIcon("plus")
      .onClick(() => this.plugin.insertCitation(ref)));

    menu.addSeparator();

    menu.addItem((entry) => entry
      .setTitle("Show in Zotero")
      .setIcon("external-link")
      .onClick(async () => {
        try {
          const paper = await this.plugin.bridge.paper(ref);
          await openInZotero(paper);
        } catch (error) {
          new Notice(`UniZero: ${(error as Error).message}`);
        }
      }));

    menu.addItem((entry) => entry
      .setTitle("Open PDF in Zotero")
      .setIcon("file-text")
      .onClick(async () => {
        try {
          const paper = await this.plugin.bridge.paper(ref);
          await openZoteroPdf(paper);
        } catch (error) {
          new Notice(`UniZero: ${(error as Error).message}`);
        }
      }));

    menu.addItem((entry) => entry
      .setTitle("Open Markdown note")
      .setIcon("file-symlink")
      .onClick(async () => {
        try {
          const paper = await this.plugin.bridge.paper(ref);
          await openMarkdownNote(this.app, paper, this.plugin.settings);
        } catch (error) {
          new Notice(`UniZero: ${(error as Error).message}`);
        }
      }));

    menu.showAtMouseEvent(event);
  }
}

function libraryLabel(library: BridgeLibrary): string {
  if (library.type === "group") {
    return `${library.name} (group)`;
  }
  return library.name;
}
