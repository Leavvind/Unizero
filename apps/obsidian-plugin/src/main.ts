/**
 * UniZero for Obsidian.
 *
 * The plugin owns no bibliographic data. Zotero, the reference cache, and the
 * Paper catalog all live in the add-on, and everything here is a view of them
 * reached over the localhost bridge. That is the whole design: one backend, two
 * front ends, and no second copy of the identity rules to drift out of step.
 *
 * Notes store standard Markdown links. Zotero identity remains libraryID/itemKey;
 * Vault identity is a logical vaultID and the document's existing UID.
 */

import {
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TFile,
  TFolder,
  type Editor,
  type WorkspaceLeaf,
} from "obsidian";
import {
  addManageItems,
  artifactState,
  chooseTemplateAndConvert,
  convertToMarkdown,
  type ActionContext,
  hasRaw,
  openCanvas,
  openRaw,
  openZoteroPdf,
} from "./actions";
import { randomUUID } from "crypto";
import { uniqueTimestampUID, VaultIdentity } from "./vaultIdentity";
import { ExternalIndex, localFileIO } from "./externalIndex";
import type { SourceDocument } from "./linkIndex";
import { parseLinkTargetForNavigation, serializeLinkTarget, markdownLink, type LinkTarget, validIdentity } from "./linkTarget";
import { openLinkTarget } from "./linkOpening";
import { BACKLINKS_VIEW_TYPE, BacklinksView } from "./backlinksView";
import { chooseLinkLocation } from "./linkPicker";
import { scanDocumentLinks, retargetInlineLink, type DocumentLink } from "./documentLinks";
import { confirm } from "./choiceModal";
import { UnizeroBridge, BRIDGE_API, type BridgePaper } from "./bridge";
import { CanvasCapture, isCaptureMode } from "./capture/canvasCapture";
import {
  citationText,
  type PaperRef,
} from "./citation";
import { DETAIL_VIEW_TYPE, UnizeroDetailView } from "./detailView";
import { LIBRARY_VIEW_TYPE, UnizeroLibraryView } from "./libraryView";
import { PaperStore } from "./paperStore";
import { linkLivePreview, type LinkHost } from "./render";
import { LibrarySearchModal } from "./searchModal";
import { CitationSuggest } from "./suggest";
import { LinkTargetSuggest, openSuggestions } from "./targetSuggest";
import { isIndexedNote, VaultIndex } from "./vaultIndex";
import {
  DEFAULT_SETTINGS,
  UnizeroSettingTab,
  type UnizeroSettings,
} from "./settings";

export default class UnizeroPlugin extends Plugin implements LinkHost {
  settings: UnizeroSettings = { ...DEFAULT_SETTINGS };
  bridge!: UnizeroBridge;
  store!: PaperStore;
  vaultIndex!: VaultIndex;
  capture!: CanvasCapture;
  identity!: VaultIdentity;
  externalIndex?: ExternalIndex;
  currentDocument?: TFile;
  currentExternal?: SourceDocument;
  externalDocumentPath?: string;
  private stopped = false;
  private externalTimer?: number;
  private documents = new Map<Document, () => void>();
  private cursorParse?: { text: string; links: DocumentLink[] };
  /**
   * Last Markdown leaf the user focused. Sidebars steal `activeEditor`, so
   * Insert citation falls back to this rather than failing with "no editor".
   */
  private lastMarkdownLeaf: WorkspaceLeaf | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.bridge = new UnizeroBridge(() => this.settings.endpoint);
    this.store = new PaperStore(this.bridge);
    this.identity = new VaultIdentity(() => this.settings);
    this.vaultIndex = new VaultIndex(this.app, this.identity);

