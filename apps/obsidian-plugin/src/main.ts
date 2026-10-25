/**
 * UniZero for Obsidian.
 *
 * The plugin owns no bibliographic data. Zotero, the reference cache, and the
 * Paper catalog all live in the add-on, and everything here is a view of them
 * reached over the localhost bridge. That is the whole design: one backend, two
 * front ends, and no second copy of the identity rules to drift out of step.
 *
 * Notes store `@libraryID/itemKey`. Search at the `@` prompt is free text; the
 * pill shows Author (year) or title so the opaque key never has to be read.
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
import { UnizeroBridge, BRIDGE_API, type BridgePaper } from "./bridge";
import { CanvasCapture, isCaptureMode } from "./capture/canvasCapture";
import {
  citationText,
  type CitationAction,
  type PaperRef,
} from "./citation";
import { DETAIL_VIEW_TYPE, UnizeroDetailView } from "./detailView";
import { LIBRARY_VIEW_TYPE, UnizeroLibraryView } from "./libraryView";
import { PaperStore } from "./paperStore";
import type { PillHost } from "./pill";
import { citationLivePreview, citationPostProcessor } from "./render";
import { CitationSuggest } from "./suggest";
import { isIndexedNote, VaultIndex } from "./vaultIndex";
import {
  DEFAULT_SETTINGS,
  UnizeroSettingTab,
  type UnizeroSettings,
} from "./settings";

export default class UnizeroPlugin extends Plugin implements PillHost {
  settings: UnizeroSettings = { ...DEFAULT_SETTINGS };
  bridge!: UnizeroBridge;
  store!: PaperStore;
  vaultIndex!: VaultIndex;
  capture!: CanvasCapture;
  /**
   * Last Markdown leaf the user focused. Sidebars steal `activeEditor`, so
   * Insert citation falls back to this rather than failing with "no editor".
   */
  private lastMarkdownLeaf: WorkspaceLeaf | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.bridge = new UnizeroBridge(() => this.settings.endpoint);
    this.store = new PaperStore(this.bridge);
    this.vaultIndex = new VaultIndex(this.app);

    // Obsidian fires `create` for every existing file while the vault loads, so
    // that listener waits for layout-ready; `initialize` covers what came before.
    this.app.workspace.onLayoutReady(() => {
      void this.vaultIndex.initialize();
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (file instanceof TFile && isIndexedNote(file)) {
          void this.vaultIndex.indexFile(file);
        }
      }));
    });

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && isIndexedNote(file)) {
        void this.vaultIndex.indexFile(file);
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

    this.registerView(DETAIL_VIEW_TYPE, (leaf) => new UnizeroDetailView(leaf, this));
    this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new UnizeroLibraryView(leaf, this));

    this.registerMarkdownPostProcessor(citationPostProcessor(this));
    this.registerEditorExtension(citationLivePreview(this));
    this.registerEditorSuggest(new CitationSuggest(this.app, this));
    this.addSettingTab(new UnizeroSettingTab(this.app, this));

    this.capture = new CanvasCapture(this);
    this.capture.register();

    // Remember the note the user was editing so sidebar Insert still has a target.
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view instanceof MarkdownView) {
        this.lastMarkdownLeaf = leaf;
      }
    }));
    const currentMd = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (currentMd) {
      this.lastMarkdownLeaf = currentMd.leaf;
    }

    this.addRibbonIcon("graduation-cap", "UniZero paper pane", () => {
      void this.revealDetailView();
    });
    this.addRibbonIcon("library", "UniZero library pane", () => {
      void this.revealLibraryView();
    });

    this.addCommand({
      id: "open-detail-pane",
      name: "Open the paper pane",
      callback: () => { void this.revealDetailView(); },
    });

    this.addCommand({
      id: "open-library-pane",
      name: "Open the library pane",
      callback: () => { void this.revealLibraryView(); },
    });

    this.addCommand({
      id: "refresh-papers",
      name: "Re-read every citation from Zotero",
      callback: () => {
        this.store.invalidate();
        new Notice("UniZero: re-reading citations from Zotero.");
      },
    });

    this.addCommand({
      id: "test-connection",
      name: "Test the Zotero connection",
      callback: () => { void this.testConnection(); },
    });
  }

  onunload(): void {
    // Registered views, extensions, and processors are released by Plugin's own
    // teardown; the store's listeners belong to elements that go with them.
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
    // Raw no longer lives in a vault folder (it is a Zotero attachment); drop those settings.
    for (const key of ["literatureFolder", "itemKeyProperty", "citekeyProperty"]) {
      delete (this.settings as unknown as Record<string, unknown>)[key];
    }
    // Early builds used "citekey" as a pill label; map it onto the durable form.
    if ((this.settings.pillLabel as string) === "citekey") {
      this.settings.pillLabel = "itemKey";
    }
    if (!["framed", "highlight", "solid"].includes(this.settings.pillStyle)) {
      this.settings.pillStyle = DEFAULT_SETTINGS.pillStyle;
    }
    if (typeof this.settings.showSubcollectionItems !== "boolean") {
      this.settings.showSubcollectionItems = DEFAULT_SETTINGS.showSubcollectionItems;
    }
    if (!isCaptureMode(this.settings.captureMode)) {
      this.settings.captureMode = DEFAULT_SETTINGS.captureMode;
    }
  }

  async saveSettings(
    effect: "reconnect" | "rerender" | "none" = "reconnect",
  ): Promise<void> {
    await this.saveData(this.settings);
    if (effect === "reconnect") {
      // The endpoint may have moved, so discard bridge-backed state.
      this.store.invalidate();
    } else if (effect === "rerender") {
      // Appearance is local derived state and must never cause bridge traffic.
      this.store.refresh();
    }
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

  // --- PillHost -----------------------------------------------------------

  activate(action: CitationAction, ref: PaperRef, paper: BridgePaper, page?: number): void {
    if (action === "markdown") {
      void openRaw(paper, this.actionContext());
      return;
    }
    if (action === "pdf") {
      void openZoteroPdf(paper, page);
      return;
    }
    void this.showInDetailView(ref);
  }

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
      .onClick(() => { void navigator.clipboard.writeText(citationText(ref)); }));

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
    editor.replaceSelection(citationText(ref));
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