    // Obsidian fires `create` for every existing file while the vault loads, so
    // that listener waits for layout-ready; `initialize` covers what came before.
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) { return; }
      void this.vaultIndex.initialize();
      void this.configureExternalIndex();
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (file instanceof TFile && isIndexedNote(file)) {
          void this.vaultIndex.indexFile(file);
        }
      }));
    });

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && isIndexedNote(file)) {
        this.vaultIndex.scheduleFile(file);
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) {
        this.vaultIndex.removeFile(file.path);
      } else if (file instanceof TFolder) {
        this.vaultIndex.removeFolder(file.path);
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) {
        void this.vaultIndex.renameFile(oldPath, file);
      } else if (file instanceof TFolder) {
        void this.vaultIndex.renameFolder(oldPath, file.path);
      }
    }));

    this.registerView(BACKLINKS_VIEW_TYPE, (leaf) => new BacklinksView(leaf, this));
    this.registerView(DETAIL_VIEW_TYPE, (leaf) => new UnizeroDetailView(leaf, this));
    this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new UnizeroLibraryView(leaf, this));

    this.registerEditorExtension(linkLivePreview(this));
    this.registerEditorSuggest(new CitationSuggest(this.app, this));
    this.registerEditorSuggest(new LinkTargetSuggest(this.app, this));
    this.addSettingTab(new UnizeroSettingTab(this.app, this));

    this.capture = new CanvasCapture(this);
    this.capture.register();

    // Remember the note the user was editing so sidebar Insert still has a target.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view instanceof MarkdownView) {
        this.lastMarkdownLeaf = leaf;
        this.followDocument(leaf.view.file);
      }
    }));
    const currentMd = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (currentMd) {
      this.lastMarkdownLeaf = currentMd.leaf;
      this.followDocument(currentMd.file);
    }

    this.addRibbonIcon("graduation-cap", "UniZero Item pane", () => {
      void this.revealDetailView();
    });
    this.addRibbonIcon("library", "UniZero library pane", () => {
      void this.revealLibraryView();
    });

    this.addCommand({
      id: "open-detail-pane",
      name: "Open the Item pane",
      callback: () => { void this.revealDetailView(); },
    });

    this.addCommand({
      id: "open-library-pane",
      name: "Open the library pane",
      callback: () => { void this.revealLibraryView(); },
    });

    this.addCommand({
      id: "search-library",
      name: "Search the Zotero library",
      callback: () => { new LibrarySearchModal(this.app, this).open(); },
    });

    this.addCommand({
      id: "refresh-papers",
      name: "Reload paper metadata from Zotero",
      callback: () => {
        this.store.invalidate();
        new Notice("UniZero: reloading paper metadata from Zotero.");
      },
    });

    this.installLinkHandlers(document);
    this.app.workspace.iterateAllLeaves((leaf) => this.installLinkHandlers(leaf.view.containerEl.ownerDocument));
    this.registerEvent(this.app.workspace.on("window-open", (_win, window) => this.installLinkHandlers(window.document)));
    this.registerEvent(this.app.workspace.on("window-close", (_win, window) => { this.documents.get(window.document)?.(); this.documents.delete(window.document); }));
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.followDocument(file)));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      const link = this.linkAtCursor(editor);
      if (link) { menu.addItem((item) => item.setTitle("UniZero: choose link location…").onClick(() => { void this.relocateEditorLink(editor, link.from, link.to, link.raw, link.target); })); }
    }));
    this.registerObsidianProtocolHandler("unizero", (params) => {
      const target = parseLinkTargetForNavigation(params.target || "");
      if (target) { this.openLink(target); } else { new Notice("UniZero: invalid transport target."); }
    });
    this.addCommand({ id: "open-backlinks", name: "Open UniZero Backlinks", callback: () => { void this.revealBacklinks(); } });
    this.addCommand({ id: "refresh-links", name: "Rebuild document links", callback: () => { void this.refreshLinks(true); } });
    this.addCommand({ id: "set-document-uid", name: "Set current document UID", callback: () => { void this.assignDocumentUID(); } });
    this.addCommand({ id: "link-selection", name: "Link selection to a paper or document…", editorCallback: (editor) => {
      // `[selection](@)` with the caret after `@`: the search writes only the URL.
      // The selection keeps its own formatting; only line breaks and bare brackets,
      // which would end the label early, are neutralised.
      const label = editor.getSelection().replace(/\r?\n/g, " ").replace(/(?<!\\)[[\]]/g, "\\$&"), from = editor.getCursor("from");
      editor.replaceSelection(`[${label}](@)`);
      const offset = editor.posToOffset(from) + label.length + 4;
      editor.setCursor(editor.offsetToPos(offset));
      openSuggestions(this.app, editor, this.app.workspace.getActiveFile());
    } });
    this.addCommand({ id: "insert-document-link", name: "Insert a document link…", callback: () => { void this.insertDocumentLink(); } });
    this.addCommand({ id: "relocate-link", name: "Choose location for the UniZero link at the cursor…", callback: () => {
      const editor = this.resolveCitationEditor(); if (!editor) { return; }
      const link = this.linkAtCursor(editor);
      if (link) { void this.relocateEditorLink(editor, link.from, link.to, link.raw, link.target).catch((e) => this.reportError(e)); }
      else { new Notice("Place the cursor inside a UniZero Markdown link first."); }
    } });
    this.addCommand({
      id: "test-connection",
      name: "Test the Zotero connection",
      callback: () => { void this.testConnection(); },
    });
  }

  onunload(): void {
    // Registered views, extensions, and processors are released by Plugin's own
    // teardown; the store's listeners belong to elements that go with them.
    this.stopped = true;
    window.clearInterval(this.externalTimer);
    this.externalIndex?.dispose();
    for (const cleanup of this.documents.values()) { cleanup(); }
    this.documents.clear();
    this.vaultIndex?.dispose();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<UnizeroSettings> | null;
    // Vault Canvas paths from before Canvas became a Zotero attachment. Kept
    // unread so the user can migrate those notes; never share DEFAULT_SETTINGS' {}.
    const links = loaded?.canvasLinks
      && typeof loaded.canvasLinks === "object"
      && !Array.isArray(loaded.canvasLinks)
      ? { ...loaded.canvasLinks }
      : {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      canvasLinks: links,
    };
    if (!this.settings.vaultID || !validIdentity(this.settings.vaultID)) {
      this.settings.vaultID = randomUUID(); await this.saveData(this.settings);
    }
    if (!Array.isArray(this.settings.sourceLibraryIDs)) { this.settings.sourceLibraryIDs = []; }
    // Settings of removed features: the vault Raw folder (Raw is a Zotero attachment
    // now) and the bare-citation pill appearance.
    for (const key of ["literatureFolder", "itemKeyProperty", "citekeyProperty", "pillLabel", "pillStyle"]) {
      delete (this.settings as unknown as Record<string, unknown>)[key];
    }
    if (typeof this.settings.showSubcollectionItems !== "boolean") {
      this.settings.showSubcollectionItems = DEFAULT_SETTINGS.showSubcollectionItems;
    }
    if (!isCaptureMode(this.settings.captureMode)) {
      this.settings.captureMode = DEFAULT_SETTINGS.captureMode;
    }
  }

  async saveSettings(effect: "reconnect" | "none" = "reconnect"): Promise<void> {
    await this.saveData(this.settings);
    // The endpoint may have moved, so discard bridge-backed state.
    if (effect === "reconnect") { this.store.invalidate(); }
  }

  /** What Raw and Canvas actions need; built per use so settings stay current. */
  actionContext(): ActionContext {
    return {
      app: this.app,
      bridge: this.bridge,
      defaultTemplate: this.settings.defaultTemplate,
      changed: (ref) => this.paperChanged(ref),
    };
  }

  /** Re-read a paper whose Raw or Canvas changed, everywhere it is shown. */
  paperChanged(ref: PaperRef): void {
    void this.store.reload(ref);
    for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)) {
      if (leaf.view instanceof UnizeroLibraryView) { void leaf.view.reloadItems(); }
    }
  }

  /** Every action that applies to a paper, for link and library menus. */
  showMenu(event: MouseEvent, ref: PaperRef, paper: BridgePaper): void {
    const menu = new Menu();

    menu.addItem((item) => item
      .setTitle("Open paper pane")
      .setIcon("graduation-cap")
      .onClick(() => { void this.showInDetailView(ref); }));

    if (hasRaw(paper)) {
      menu.addItem((item) => item
        .setTitle("Open Raw")
        .setIcon("file-symlink")
        .onClick(() => { void openRaw(paper, this.actionContext()); }));
    } else {
      menu.addItem((item) => item
        .setTitle("Convert to Markdown")
        .setIcon("file-down")
        .onClick(() => {
          void convertToMarkdown(this.bridge, ref, paper, this.settings.defaultTemplate);
        }));
      menu.addItem((item) => item
        .setTitle("Convert with template…")
        .setIcon("list")
        .onClick(() => {
          void chooseTemplateAndConvert(
            this.bridge, ref, event, this.settings.defaultTemplate, paper,
          );
        }));
    }

    menu.addItem((item) => item
      .setTitle("Open Canvas")
      .setIcon("layout-dashboard")
      .onClick(() => {
        void openCanvas(this.actionContext(), paper);
      }));

    menu.addItem((item) => item
      .setTitle("Open PDF in Zotero")
      .setIcon("file-text")
      .onClick(() => { void openZoteroPdf(paper); }));

    addManageItems(menu, this.actionContext(), paper, artifactState(paper), event);

    menu.addSeparator();

    menu.addItem((item) => item
      .setTitle("Copy citation")
      .setIcon("copy")
      .onClick(() => { void navigator.clipboard.writeText(citationText(paper)); }));

    menu.showAtMouseEvent(event);
  }

  // --- Detail pane --------------------------------------------------------

  /** Open the pane without changing which paper it shows. */
  private async revealDetailView(): Promise<UnizeroDetailView | undefined> {
    const existing = this.app.workspace.getLeavesOfType(DETAIL_VIEW_TYPE)[0];
    const leaf: WorkspaceLeaf | null = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("UniZero could not open a sidebar pane.");
      return;
    }
    if (!existing) {
      await leaf.setViewState({ type: DETAIL_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof UnizeroDetailView ? leaf.view : undefined;
  }

  async showInDetailView(ref: PaperRef): Promise<void> {
    const view = await this.revealDetailView();
    view?.show(ref);
  }

  // --- Library pane -------------------------------------------------------

  /**
   * Open the collection browser in a new tab, or reveal it wherever it already is
   * (a pane the user dragged into a sidebar stays there).
   */
  private async revealLibraryView(): Promise<UnizeroLibraryView | undefined> {
    const existing = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0];
    const leaf: WorkspaceLeaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) {
      await leaf.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof UnizeroLibraryView ? leaf.view : undefined;
  }

  /**
   * Insert a citation at the cursor of a Markdown editor.
   *
   * Clicking a sidebar steals focus, so `activeEditor` is usually null when
   * Insert is chosen from the library or paper pane. Fall back to the last
   * Markdown note the user had open (and any still-open Markdown leaf).
   */
  insertCitation(ref: PaperRef): boolean {
    const editor = this.resolveCitationEditor();
    if (!editor) {
      new Notice(
        "Open a Markdown note first, then insert — or drag the paper into the note.",
      );
      return false;
    }
    const state = this.store.peek(ref);
    if (state?.status === "ready") { editor.replaceSelection(citationText(state.paper)); }
    else {
      // The selection as it was when the user asked, so a late insert still replaces it.
      const from = editor.getCursor("from"), to = editor.getCursor("to"), original = editor.getValue();
      void this.store.load(ref).then((loaded) => {
        if (loaded.status !== "ready") { new Notice("UniZero: paper metadata is unavailable."); return; }
        if (editor.getValue() !== original) { new Notice("UniZero: the note changed; insert the citation again."); return; }
        editor.replaceRange(citationText(loaded.paper), from, to);
      });
    }
    // Keep the sidebar focused so the user can insert several papers in a row.
    return true;
  }

  /**
   * Best available editor for citation insert, in priority order:
   * active editor (note / canvas card) → active Markdown view → last Markdown
   * leaf → any open Markdown leaf.
   */
  private resolveCitationEditor(): Editor | null {
    const activeEditor = this.app.workspace.activeEditor?.editor;
    if (activeEditor) { return activeEditor; }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.editor) { return activeView.editor; }

    if (this.lastMarkdownLeaf) {
      const view = this.lastMarkdownLeaf.view;
      if (view instanceof MarkdownView && view.editor) {
        return view.editor;
      }
    }

    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (let i = leaves.length - 1; i >= 0; i -= 1) {
      const view = leaves[i].view;
      if (view instanceof MarkdownView && view.editor) {
        return view.editor;
      }
    }
    return null;
  }

  /**
   * The UniZero Markdown link under the cursor. A full parse costs hundreds of
   * milliseconds on a long Raw, so a note without a UniZero link is never parsed,
   * and repeated menus on an unchanged note reuse the last parse.
   */
  private linkAtCursor(editor: Editor): DocumentLink | undefined {
    const text = editor.getValue();
    if (!text.includes("unizero://")) { return undefined; }
    if (this.cursorParse?.text !== text) { this.cursorParse = { text, links: scanDocumentLinks(text, parseLinkTargetForNavigation) }; }
    const offset = editor.posToOffset(editor.getCursor());
    return this.cursorParse.links.find((l) => offset >= l.from && offset <= l.to);
  }
  reportError(error: unknown): void { new Notice(`UniZero: ${(error as Error).message || error}`, 8000); }
  openLink(target: LinkTarget): void { void openLinkTarget(this, target).catch((error) => this.reportError(error)); }
  linkMenu(event: MouseEvent, target: LinkTarget): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Open link target").onClick(() => this.openLink(target)));
    menu.addItem((item) => item.setTitle("Copy UniZero target").onClick(() => { void navigator.clipboard.writeText(serializeLinkTarget(target)); }));
    menu.addItem((item) => item.setTitle("Choose location and copy new target…").onClick(() => {
      void chooseLinkLocation(this, target).then((chosen) => { if (chosen) { void navigator.clipboard.writeText(serializeLinkTarget(chosen)); } }).catch((e) => this.reportError(e));
    }));
    if (target.kind === "paper") {
      menu.addItem((item) => item.setTitle("Paper actions…").onClick(() => {
        void this.store.load(target).then((state) => { if (state.status === "ready") { this.showMenu(event, target, state.paper); } else { new Notice("UniZero: paper unavailable."); } });
      }));
    }
    menu.showAtMouseEvent(event);
  }
  private installLinkHandlers(doc: Document): void {
    if (this.documents.has(doc)) { return; }
    const handler = (event: MouseEvent) => {
      if (event.type === "auxclick" && event.button !== 1) { return; }
      const anchor = (event.target as Element)?.closest?.("a[href]");
      const target = parseLinkTargetForNavigation(anchor?.getAttribute("href") || "");
      if (!target) { return; }
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === "contextmenu") { this.linkMenu(event, target); } else { this.openLink(target); }
    };
    const events = ["click", "auxclick", "contextmenu"] as const;
    for (const type of events) { doc.addEventListener(type, handler, true); }
    this.documents.set(doc, () => { for (const type of events) { doc.removeEventListener(type, handler, true); } });
  }
  private followDocument(file: TFile | null): void {
    if (!file || !["md", "canvas"].includes(file.extension)) { return; }
    if (!isIndexedNote(file)) { this.externalDocumentPath = file.path; this.currentExternal = this.externalIndex?.findPath(file.path); }
    else if (file.extension === "md") { this.currentDocument = file; this.currentExternal = undefined; this.externalDocumentPath = undefined; }
    else { return; }
    this.vaultIndex.links.notify();
  }
  async configureExternalIndex(): Promise<void> {
    this.externalIndex?.dispose(); window.clearInterval(this.externalTimer);
    if (!this.settings.indexZoteroSources || this.stopped) {
      this.externalIndex = undefined;
      for (const [key, record] of this.vaultIndex.links.records) {
        if (record.source.kind === "zotero") { this.vaultIndex.links.remove(key, false); }
      }
      this.vaultIndex.links.coverage = { ...this.vaultIndex.links.coverage, state: "partial", scope: "Zotero sources disabled" };
      this.vaultIndex.links.notify(); return;
    }
    const path = `${this.manifest.dir}/link-index-v1.json`;
    const service = this.externalIndex = new ExternalIndex(this.vaultIndex.links, this.bridge, {
      ...localFileIO,
      loadCache: async () => await this.app.vault.adapter.exists(path) ? this.app.vault.adapter.read(path) : null,
      saveCache: (text) => this.app.vault.adapter.write(path, text),
    }, () => this.settings.sourceLibraryIDs);
    await service.load();
    if (this.stopped || service !== this.externalIndex) { return; }
    void service.refresh();
    this.externalTimer = window.setInterval(() => { void service.refresh(); }, 60000);
  }
  /** Reads what changed; `rebuild` parses every document again. */
  async refreshLinks(rebuild = false): Promise<void> {
    await Promise.all([this.vaultIndex.initialize({ changedOnly: !rebuild }), this.settings.indexZoteroSources ? this.externalIndex?.refresh(rebuild) : undefined]);
  }
  async revealBacklinks(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(BACKLINKS_VIEW_TYPE)[0];
    const leaf = existing || this.app.workspace.getRightLeaf(false);
    if (!leaf) { return; }
    if (!existing) { await leaf.setViewState({ type: BACKLINKS_VIEW_TYPE, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  async assignDocumentUID(): Promise<void> {
    const file = this.currentDocument;
    if (!file) { new Notice("Open a Vault Markdown document first."); return; }
    const existing = this.identity.get(file.path)?.uid;
    if (existing) { new Notice(`This document already has UID ${existing}.`); return; }
    const uid = await this.setDocumentUID(file);
    if (uid) { new Notice(`Document UID set to ${uid}.`); }
  }
  /**
   * The document's UID, generating one when it has none: a local timestamp,
   * moved forward a second at a time past any UID the Vault already uses, written
   * to the configured property without asking. Returns undefined when no UID
   * can be written (filename UIDs, or an index still rebuilding).
   */
  async setDocumentUID(file: TFile): Promise<string | undefined> {
    const current = this.identity.get(file.path)?.uid;
    if (current) { return current; }
    if (this.settings.uidSource !== "property") { new Notice(`"${file.basename}" has no UID. Name it using your configured filename convention.`); return undefined; }
    // Only what changed since the last pass needs reading to rule out a duplicate UID.
    await this.vaultIndex.initialize({ changedOnly: true });
    if (this.vaultIndex.links.vaultState !== "complete") { new Notice("Finish rebuilding the Vault identity index before assigning a UID."); return undefined; }
    const used = this.identity.usedUIDs(file.path);
    const uid = uniqueTimestampUID(new Date(), (candidate) => used.has(candidate));
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm[this.settings.uidProperty] = uid; });
    await this.vaultIndex.indexFile(file);
    return uid;
  }
  /** A UID for a linked note, generated and written when it has none. */
  async uidForLinking(path: string): Promise<string | undefined> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice(`Document not found: ${path}`); return undefined; }
    return this.setDocumentUID(file);
  }
  async newVaultIdentity(): Promise<void> {
    if (!await confirm(this.app, { title: "Treat this copy as a new Vault?", message: "Existing UniZero links to the old Vault identity will no longer resolve in this copy. Document UIDs remain the same.", action: "Create new Vault identity" })) { return; }
    this.settings.vaultID = randomUUID(); await this.saveSettings("none"); await this.vaultIndex.initialize();
  }
  private async relocateEditorLink(editor: Editor, from: number, to: number, raw: string, target: LinkTarget): Promise<void> {
    const chosen = await chooseLinkLocation(this, target);
    if (!chosen) { return; }
    const text = editor.getValue();
    if (text.slice(from, to) !== raw) { new Notice("The link changed while the chooser was open. Try again."); return; }
    editor.transaction({ changes: [{ from: editor.offsetToPos(from), to: editor.offsetToPos(to), text: retargetInlineLink(raw, chosen) }] });
  }
  async insertDocumentLink(): Promise<void> {
    const { pick } = await import("./linkPicker");
    const note = await pick(this.app, "Search Vault documents by title, path or UID", this.identity.search("", Infinity).map((n) => ({ label: `${n.path} · ${n.uid || "no UID"}`, value: n })));
    if (!note) { return; }
    const uid = note.uid || await this.uidForLinking(note.path);
    if (!uid) { return; }
    const target: LinkTarget = { kind: "note", vaultID: this.settings.vaultID, uid };
    const chosen = await chooseLinkLocation(this, target);
    if (chosen) {
      this.resolveCitationEditor()?.replaceSelection(markdownLink(note.title, chosen));
    }
  }

  async testConnection(): Promise<void> {
    try {
      const ping = await this.bridge.ping();
      if (ping.api !== BRIDGE_API) {
        new Notice(
          `UniZero: the Zotero add-on speaks bridge API ${ping.api}, this plugin ` +
          `speaks ${BRIDGE_API}. Update whichever is older.`,
          8000,
        );
        return;
      }
      new Notice(ping.ready
        ? `UniZero ${ping.addonVersion} connected.`
        : `UniZero ${ping.addonVersion} is reachable but still starting — open a Zotero window.`);
    } catch (error) {
      new Notice(
        `UniZero could not reach Zotero at ${this.settings.endpoint}: ` +
        `${(error as Error).message}`,
        8000,
      );
    }
  }
}
