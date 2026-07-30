/**
 * Thin view for the Collection workbench and per-paper relation browser.
 *
 * All Zotero, provider, cache, and conversion work lives behind
 * window.arguments[0].api. This file owns only display state and DOM events.
 */

"use strict";

var api = window.arguments[0].api;

var LiteratureExplorer = {
  strings: api.strings,
  context: null,
  /** Stable Project and default Board documents for the active Collection scope. */
  project: null,
  boardSelectedNodeID: null,
  boardSelectedEdgeID: null,
  boardConnectSourceID: null,
  boardViewportProjectID: null,
  mode: "collection",
  collectionSnapshot: null,
  collectionBusy: false,
  collectionRequest: 0,
  contextGeneration: 0,
  activeItemKey: null,
  kind: "references",
  snapshot: null,
  busy: false,
  /**
   * Open paper tabs, in strip order. The Collection is always the first tab and is
   * not in this list. `activeTab` is -1 whenever Collection remains selected.
   *
   * Only one detail view exists in the DOM. A tab holds the state that view would
   * be in, and switching writes the outgoing state out and the incoming state back
   * — cheaper than a view per tab, and it means a paper reopened from a cached
   * snapshot costs no provider call.
   */
  tabs: [],
  activeTab: -1,
  /**
   * Transient owner of the Detail View beside the Collection graph. It deliberately
   * lives outside `tabs`: selecting another node replaces it instead of growing the
   * tab strip. An explicit Open action may promote it into a real paper tab.
   */
  collectionPreview: null,
  /** "combined" or a RelationSourceKey — which source's list the table shows. */
  activeSource: "combined",
  /** "graph" or "table" — which surface leads the collection overview. */
  collectionMode: "graph",
  /** Live force-graph views, created lazily on first use. */
  graphs: { collection: null, detail: null },
  graphLoaded: { collection: false, detail: null },
  /** Unfiltered graphs as returned by the API; filters derive views from these. */
  graphData: { collection: null, detail: null },
  /** Collection-board filters. Detail graph filters live on their paper state. */
  graphFilters: { links: "all", minShared: 1 },
  /** Saved node coordinates for this library, seeded into the simulation. */
  graphLayout: null,
  /** Display and force settings, shared by both graphs and stored across sessions. */
  graphSettings: null,
  dropdowns: {},
  filters: {
    library: "all",
    influence: "all",
    publicationType: "all",
    publicationLevel: "all",
    order: "original",
  },

  init() {
    this.applyStrings();
    this.configureControls();
    this.setCollectionMode(this.collectionMode);
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => this.switchKind(tab.dataset.kind));
    });
    document.getElementById("collection-search")
      .addEventListener("input", () => this.renderCollection());
    document.getElementById("collection-refresh")
      .addEventListener("click", () => this.loadCollection());
    document.getElementById("toggle-library-pane")
      .addEventListener("click", () => this.toggleLibraryPane());
    document.getElementById("collapse-detail")
      .addEventListener("click", () => this.showCollection());
    document.getElementById("board-connect")
      .addEventListener("click", () => this.toggleBoardConnect());
    document.getElementById("board-delete")
      .addEventListener("click", () => this.deleteBoardSelection());
    let boardSurface = document.getElementById("project-board-surface");
    boardSurface.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    boardSurface.addEventListener("drop", (event) => this.dropPaperOnBoard(event));
    window.addEventListener("mousemove", (event) => this.moveBoardNodeDrag(event));
    window.addEventListener("mouseup", (event) => this.finishBoardNodeDrag(event));
    document.getElementById("search").addEventListener("input", (event) => {
      let tab = this.activeTabState();
      if (tab) tab.search = event.target.value;
      this.render();
    });
    document.getElementById("year-from").addEventListener("input", (event) => {
      let tab = this.activeTabState();
      if (tab) tab.yearFrom = event.target.value;
      this.render();
    });
    document.getElementById("year-to").addEventListener("input", (event) => {
      let tab = this.activeTabState();
      if (tab) tab.yearTo = event.target.value;
      this.render();
    });
    document.getElementById("refresh").addEventListener("click", () => this.refreshActive());
    document.getElementById("load-more").addEventListener("click", () => this.loadMore());
    // The hover card is fixed-positioned, so dismiss it whenever the table scrolls
    // out from under it or the window loses focus.
    let detailScroll = document.querySelector("#detail-view .table-wrap");
    if (detailScroll) {
      detailScroll.addEventListener("scroll", () => this.cancelRowPreview());
    }
    window.addEventListener("blur", () => this.cancelRowPreview());
    window.addEventListener("unload", () => this.destroy());
    document.getElementById("collection-mode-graph")
      .addEventListener("click", () => this.setCollectionMode("graph"));
    document.getElementById("collection-mode-table")
      .addEventListener("click", () => this.setCollectionMode("table"));
    // Canvas size is not derivable from CSS alone; force-graph needs explicit
    // pixel dimensions, so every layout change has to be pushed into it.
    window.addEventListener("resize", () => this.resizeGraphs());
    // The graph hover card anchors to the pointer rather than to a table row.
    window.addEventListener("mousemove", (event) => {
      this._pointer = { x: event.clientX, y: event.clientY };
    });
    ["collection", "detail"].forEach((which) => {
      let gear = document.getElementById(which + "-graph-gear");
      if (gear) {
        gear.addEventListener("click", (event) => {
          event.stopPropagation();
          this.toggleGraphPanel(which);
        });
      }
    });
    // One dismissal path for both transient surfaces: anything that is not a click
    // inside them closes them. The menu has to exclude itself, because mousedown
    // precedes click — dismissing on it would hide every entry before its own
    // click could ever land.
    window.addEventListener("mousedown", (event) => {
      let inside = (selector) =>
        Boolean(event.target.closest && event.target.closest(selector));
      if (!inside(".graph-menu")) this.hideGraphMenu();
      if (!inside(".graph-panel, .graph-gear")) this.closeGraphPanels();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.hideGraphMenu();
        this.closeGraphPanels();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") &&
          (this.boardSelectedNodeID || this.boardSelectedEdgeID) &&
          !event.target?.closest?.("input, textarea, [contenteditable]")) {
        event.preventDefault();
        void this.deleteBoardSelection();
        return;
      }
      // Ctrl+W closes the paper, never the window: the Collection tab is not
      // closable, so on it the shortcut does nothing rather than quitting.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        if (this.activeTab >= 0) this.closeTab(this.activeTab);
      }
    });
    this.renderTabs();
    this.reloadContext();
  },

  applyStrings() {
    let s = this.strings;
    document.title = s.title;
    document.getElementById("app-title").textContent = s.title;
    document.getElementById("label-collection-search").textContent = s.searchLabel;
    document.getElementById("collection-search").placeholder = s.collectionSearch;
    document.getElementById("collection-refresh").textContent = s.refresh;
    document.getElementById("project-library-title").textContent = s.projectLibrary;
    document.getElementById("project-board-empty-title").textContent = s.boardEmpty;
    document.getElementById("project-board-empty-hint").textContent = s.boardHint;
    document.getElementById("toggle-library-pane").textContent = "◀";
    document.getElementById("toggle-library-pane").title = s.collapseLibrary;
    document.getElementById("collapse-detail").textContent = "▶";
    document.getElementById("collapse-detail").title = s.collapseDetail;
    document.getElementById("board-connect").textContent = s.boardConnect;
    document.getElementById("board-delete").textContent = s.boardDelete;
    this.updateBoardControls();
    document.getElementById("collection-head-title").textContent = s.titleColumn;
    document.getElementById("collection-head-creator").textContent = s.creatorColumn;
    document.getElementById("collection-head-year").textContent = s.yearColumn;
    document.getElementById("collection-head-date-added").textContent =
      s.dateAddedColumn;
    document.getElementById("collection-head-markdown").textContent = s.markdownColumn;
    document.getElementById("collection-head-references").textContent = s.references;
    document.getElementById("collection-head-citations").textContent = s.citations;
    document.getElementById("tab-graph").textContent = s.graphTab;
    document.getElementById("collection-mode-graph").textContent = s.graphView;
    document.getElementById("collection-mode-table").textContent = s.tableView;
    document.getElementById("label-collection-links").textContent = s.graphLinksLabel;
    document.getElementById("label-collection-shared").textContent = s.graphMinShared;
    document.getElementById("label-detail-links").textContent = s.graphLinksLabel;
    document.getElementById("label-detail-shared").textContent = s.graphMinShared;
    document.getElementById("collection-graph-empty").textContent = s.graphEmpty;
    document.getElementById("detail-graph-empty").textContent = s.graphEmpty;
    document.getElementById("tab-references").textContent = s.references;
    document.getElementById("tab-relation").textContent = s.relation;
    document.getElementById("tab-citations").textContent = s.citations;
    document.getElementById("label-search").textContent = s.searchLabel;
    document.getElementById("label-source").textContent = s.sourceFilterLabel;
    document.getElementById("label-library").textContent = s.libraryStatusLabel;
    document.getElementById("label-influence").textContent = s.influenceLabel;
    document.getElementById("label-year").textContent = s.yearLabel;
    document.getElementById("label-publication-type").textContent =
      s.publicationTypeLabel;
    document.getElementById("label-publication-level").textContent =
      s.publicationLevelLabel;
    document.getElementById("label-order").textContent = s.orderLabel;
    document.getElementById("search").placeholder = s.search;
    document.getElementById("year-from").placeholder = s.yearFrom;
    document.getElementById("year-to").placeholder = s.yearTo;
    document.getElementById("refresh").textContent = s.refresh;
    document.getElementById("load-more").textContent = s.loadMore;
    document.getElementById("head-title").textContent = s.titleColumn;
    document.getElementById("head-year").textContent = s.yearColumn;
    document.getElementById("head-citations").textContent = s.citationsColumn;
    document.getElementById("head-influence").textContent = s.influenceColumn;
    document.getElementById("head-source").textContent = s.sourceColumn;
    document.getElementById("head-library").textContent = s.libraryColumn;
  },

  configureControls() {
    let rerender = (name) => (value) => {
      this.filters[name] = value;
      let tab = this.activeTabState();
      if (tab) tab.filters[name] = value;
      this.render();
    };
    this.dropdowns.source = this.createDropdown(
      "filter-source",
      [["combined", this.strings.combinedSource]],
      "combined",
      (value) => this.selectSource(value),
    );
    this.dropdowns.library = this.createDropdown("filter-library", [
      ["all", this.strings.allLibrary],
      ["in", this.strings.inLibrary],
      ["out", this.strings.notInLibrary],
    ], "all", rerender("library"));
    this.dropdowns.influence = this.createDropdown("filter-influence", [
      ["all", this.strings.allInfluence],
      ["influential", this.strings.influentialOnly],
    ], "all", rerender("influence"));
    this.dropdowns.publicationType = this.createDropdown(
      "filter-publication-type",
      [
        ["all", this.strings.allPublicationTypes],
        ["journal", this.strings.journalArticle],
        ["conference", this.strings.conferencePaper],
        ["preprint", this.strings.preprint],
        ["book", this.strings.book],
        ["other", this.strings.otherPublicationType],
      ],
      "all",
      rerender("publicationType"),
    );
    this.dropdowns.publicationLevel = this.createDropdown(
      "filter-publication-level",
      [["all", this.strings.allPublicationLevels]],
      "all",
      rerender("publicationLevel"),
    );
    this.dropdowns.collectionLinks = this.createDropdown("filter-collection-links", [
      ["all", this.strings.graphLinksAll],
      ["cites", this.strings.graphLinksCites],
      ["coupled", this.strings.graphLinksCoupled],
    ], "all", (value) => {
      this.graphFilters.links = value;
      this.applyGraphFilters("collection");
    });
    document.getElementById("collection-min-shared")
      .addEventListener("input", (event) => {
        let value = Number.parseInt(event.target.value, 10);
        this.graphFilters.minShared = Number.isFinite(value) && value > 0 ? value : 1;
        this.applyGraphFilters("collection");
      });
    this.dropdowns.detailLinks = this.createDropdown("filter-detail-links", [
      ["all", this.strings.graphLinksAll],
      ["cites", this.strings.graphLinksCites],
      ["coupled", this.strings.graphLinksCoupled],
    ], "all", (value) => {
      let tab = this.activeTabState();
      if (!tab) return;
      tab.graphFilters.links = value;
      this.applyGraphFilters("detail");
    });
    document.getElementById("detail-min-shared")
      .addEventListener("input", (event) => {
        let tab = this.activeTabState();
        if (!tab) return;
        let value = Number.parseInt(event.target.value, 10);
        tab.graphFilters.minShared = Number.isFinite(value) && value > 0 ? value : 1;
        this.applyGraphFilters("detail");
      });
    this.dropdowns.order = this.createDropdown("sort", [
      ["original", this.strings.originalOrder],
      ["influential", this.strings.influentialFirst],
      ["cited", this.strings.mostCited],
      ["shared", this.strings.mostShared],
      ["newest", this.strings.newest],
    ], "original", rerender("order"));
  },

  createDropdown(idOrHost, initialOptions, initialValue, onChange) {
    let host = typeof idOrHost === "string"
      ? document.getElementById(idOrHost)
      : idOrHost;
    if (!host) { throw new Error("Dropdown host is unavailable"); }
    host.className = "dropdown";
    host.replaceChildren();

    let toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dropdown-toggle";
    toggle.setAttribute("aria-haspopup", "listbox");
    toggle.setAttribute("aria-expanded", "false");

    let label = document.createElement("span");
    label.className = "dropdown-label";
    let caret = document.createElement("span");
    caret.className = "dropdown-caret";
    caret.textContent = "▼";
    toggle.append(label, caret);

    let menu = document.createElement("div");
    menu.className = "dropdown-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    host.append(toggle, menu);

    let options = [];
    let value = initialValue;
    let close = () => {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    };
    let position = () => {
      let rect = toggle.getBoundingClientRect();
      menu.style.minWidth = `${rect.width}px`;
      menu.style.maxWidth = `${Math.max(rect.width, window.innerWidth - 12)}px`;
      let left = Math.max(6, Math.min(rect.left, window.innerWidth - rect.width - 6));
      let top = rect.bottom + 4;
      let height = Math.min(menu.scrollHeight, 320);
      if (top + height > window.innerHeight - 6) {
        top = Math.max(6, rect.top - height - 4);
      }
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    };
    let focusChosen = () => {
      let chosen = menu.querySelector(".chosen") || menu.firstElementChild;
      if (chosen) chosen.focus();
    };
    let open = () => {
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      position();
    };
    let select = (nextValue, notify) => {
      let match = options.find((option) => option[0] === nextValue);
      if (!match) return;
      value = nextValue;
      label.textContent = match[1];
      menu.querySelectorAll(".dropdown-option").forEach((option) => {
        let chosen = option.dataset.value === value;
        option.classList.toggle("chosen", chosen);
        option.setAttribute("aria-selected", String(chosen));
      });
      close();
      if (notify) onChange(value);
    };
    let focusSibling = (current, offset) => {
      let items = Array.from(menu.querySelectorAll(".dropdown-option"));
      let index = items.indexOf(current);
      let target = items[(index + offset + items.length) % items.length];
      if (target) target.focus();
    };
    let renderOptions = () => {
      menu.replaceChildren();
      options.forEach(([optionValue, optionLabel]) => {
        let option = document.createElement("button");
        option.type = "button";
        option.className = "dropdown-option";
        option.dataset.value = optionValue;
        option.textContent = optionLabel;
        option.setAttribute("role", "option");
        option.addEventListener("click", () => select(optionValue, true));
        option.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusSibling(option, event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            let target = event.key === "Home"
              ? menu.firstElementChild
              : menu.lastElementChild;
            if (target) target.focus();
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
            toggle.focus();
          }
        });
        menu.append(option);
      });
      select(value, false);
    };

    toggle.addEventListener("click", () => {
      if (menu.hidden) open();
      else close();
    });
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open();
        focusChosen();
      } else if (event.key === "Escape") {
        close();
      }
    });
    let dismiss = (event) => {
      if (!host.contains(event.target) && !menu.contains(event.target)) close();
    };
    document.addEventListener("mousedown", dismiss, true);
    window.addEventListener("resize", close);

    options = initialOptions.slice();
    renderOptions();
    return {
      getValue: () => value,
      setValue: (nextValue) => select(nextValue, false),
      setOptions: (nextOptions, preferredValue) => {
        options = nextOptions.slice();
        value = options.some((option) => option[0] === preferredValue)
          ? preferredValue
          : options[0][0];
        renderOptions();
      },
      destroy: () => {
        document.removeEventListener("mousedown", dismiss, true);
        window.removeEventListener("resize", close);
      },
    };
  },

  activeTabState() {
    if (this.mode === "split") return this.collectionPreview;
    return this.tabs[this.activeTab] || null;
  },

  contextIsCurrent(generation) {
    return generation === this.contextGeneration;
  },

  beginTabRequest(tab, channel) {
    if (!tab) return 0;
    tab.requests[channel] = (tab.requests[channel] || 0) + 1;
    return tab.requests[channel];
  },

  tabRequestIsCurrent(tab, channel, request, generation) {
    return this.contextIsCurrent(generation) &&
      (this.tabs.includes(tab) || this.collectionPreview === tab) &&
      tab.requests[channel] === request;
  },

  tabIsActive(tab) {
    return Boolean(tab) && this.activeTabState() === tab;
  },

  /**
   * Tear down state whose identity is the current Collection/library.
   *
   * A reused window can cross both boundaries. Keeping a live simulation or a
   * settled callback across that transition lets old coordinates be written under
   * the new library ID, so the views are destroyed rather than merely emptied.
   */
  destroyGraphs() {
    ["collection", "detail"].forEach((which) => this.cancelGraphRefit(which));
    ["collection", "detail"].forEach((which) => {
      if (this.graphs[which] && typeof LiteratureGraph !== "undefined") {
        LiteratureGraph.destroy(this.graphs[which]);
      }
    });
    this.graphs = { collection: null, detail: null };
    this.graphLoaded = { collection: false, detail: null };
    this.graphData = { collection: null, detail: null };
    this.graphLayout = null;
    this._layoutHooked = {};
    this._graphErrors = {};
    this._graphRequests = { collection: 0 };
  },

  destroy() {
    this.contextGeneration += 1;
    this.collectionRequest += 1;
    window.clearTimeout(this._settingsSave);
    this._settingsSave = null;
    this.destroyGraphs();
    this.collectionPreview = null;
    this.cancelRowPreview();
    this.hideGraphMenu();
  },

  reloadContext() {
    this.contextGeneration += 1;
    this.collectionRequest += 1;
    this.destroyGraphs();
    let nextContext = api.getContext();
    this.context = nextContext
      ? Object.assign({}, nextContext, {
        scope: nextContext.scope ? Object.assign({}, nextContext.scope) : null,
      })
      : null;
    this.collectionSnapshot = null;
    this.project = null;
    this.boardSelectedNodeID = null;
    this.boardSelectedEdgeID = null;
    this.boardConnectSourceID = null;
    this._boardPointer = null;
    let workspace = document.getElementById("explorer-workspace");
    if (workspace) {
      delete workspace.dataset.projectId;
      delete workspace.dataset.boardId;
    }
    this.renderProjectLibrary([]);
    this.renderProjectBoard();
    this.collectionBusy = false;
    this.snapshot = null;
    this.busy = false;
    // A reused window can be pointed at a different Collection, or a different
    // library. Tabs are keyed by item key within one scope, so they do not carry
    // across — keeping them would resolve the same key against the wrong library.
    this.tabs = [];
    this.activeTab = -1;
    this.collectionPreview = null;
    this.activeItemKey = this.context && this.context.itemKey || null;
    this.kind = this.context && this.context.kind || "references";
    document.getElementById("collection-refresh").disabled = false;
    document.getElementById("refresh").disabled = false;
    document.getElementById("load-more").disabled = false;
    document.getElementById("collection-search").value = "";
    if (this.context && this.context.mode === "item" && this.activeItemKey) {
      this.resetFilters();
      this.showDetail(this.activeItemKey, this.kind);
    } else {
      this.loadCollection();
    }
  },

  showView(mode) {
    this.mode = mode;
    document.getElementById("collection-view").hidden = mode === "detail";
    document.getElementById("detail-view").hidden = mode === "collection";
    document.getElementById("explorer-workspace")
      .classList.toggle("split-mode", mode === "split");
  },

  // ------------------------------------------------------------------ Tab strip

  /**
   * Move the live detail view's state into its owning tab or Collection preview.
   *
   * The view keeps some of its state in the DOM — the search box and the year
   * range have no model behind them — so a plain object copy would lose it and
   * the tab would come back filtered differently from how it was left.
   */
  captureTab() {
    let tab = this.activeTabState();
    if (!tab) return;
    let scroller = document.querySelector("#detail-view .table-wrap");
    tab.kind = this.kind;
    tab.snapshot = this.snapshot;
    tab.activeSource = this.activeSource;
    tab.filters = Object.assign({}, this.filters);
    tab.search = document.getElementById("search").value;
    tab.yearFrom = document.getElementById("year-from").value;
    tab.yearTo = document.getElementById("year-to").value;
    tab.scroll = scroller ? scroller.scrollTop : 0;
    tab.graphData = this.graphData.detail;
    tab.graphLoaded = this.graphLoaded.detail;
    tab.busy = this.busy;
  },

  /** Put a paper state's data back into the one detail view and redraw from it. */
  async restoreTab(tab, viewMode) {
    this.showView(viewMode === "split" ? "split" : "detail");
    this.activeItemKey = tab.itemKey;
    this.kind = tab.kind;
    this.snapshot = tab.snapshot;
    this.activeSource = tab.activeSource;
    this.filters = Object.assign({}, tab.filters);
    document.getElementById("search").value = tab.search;
    document.getElementById("year-from").value = tab.yearFrom;
    document.getElementById("year-to").value = tab.yearTo;
    this.graphData.detail = tab.graphData;
    this.graphLoaded.detail = tab.graphLoaded;
    this.busy = Boolean(tab.busy);
    this.setBusy(this.busy, tab);
    this.syncDetailGraphFilters(tab);
    this.stopProgress();
    document.getElementById("paper-title").textContent =
      tab.title || this.strings.loading;
    this.renderTabs();
    // Before any load, so a new tab never shows the previous tab's selections
    // while its own data is still on the way.
    ["library", "influence", "publicationType"].forEach((name) => {
      this.dropdowns[name].setValue(this.filters[name]);
    });
    this.configureSources();
    this.configurePublicationLevels();
    this.configureSort(false);
    this.configureKindPresentation();

    if (tab.kind === "graph") {
      // One graph view serves every tab, so it is showing whichever paper was
      // last centred; returning to a tab has to re-point it, early-return or not.
      if (tab.graphData && this.graphs.detail) {
        this.applyGraphData("detail", tab.graphData);
      } else if (tab.graphBusy) {
        this.setStatus(this.strings.loading);
      } else if (!tab.graphBusy) {
        // Nothing cached, or the view never got built. Either way the marker this
        // tab carries would make a plain load decide it had nothing to do.
        this.graphLoaded.detail = null;
        await this.loadDetailGraph(false);
      }
      return;
    }
    // A tab visited before still holds its snapshot, so coming back to it is a
    // redraw and not another round of provider calls.
    if (!tab.snapshot && !tab.busy) {
      await this.load(false);
      return;
    }
    this.render();
    let scroller = document.querySelector("#detail-view .table-wrap");
    if (scroller) scroller.scrollTop = tab.scroll || 0;
  },

  newPaperState(itemKey, kind) {
    let known = this.collectionSnapshot && this.collectionSnapshot.items
      .find((item) => item.itemKey === itemKey);
    return {
      itemKey,
      title: known ? known.title : "",
      kind: kind || "references",
      snapshot: null,
      activeSource: "combined",
      // Same starting point resetFilters uses; a fresh paper state is not the
      // previous detail owner's filters carried over.
      filters: {
        library: "all",
        influence: "all",
        publicationType: "all",
        publicationLevel: "all",
        order: kind === "citations" ? "influential" : "original",
      },
      search: "",
      yearFrom: "",
      yearTo: "",
      scroll: 0,
      graphData: null,
      graphLoaded: null,
      graphBusy: false,
      graphError: "",
      graphFilters: { links: "all", minShared: 1 },
      busy: false,
      error: "",
      requests: {
        snapshot: 0,
        graph: 0,
        action: 0,
      },
      contextGeneration: this.contextGeneration,
    };
  },

  /**
   * Open a paper, or come back to it if it is already open.
   *
   * Tab identity is the paper, not the relation kind: a second tab on the same
   * paper showing a different tab of the same window is a duplicate to keep in
   * sync, not a second workspace.
   */
  async openPaper(itemKey, kind) {
    if (!itemKey) return;
    let index = this.tabs.findIndex((tab) => tab.itemKey === itemKey);
    if (index === -1) {
      this.captureTab();
      let preview = this.collectionPreview;
      let state = preview && preview.itemKey === itemKey
        ? preview
        : this.newPaperState(itemKey, kind);
      this.collectionPreview = null;
      this.tabs.push(state);
      index = this.tabs.length - 1;
      this.activeTab = index;
      await this.restoreTab(this.tabs[index]);
      return;
    }
    if (index === this.activeTab) {
      if (kind && kind !== this.kind) await this.switchKind(kind);
      this.collectionPreview = null;
      this.showView("detail");
      this.renderTabs();
      this.resizeGraphs();
      return;
    }
    this.captureTab();
    this.collectionPreview = null;
    this.activeTab = index;
    if (kind) this.tabs[index].kind = kind;
    await this.restoreTab(this.tabs[index]);
  },

  async activateTab(index) {
    if (index === this.activeTab) {
      if (index < 0 && this.mode === "split") {
        this.captureTab();
        this.showCollection();
        this.renderTabs();
        this.resizeGraphs();
      }
      return;
    }
    this.captureTab();
    this.collectionPreview = null;
    this.activeTab = index;
    if (index < 0) {
      this.showCollection();
      this.renderTabs();
      return;
    }
    await this.restoreTab(this.tabs[index]);
  },

  async closeTab(index) {
    let tab = this.tabs[index];
    if (!tab) return;
    let wasActive = index === this.activeTab;
    if (wasActive) {
      // Nothing to write back into a tab that is going away, and capturing would
      // read the DOM into a record about to be dropped.
      this.activeTab = -1;
    } else if (index < this.activeTab) {
      this.activeTab -= 1;
    }
    this.tabs.splice(index, 1);
    if (!wasActive) {
      this.renderTabs();
      return;
    }
    // Land on the neighbour a browser would pick: the tab that slid into this
    // slot, else the one before it, else the Collection.
    let next = Math.min(index, this.tabs.length - 1);
    if (next < 0) {
      this.showCollection();
      this.renderTabs();
      return;
    }
    this.activeTab = next;
    await this.restoreTab(this.tabs[next]);
  },

  /** The heading and the tab carry the same name; keep them from disagreeing. */
  setPaperTitle(title) {
    document.getElementById("paper-title").textContent = title;
    let tab = this.activeTabState();
    if (!tab || tab.title === title) return;
    tab.title = title;
    if (this.tabs.includes(tab)) this.renderTabs();
  },

  renderTabs() {
    let strip = document.getElementById("page-tabs");
    if (!strip) return;
    strip.replaceChildren();
    let s = this.strings;

    let chip = (label, title, active, onClick, onClose) => {
      let button = document.createElement("button");
      button.className = "page-tab" + (active ? " active" : "");
      button.title = title;
      let text = document.createElement("span");
      text.className = "page-tab-label";
      text.textContent = label;
      button.append(text);
      button.addEventListener("click", onClick);
      if (onClose) {
        // Middle-click closes, the way it does in every tabbed window.
        button.addEventListener("auxclick", (event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose();
        });
        let close = document.createElement("button");
        close.className = "page-tab-close";
        close.textContent = "×";
        close.title = s.closeTab;
        close.addEventListener("click", (event) => {
          event.stopPropagation();
          onClose();
        });
        button.append(close);
      }
      strip.append(button);
    };

    let scopeName = this.collectionSnapshot && this.collectionSnapshot.scope
      ? this.collectionSnapshot.scope.name
      : s.collectionOverview;
    chip(scopeName, scopeName, this.mode !== "detail",
      () => this.activateTab(-1));
    this.tabs.forEach((tab, index) => {
      let label = tab.title || this.strings.loading;
      chip(label, label, this.mode === "detail" && index === this.activeTab,
        () => this.activateTab(index), () => this.closeTab(index));
    });
  },

  async loadCollection() {
    if (this.collectionBusy) return;
    let generation = this.contextGeneration;
    let request = ++this.collectionRequest;
    let scope = this.context && this.context.scope
      ? Object.assign({}, this.context.scope)
      : null;
    this.collectionPreview = null;
    this.showView("collection");
    this.collectionBusy = true;
    document.getElementById("collection-refresh").disabled = true;
    document.getElementById("paper-title").textContent =
      this.context && this.context.scope ? this.context.scope.name :
        this.strings.collectionOverview;
    this.setCollectionStatus(this.strings.loading);
    // An explicit refresh should rebuild the board as well as the table.
    this.graphLoaded.collection = false;
    this.graphData.collection = null;
    try {
      let [project, snapshot] = await Promise.all([
        api.project ? api.project(scope) : Promise.resolve(null),
        api.collectionSnapshot(scope),
      ]);
      if (!this.contextIsCurrent(generation) || request !== this.collectionRequest) return;
      this.project = project;
      this.collectionSnapshot = snapshot;
      let workspace = document.getElementById("explorer-workspace");
      if (workspace && project) {
        workspace.dataset.projectId = project.project.id;
        workspace.dataset.boardId = project.defaultBoard.id;
      }
      this.positionBoardViewport(project.project.id);
      document.getElementById("paper-title").textContent =
        this.collectionSnapshot.scope.name;
      // The Collection tab is labelled with the scope, which is only known now.
      this.renderTabs();
      this.renderCollection();
    } catch (error) {
      if (!this.contextIsCurrent(generation) || request !== this.collectionRequest) return;
      this.collectionSnapshot = null;
      this.setCollectionStatus(this.strings.error + ": " + String(error), true);
      this.renderCollection();
    } finally {
      if (this.contextIsCurrent(generation) && request === this.collectionRequest) {
        this.collectionBusy = false;
        document.getElementById("collection-refresh").disabled = false;
      }
    }
  },

  showCollection() {
    this.collectionPreview = null;
    this.activeTab = -1;
    this.showView("collection");
    this.renderTabs();
    if (!this.collectionSnapshot) {
      this.loadCollection();
      return;
    }
    document.getElementById("paper-title").textContent =
      this.collectionSnapshot.scope.name;
    this.renderCollection();
    // Pick up anything loaded since the overview was built — a detail visit here, or
    // the item pane / a prior session — so the badges stop lying about "not loaded".
    this.refreshCollectionStatuses();
  },

  async refreshCollectionStatuses() {
    if (!this.collectionSnapshot || !api.refreshCollectionStatuses) return;
    let generation = this.contextGeneration;
    let snapshot = this.collectionSnapshot;
    let libraryID = this.context && this.context.scope
      ? this.context.scope.libraryID
      : null;
    let keys = snapshot.items.map((item) => item.itemKey);
    if (!keys.length) return;
    try {
      let statuses = await api.refreshCollectionStatuses(libraryID, keys);
      if (!this.contextIsCurrent(generation) || this.collectionSnapshot !== snapshot) return;
      let changed = false;
      snapshot.items.forEach((item) => {
        let next = statuses[item.itemKey];
        if (!next) return;
        item.references = next.references;
        item.citations = next.citations;
        changed = true;
      });
      if (changed && this.mode === "collection") this.renderCollection();
    } catch (error) {
      // Best-effort: a status refresh failure must not disrupt the overview.
    }
  },

  visibleCollectionItems() {
    if (!this.collectionSnapshot) return [];
    let query = document.getElementById("collection-search")
      .value.trim().toLocaleLowerCase();
    return this.collectionSnapshot.items
      .filter((item) => {
        if (!query) return true;
        return [
          item.title,
          item.year,
          item.publicationTitle,
        ].concat(item.creators || []).join(" ").toLocaleLowerCase().includes(query);
      })
      .slice()
      .sort((left, right) =>
        String(right.dateAdded || "").localeCompare(String(left.dateAdded || "")) ||
        String(left.title || "").localeCompare(String(right.title || "")));
  },

  // ------------------------------------------------------------------ Graph

  setCollectionMode(mode) {
    this.collectionMode = mode;
    document.getElementById("collection-view")
      .classList.toggle("table-mode", mode === "table");
    document.getElementById("collection-mode-graph")
      .classList.toggle("active", mode === "graph");
    document.getElementById("collection-mode-table")
      .classList.toggle("active", mode === "table");
    if (mode === "table" && this.mode === "split") {
      this.captureTab();
      this.showCollection();
    }
    if (mode === "graph") {
      this.loadCollectionGraph();
      this.resizeGraphs();
    }
  },

  /**
   * Build a graph view on demand.
   *
   * Creating it eagerly would start a force simulation for a surface the user may
   * never open, and force-graph needs a laid-out container to size its canvas.
   */
  ensureGraph(which) {
    if (this.graphs[which]) return this.graphs[which];
    let containerId = which === "collection" ? "collection-graph" : "detail-graph";
    let container = document.getElementById(containerId);
    if (!container || typeof LiteratureGraph === "undefined") return null;
    try {
      this.graphs[which] = LiteratureGraph.create(container, {
        settings: this.graphSettings || undefined,
        onHover: (node) => this.onGraphHover(which, node),
        onSelect: (node) => this.onGraphSelect(which, node),
        onOpen: (node) => this.onGraphOpen(node),
        onContext: (node, event) => this.showGraphMenu(which, node, event),
        onError: (message) => this.onGraphError(which, message),
        onClearError: () => this.onGraphClearError(which),
      });
    } catch (error) {
      this.setGraphEmpty(which, this.strings.error + ": " + String(error));
      return null;
    }
    LiteratureGraph.resize(this.graphs[which]);
    return this.graphs[which];
  },

  async loadCollectionGraph(force) {
    // The graph is scoped to the same Collection as the table, so it waits for the
    // overview snapshot rather than racing it.
    if (!this.collectionSnapshot) return;
    if (this.graphLoaded.collection && !force) {
      this.resizeGraphs();
      return;
    }
    let view = this.ensureGraph("collection");
    if (!view || !api.graph) return;
    this._graphRequests = this._graphRequests || { collection: 0 };
    let request = ++this._graphRequests.collection;
    let generation = this.contextGeneration;
    let scope = this.context && this.context.scope
      ? Object.assign({}, this.context.scope)
      : null;
    let libraryID = scope && scope.libraryID;
    this.graphLoaded.collection = true;
    try {
      let [data] = await Promise.all([
        api.graph(scope),
        this.ensureGraphLayout(libraryID),
      ]);
      if (!this.contextIsCurrent(generation) ||
          request !== this._graphRequests.collection) {
        return;
      }
      this.applyGraphData("collection", data);
    } catch (error) {
      if (!this.contextIsCurrent(generation) ||
          request !== this._graphRequests.collection) {
        return;
      }
      this.graphLoaded.collection = false;
      this.setGraphEmpty("collection", this.strings.error + ": " + String(error));
    }
  },

  async loadDetailGraph(force) {
    let tab = this.activeTabState();
    if (!tab || !api.focusedGraph) return;
    if (tab.graphLoaded === tab.itemKey && tab.graphData && !force) {
      if (this.tabIsActive(tab)) {
        this.graphData.detail = tab.graphData;
        this.graphLoaded.detail = tab.graphLoaded;
      }
      this.resizeGraphs();
      return;
    }
    let view = this.ensureGraph("detail");
    if (!view) return;
    let generation = this.contextGeneration;
    let request = this.beginTabRequest(tab, "graph");
    let itemKey = tab.itemKey;
    let scope = this.context && this.context.scope
      ? Object.assign({}, this.context.scope)
      : null;
    let libraryID = scope && scope.libraryID;
    tab.graphBusy = true;
    tab.graphError = "";
    if (this.tabIsActive(tab)) {
      this.graphLoaded.detail = null;
      this.setStatus(this.strings.loading);
    }
    try {
      let [data] = await Promise.all([
        api.focusedGraph(itemKey, scope),
        this.ensureGraphLayout(libraryID),
      ]);
      if (!this.tabRequestIsCurrent(tab, "graph", request, generation)) return;
      tab.graphData = data;
      tab.graphLoaded = itemKey;
      tab.graphBusy = false;
      if (this.tabIsActive(tab) && tab.kind === "graph") {
        this.graphData.detail = data;
        this.graphLoaded.detail = itemKey;
        this.applyGraphData("detail", data);
      }
    } catch (error) {
      if (!this.tabRequestIsCurrent(tab, "graph", request, generation)) return;
      tab.graphLoaded = null;
      tab.graphBusy = false;
      tab.graphError = this.strings.error + ": " + String(error);
      if (this.tabIsActive(tab) && tab.kind === "graph") {
        this.graphLoaded.detail = null;
        this.setStatus(tab.graphError, true);
        this.setGraphEmpty("detail", tab.graphError);
      }
    }
  },

  applyGraphData(which, data) {
    this.graphData[which] = data;
    this.renderGraph(which, true);
  },

  /** Re-derive one or both graphs from their raw data after a filter change. */
  applyGraphFilters(which) {
    let targets = which ? [which] : ["collection", "detail"];
    targets.forEach((target) => {
      if (this.graphData[target] && this.graphs[target]) this.renderGraph(target, false);
    });
  },

  graphFiltersFor(which) {
    if (which === "collection") return this.graphFilters;
    let tab = this.activeTabState();
    return tab ? tab.graphFilters : { links: "all", minShared: 1 };
  },

  syncDetailGraphFilters(tab) {
    let filters = tab && tab.graphFilters
      ? tab.graphFilters
      : { links: "all", minShared: 1 };
    if (this.dropdowns.detailLinks) {
      this.dropdowns.detailLinks.setValue(filters.links);
    }
    document.getElementById("detail-min-shared").value = filters.minShared;
  },

  /**
   * Project the raw graph through the active filters and push it to the canvas.
   *
   * The collection board additionally honours the overview's search box, so the
   * board and the management table always describe the same set of papers.
   */
  renderGraph(which, refit) {
    let view = this.graphs[which];
    let data = this.graphData[which];
    if (!view || !data) return;
    this.cancelGraphRefit(which);
    let filtered = this.filterGraph(which, data);
    let counts = LiteratureGraph.setData(view, filtered, this.graphLayout);
    LiteratureGraph.resize(view);
    // Both surfaces now draw the same library graph, so either may contribute the
    // coordinates the other reopens with.
    this.scheduleLayoutSave(which, view);

    let s = this.strings;
    let hidden = (data.nodes || []).length - counts.nodes;
    let overlay = document.getElementById(which + "-graph-overlay");
    if (overlay) {
      overlay.replaceChildren();
      let summary = document.createElement("span");
      summary.textContent = counts.nodes + " " + s.graphNodes + " · " +
        counts.links + " " + s.graphEdges +
        (hidden > 0 ? " · " + hidden + " " + s.graphHidden : "");
      overlay.append(summary, this.graphLegend("cites"), this.graphLegend("coupled"));
      let hint = document.createElement("span");
      hint.textContent = s.graphOpenHint;
      overlay.append(hint);
      // Rebuilding the overlay must not quietly drop a reported failure.
      let failure = this._graphErrors && this._graphErrors[which];
      if (failure) {
        let note = document.createElement("span");
        note.className = "graph-error";
        note.textContent = s.error + ": " + failure;
        overlay.append(note);
      }
    }
    let empty = document.getElementById(which + "-graph-empty");
    if (empty) {
      empty.textContent = s.graphEmpty;
      empty.hidden = counts.nodes > 0;
    }
    if (which === "detail") {
      this.setStatus(counts.nodes
        ? counts.nodes + " " + s.graphNodes + " · " + counts.links + " " + s.graphEdges
        : s.relationEmpty);
    }
    if (refit) {
      this.scheduleGraphRefit(which, view, data);
    }
  },

  cancelGraphRefit(which) {
    this._refitTimers = this._refitTimers || {};
    let pending = this._refitTimers[which];
    if (!pending) return;
    window.clearTimeout(pending.fallback);
    window.clearTimeout(pending.center);
    if (pending.unsubscribe) pending.unsubscribe();
    delete this._refitTimers[which];
  },

  /**
   * Frame a fresh graph twice: a quick fallback keeps the UI useful while a cold
   * simulation is still spreading out, then engine-stop supplies the final fit.
   */
  scheduleGraphRefit(which, view, data) {
    let generation = this.contextGeneration;
    let pending = {
      fallback: null,
      center: null,
      unsubscribe: null,
    };
    let current = () =>
      this.contextIsCurrent(generation) &&
      this.graphs[which] === view &&
      this.graphData[which] === data &&
      this._refitTimers[which] === pending;
    let center = (final) => {
      window.clearTimeout(pending.center);
      if (which !== "detail") return;
      pending.center = window.setTimeout(() => {
        if (!current()) return;
        LiteratureGraph.centerOnFocus(view);
        if (final) delete this._refitTimers[which];
      }, 460);
    };
    let fit = (final) => {
      if (!current()) return;
      LiteratureGraph.zoomToFit(view);
      center(final);
      if (final) {
        window.clearTimeout(pending.fallback);
        if (pending.unsubscribe) pending.unsubscribe();
        pending.unsubscribe = null;
        // Keep the record until the centring animation starts so a new dataset can
        // still cancel it. Collection has no second animation and can finish now.
        if (which !== "detail") delete this._refitTimers[which];
      }
    };
    pending.unsubscribe = LiteratureGraph.onSettled(view, () => fit(true));
    pending.fallback = window.setTimeout(() => fit(false), 620);
    this._refitTimers[which] = pending;
  },

  filterGraph(which, data) {
    let filters = this.graphFiltersFor(which);
    let links = filters.links;
    let minShared = filters.minShared;
    let allowed = null;
    if (which === "collection") {
      // Same predicate as the table, so the two surfaces cannot disagree.
      allowed = new Set(this.visibleCollectionItems().map((item) => item.itemKey));
    }
    let nodes = (data.nodes || []).filter(
      (node) => !allowed || allowed.has(node.itemKey) || node.id === data.center,
    );
    let present = new Set(nodes.map((node) => node.id));
    let edges = (data.edges || []).filter((edge) => {
      if (!present.has(edge.source) || !present.has(edge.target)) return false;
      if (links === "cites" && edge.type !== "cites") return false;
      if (links === "coupled" && edge.type !== "coupled") return false;
      if (edge.type === "coupled" && Number(edge.weight || 1) < minShared) return false;
      return true;
    });
    // Degree describes what is actually drawn, so node sizes track the filters.
    let degrees = new Map();
    edges.forEach((edge) => {
      degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
    });
    return {
      scope: data.scope,
      center: data.center,
      nodes: nodes.map((node) => Object.assign({}, node, {
        degree: degrees.get(node.id) || 0,
      })),
      edges: edges,
    };
  },

  /**
   * Read the stored settings once per session.
   *
   * The renderer owns what these values mean, so whatever comes back from disk is
   * handed straight to it to clamp; a miss simply leaves the defaults in place.
   */
  async ensureGraphSettings() {
    if (this.graphSettings) return this.graphSettings;
    let stored = null;
    if (api.graphSettings) {
      try {
        stored = await api.graphSettings();
      } catch (error) {
        stored = null;
      }
    }
    this.graphSettings = LiteratureGraph.sanitizeSettings(stored);
    // A view created before the read finished is still on defaults.
    ["collection", "detail"].forEach((which) => {
      if (this.graphs[which]) {
        LiteratureGraph.applySettings(this.graphs[which], this.graphSettings);
      }
    });
    return this.graphSettings;
  },

  /**
   * Read the stored layout once per session; a miss is a normal cold start.
   *
   * Settings come first because the coordinates are only accepted when they were
   * produced by the same forces — see LiteratureGraph.forceSignature.
   */
  async ensureGraphLayout(libraryID) {
    if (this.graphLayout) return this.graphLayout;
    let generation = this.contextGeneration;
    let expectedLibraryID = libraryID !== undefined && libraryID !== null
      ? libraryID
      : this.context && this.context.scope && this.context.scope.libraryID;
    await this.ensureGraphSettings();
    if (!api.graphLayout) return (this.graphLayout = {});
    try {
      let layout = await api.graphLayout(
        expectedLibraryID,
        LiteratureGraph.forceSignature(this.graphSettings),
      );
      if (!this.contextIsCurrent(generation) ||
          !this.context ||
          this.context.scope.libraryID !== expectedLibraryID) {
        return {};
      }
      this.graphLayout = layout;
    } catch (error) {
      if (this.contextIsCurrent(generation)) this.graphLayout = {};
    }
    return this.graphLayout || {};
  },

  /**
   * Save the board's coordinates after the simulation stops.
   *
   * Registered once per view; the engine fires this on every settle, so the file
   * tracks the arrangement the user last saw, including nodes they dragged.
   */
  scheduleLayoutSave(which, view) {
    this._layoutHooked = this._layoutHooked || {};
    if (this._layoutHooked[which] || !api.saveGraphLayout) return;
    this._layoutHooked[which] = true;
    let generation = this.contextGeneration;
    let libraryID = this.context && this.context.scope
      ? this.context.scope.libraryID
      : null;
    LiteratureGraph.onSettled(view, () => {
      if (!this.contextIsCurrent(generation) ||
          !this.context ||
          this.context.scope.libraryID !== libraryID) {
        return;
      }
      let positions = LiteratureGraph.snapshotPositions(view);
      if (!Object.keys(positions).length) return;
      // Merge so filtered-out papers keep the position they last had.
      this.graphLayout = Object.assign({}, this.graphLayout, positions);
      api.saveGraphLayout(
        libraryID,
        this.graphLayout,
        LiteratureGraph.forceSignature(this.graphSettings),
      ).catch(() => {
        // Layout is disposable; a failed write costs one simulation next time.
      });
    });
  },

  graphLegend(type) {
    let wrap = document.createElement("span");
    wrap.className = "graph-legend";
    let swatch = document.createElement("span");
    swatch.className = "graph-swatch" + (type === "coupled" ? " coupled" : "");
    let label = document.createElement("span");
    label.textContent = type === "coupled"
      ? this.strings.graphLegendCoupled
      : this.strings.graphLegendCites;
    wrap.append(swatch, label);
    return wrap;
  },

  setGraphEmpty(which, message) {
    let empty = document.getElementById(which + "-graph-empty");
    if (!empty) return;
    empty.textContent = message;
    empty.hidden = false;
  },

  resizeGraphs() {
    ["collection", "detail"].forEach((which) => {
      if (this.graphs[which]) LiteratureGraph.resize(this.graphs[which]);
    });
  },

  /**
   * The node click is centred while Collection still owns the full width. Once
   * split mode narrows the canvas, resize first and calculate the screen centre
   * again from the selected node's unchanged graph coordinates.
   */
  recenterCollectionSelection() {
    let view = this.graphs.collection;
    if (!view || this.mode !== "split") return;
    try {
      LiteratureGraph.resize(view);
      LiteratureGraph.centerOnSelection(view, 0);
    } catch (error) {
      this.onGraphError("collection", String(error));
    }
  },

  /** Reuse the table's hover card so both surfaces describe a paper identically. */
  onGraphHover(which, node) {
    this.cancelRowPreview();
    // The node menu opens at the pointer, which is exactly where the hover card
    // already sits. Two panels describing the same node, one covering the other,
    // is worse than either alone, and the menu is the one the user just asked for.
    if (!node || this._menuOpen) return;
    // showRowPreview anchors to a rect; on canvas the meaningful anchor is the
    // pointer, so hand it a zero-size rect there instead of the whole container.
    let point = this._pointer || { x: 0, y: 0 };
    this.showRowPreview(this.graphNodeToItem(node), {
      getBoundingClientRect: () => ({
        left: point.x, right: point.x, top: point.y, bottom: point.y,
        width: 0, height: 0,
      }),
    });
  },

  onGraphSelect(which, node) {
    if (which !== "collection" || !node) return;
    this.cancelRowPreview();
    void this.showCollectionPreview(node.itemKey);
  },

  onGraphOpen(node) {
    if (!node) return;
    this.showDetail(node.itemKey, "references");
  },

  /**
   * Keep the Collection board in place while reusing the existing paper detail
   * surface on its right. This state is intentionally not a paper tab: selecting a
   * different node replaces it, while an explicit Open action promotes it.
   */
  async showCollectionPreview(itemKey) {
    if (!itemKey) return;
    if (this.collectionPreview && this.collectionPreview.itemKey === itemKey) {
      if (this.kind !== "references") await this.switchKind("references");
      return;
    }
    this.captureTab();
    this.activeTab = -1;
    this.collectionPreview = this.newPaperState(itemKey, "references");
    let restoring = this.restoreTab(this.collectionPreview, "split");
    // restoreTab enters split mode synchronously before its provider request waits.
    // Correct the viewport immediately instead of leaving a full-width canvas
    // cropped until References finishes loading.
    this.recenterCollectionSelection();
    await restoring;
  },

  // ------------------------------------------------------------ Graph settings

  toggleGraphPanel(which) {
    let panel = document.getElementById(which + "-graph-panel");
    if (!panel) return;
    let opening = panel.hidden;
    this.closeGraphPanels();
    if (!opening) return;
    this.buildGraphPanel(which);
    panel.hidden = false;
    let gear = document.getElementById(which + "-graph-gear");
    if (gear) gear.classList.add("open");
  },

  closeGraphPanels() {
    ["collection", "detail"].forEach((which) => {
      let panel = document.getElementById(which + "-graph-panel");
      if (panel) panel.hidden = true;
      let gear = document.getElementById(which + "-graph-gear");
      if (gear) gear.classList.remove("open");
    });
  },

  /**
   * Build the settings panel.
   *
   * Rebuilt on each open rather than kept in sync: it is a dozen controls over a
   * settings object that is the single source of truth, so re-reading it is both
   * shorter and impossible to desynchronise.
   */
  buildGraphPanel(which) {
    let panel = document.getElementById(which + "-graph-panel");
    if (!panel) return;
    let s = this.strings;
    let settings = this.graphSettings ||
      (this.graphSettings = LiteratureGraph.sanitizeSettings(null));
    panel.replaceChildren();

    let heading = (text) => {
      let node = document.createElement("h4");
      node.textContent = text;
      panel.append(node);
    };
    let row = (label) => {
      let wrap = document.createElement("div");
      wrap.className = "graph-setting";
      let name = document.createElement("label");
      name.textContent = label;
      wrap.append(name);
      panel.append(wrap);
      return wrap;
    };
    let slider = (label, key, min, max, step, format) => {
      let wrap = row(label);
      let value = document.createElement("span");
      value.className = "graph-setting-value";
      value.textContent = format ? format(settings[key]) : settings[key];
      let input = document.createElement("input");
      input.type = "range";
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = settings[key];
      input.addEventListener("input", () => {
        let next = Number(input.value);
        value.textContent = format ? format(next) : next;
        this.changeGraphSetting(key, next);
      });
      wrap.append(value, input);
    };
    let oneDecimal = (n) => Number(n).toFixed(1);

    heading(s.graphDisplayGroup);
    let arrows = row(s.graphArrows);
    let arrowsInput = document.createElement("input");
    arrowsInput.type = "checkbox";
    arrowsInput.checked = Boolean(settings.arrows);
    arrowsInput.addEventListener("change", () =>
      this.changeGraphSetting("arrows", arrowsInput.checked));
    arrows.append(arrowsInput);

    let colour = row(s.graphColour);
    let colourHost = document.createElement("div");
    colour.append(colourHost);
    let dropdownKey = which + "GraphColour";
    if (this.dropdowns[dropdownKey]?.destroy) {
      this.dropdowns[dropdownKey].destroy();
    }
    // Native HTML select popups render incorrectly in Zotero's privileged XHTML
    // windows (the option text is duplicated and clicks never reach `change`).
    // Use the same document-rendered listbox as the Explorer filters.
    this.dropdowns[dropdownKey] = this.createDropdown(
      colourHost,
      [["none", s.graphColourNone], ["year", s.graphColourYear]],
      settings.colourBy,
      (value) => this.changeGraphSetting("colourBy", value),
    );

    slider(s.graphTextFade, "textFade", 0, 24, 1);
    slider(s.graphNodeSize, "nodeSize", 0.25, 2.5, 0.05, (n) => Number(n).toFixed(2));
    slider(s.graphLinkThickness, "linkThickness", 0.2, 5, 0.1, oneDecimal);

    heading(s.graphForcesGroup);
    slider(s.graphCenterForce, "centerForce", 0, 1, 0.01, (n) => Number(n).toFixed(2));
    slider(s.graphRepelForce, "repelForce", 0, 4000, 50);
    slider(s.graphLinkForce, "linkForce", 0, 4, 0.1, oneDecimal);
    slider(s.graphLinkDistance, "linkDistance", 30, 800, 10);

    let reset = document.createElement("button");
    reset.className = "graph-reset";
    reset.textContent = s.graphReset;
    reset.addEventListener("click", () => {
      this.graphSettings = LiteratureGraph.sanitizeSettings(null);
      this.applyGraphSettings();
      this.buildGraphPanel(which);
    });
    panel.append(reset);
  },

  changeGraphSetting(key, value) {
    this.graphSettings = LiteratureGraph.sanitizeSettings(
      Object.assign({}, this.graphSettings, { [key]: value }),
    );
    this.applyGraphSettings();
  },

  /**
   * Push settings to both graphs and persist them.
   *
   * Applying is immediate so a dragged slider is visible while dragging; the write
   * is debounced, because a drag would otherwise mean one file write per pixel.
   */
  applyGraphSettings() {
    ["collection", "detail"].forEach((which) => {
      if (this.graphs[which]) {
        LiteratureGraph.applySettings(this.graphs[which], this.graphSettings);
      }
    });
    if (!api.saveGraphSettings) return;
    window.clearTimeout(this._settingsSave);
    this._settingsSave = window.setTimeout(() => {
      api.saveGraphSettings(this.graphSettings).catch(() => {
        // Settings are a convenience; a failed write costs the next session's
        // preferences, never data.
      });
    }, 400);
  },

  // --------------------------------------------------------------- Popup menu

  /**
   * The window's one popup menu, shared by every surface that needs one.
   *
   * `build` receives helpers rather than a list, so a caller can put a note
   * between two entries without this needing to know what a note is.
   */
  showMenu(point, title, build) {
    let menu = document.getElementById("graph-menu");
    if (!menu) return;
    this._menuOpen = true;
    this.cancelRowPreview();
    menu.replaceChildren();

    if (title) {
      let heading = document.createElement("div");
      heading.className = "graph-menu-title";
      heading.textContent = title;
      heading.title = title;
      menu.append(heading);
    }

    build({
      entry: (label, enabled, run) => {
        let button = document.createElement("button");
        button.textContent = label;
        button.disabled = !enabled;
        if (enabled) {
          button.addEventListener("click", () => {
            this.hideGraphMenu();
            run();
          });
        }
        menu.append(button);
      },
      note: (text, isError) => {
        let line = document.createElement("div");
        line.className = "graph-menu-note" + (isError ? " error" : "");
        line.textContent = text;
        line.title = text;
        menu.append(line);
      },
    });

    // Placed after mounting so the menu has a measurable size to keep on screen.
    menu.hidden = false;
    let x = point && point.x !== undefined
      ? point.x
      : this._pointer && this._pointer.x !== undefined ? this._pointer.x : 0;
    let y = point && point.y !== undefined
      ? point.y
      : this._pointer && this._pointer.y !== undefined ? this._pointer.y : 0;
    let rect = menu.getBoundingClientRect();
    menu.style.left =
      Math.max(4, Math.min(x, window.innerWidth - rect.width - 6)) + "px";
    menu.style.top =
      Math.max(4, Math.min(y, window.innerHeight - rect.height - 6)) + "px";
  },

  /**
   * Right-click menu for a node.
   *
   * Everything here already exists as an action elsewhere in the window; the menu
   * exists so the board does not force a detour through the table for them.
   */
  showGraphMenu(which, node, event) {
    if (!node) return;
    let s = this.strings;
    let key = node.itemKey;
    this._menuWhich = which;
    this.showMenu(event, node.title || node.label || "", ({ entry }) => {
      entry(s.openRelations, true, () => this.showDetail(key, "references"));
      entry(s.select, Boolean(node.itemID), () => api.selectItem(node.itemID));
      entry(s.graphOpenPdf, Boolean(node.hasPDF) && Boolean(api.openPdf), () =>
        this.runGraphAction(key, () => api.openPdf(key)));
      if (node.hasMarkdown) {
        entry(s.graphOpenObsidian, Boolean(api.openMarkdown), () =>
          this.runGraphAction(key, () => api.openMarkdown(key)));
      } else {
        entry(s.generateMarkdown, Boolean(node.hasPDF) && Boolean(api.convertItem), () =>
          this.runGraphAction(key, () => api.convertItem(key), "metadata"));
      }
      entry(s.loadReferences, true, () =>
        this.runGraphAction(key, () => api.loadRelation(key, "references"), "references"));
      entry(s.loadCitations, true, () =>
        this.runGraphAction(key, () => api.loadRelation(key, "citations"), "citations"));
    });
  },

  hideGraphMenu() {
    this._menuOpen = false;
    let menu = document.getElementById("graph-menu");
    if (menu && !menu.hidden) menu.hidden = true;
  },

  /**
   * Run a menu action, reporting on whichever surface the user is looking at.
   *
   * Actions that change a paper's state change what both surfaces should show, so
   * the updated paper the API hands back is merged into the table and the graph is
   * rebuilt — leaving either one describing the state before the click is worse
   * than the extra work.
   */
  patchGraphPaper(data, itemKey, updated) {
    if (!data || !updated) return;
    let fields = [
      "itemID", "title", "creators", "year", "publicationTitle",
      "hasPDF", "hasMarkdown",
    ];
    (data.nodes || []).forEach((node) => {
      if (node.itemKey !== itemKey) return;
      fields.forEach((field) => {
        if (updated[field] !== undefined) node[field] = updated[field];
      });
    });
  },

  patchPaperState(itemKey, updated) {
    if (!updated) return;
    let paper = this.collectionSnapshot && this.collectionSnapshot.items
      .find((item) => item.itemKey === itemKey);
    if (paper) Object.assign(paper, updated);
    this.tabs.forEach((tab) => {
      if (tab.itemKey === itemKey && tab.snapshot && tab.snapshot.seed) {
        Object.assign(tab.snapshot.seed, updated);
        if (updated.title) tab.title = updated.title;
      }
    });
    let preview = this.collectionPreview;
    if (preview && preview.itemKey === itemKey && preview.snapshot &&
        preview.snapshot.seed) {
      Object.assign(preview.snapshot.seed, updated);
      if (updated.title) preview.title = updated.title;
    }
    let graphs = new Set([this.graphData.collection, this.graphData.detail]);
    this.tabs.forEach((tab) => graphs.add(tab.graphData));
    if (preview) graphs.add(preview.graphData);
    graphs.forEach((data) => this.patchGraphPaper(data, itemKey, updated));
  },

  invalidateGraphTopology() {
    this._graphRequests = this._graphRequests || { collection: 0 };
    this._graphRequests.collection += 1;
    this.graphLoaded.collection = false;
    this.graphData.collection = null;
    this.cancelGraphRefit("collection");
    let paperStates = this.tabs.slice();
    if (this.collectionPreview && !paperStates.includes(this.collectionPreview)) {
      paperStates.push(this.collectionPreview);
    }
    paperStates.forEach((tab) => {
      this.beginTabRequest(tab, "graph");
      tab.graphData = null;
      tab.graphLoaded = null;
      tab.graphBusy = false;
      tab.graphError = "";
    });
    this.graphData.detail = null;
    this.graphLoaded.detail = null;
    this.cancelGraphRefit("detail");
  },

  async applyPaperChange(itemKey, updated, changeKind) {
    this.patchPaperState(itemKey, updated);
    if (changeKind === "references") {
      this.invalidateGraphTopology();
      if (this.mode !== "detail") this.renderCollection();
      if (this.mode !== "collection") {
        let active = this.activeTabState();
        if (active && active.kind === "graph") await this.loadDetailGraph(true);
        else this.render();
      }
      return;
    }
    if (this.mode !== "detail") this.renderCollection();
    if (this.mode !== "collection") {
      this.syncCollectionRelationStatus();
      let active = this.activeTabState();
      if (changeKind === "metadata" && active && active.kind === "graph" &&
          this.graphData.detail) {
        this.renderGraph("detail", false);
      } else if (!active || active.kind !== "graph") {
        this.render();
      }
    }
  },

  async runGraphAction(itemKey, run, changeKind) {
    let which = this._menuWhich === "detail" ? "detail" : "collection";
    let generation = this.contextGeneration;
    let tab = which === "detail" ? this.activeTabState() : null;
    let request = tab
      ? this.beginTabRequest(tab, "action")
      : ((this._collectionActionRequest || 0) + 1);
    if (!tab) this._collectionActionRequest = request;
    let current = () => {
      if (!this.contextIsCurrent(generation)) return false;
      if (tab) return this.tabRequestIsCurrent(tab, "action", request, generation);
      return this._collectionActionRequest === request;
    };
    let report = (message, isError) => {
      if (!current()) return;
      if (which === "detail") {
        if (this.tabIsActive(tab)) this.setStatus(message, isError);
      } else if (this.mode === "collection") {
        this.setCollectionStatus(message, isError);
      }
    };
    report(this.strings.loading);
    try {
      let updated = await run();
      if (!this.contextIsCurrent(generation)) return;
      // The mutation is already durable when the bridge resolves. Even if its
      // originating tab was closed, current-library derived state must be updated.
      if (changeKind) await this.applyPaperChange(itemKey, updated, changeKind);
      if (!current()) return;
      report("");
    } catch (error) {
      report(this.strings.error + ": " + String(error), true);
    }
  },

  /**
   * Surface a swallowed render-loop error.
   *
   * The graph now keeps drawing when a callback throws, which is right but would
   * otherwise hide the failure entirely — so the first one is written onto the
   * board's own status line, where it can be reported instead of guessed at.
   */
  onGraphError(which, message) {
    this._graphErrors = this._graphErrors || {};
    if (this._graphErrors[which]) return;
    this._graphErrors[which] = message;
    let overlay = document.getElementById(which + "-graph-overlay");
    if (!overlay) return;
    let note = document.createElement("span");
    note.className = "graph-error";
    note.textContent = this.strings.error + ": " + message;
    overlay.append(note);
  },

  onGraphClearError(which) {
    if (this._graphErrors) delete this._graphErrors[which];
    let overlay = document.getElementById(which + "-graph-overlay");
    let note = overlay && overlay.querySelector(".graph-error");
    if (note) note.remove();
  },

  /** Shape a graph node like a table row so the shared preview card can render it. */
  graphNodeToItem(node) {
    return {
      title: node.title,
      authors: node.creators || [],
      creators: node.creators || [],
      year: node.year,
      primaryVenue: node.publicationTitle,
      publicationTitle: node.publicationTitle,
      membership: { inLibrary: true, itemID: node.itemID },
    };
  },

  renderCollection() {
    let rows = document.getElementById("collection-rows");
    rows.replaceChildren();
    if (!this.collectionSnapshot) {
      this.renderEmpty(rows, this.collectionBusy
        ? this.strings.loading
        : this.strings.collectionEmpty, 7);
      return;
    }

    let items = this.visibleCollectionItems();
    this.renderProjectLibrary(items);
    this.renderProjectBoard();
    if (!items.length) {
      this.renderEmpty(rows, this.strings.collectionEmpty, 7);
    } else {
      items.forEach((item) => rows.append(this.renderCollectionRow(item)));
    }
    this.setCollectionStatus(
      `${items.length}/${this.collectionSnapshot.items.length} · ` +
      this.collectionSnapshot.scope.name,
    );
  },

  renderProjectLibrary(items) {
    let host = document.getElementById("project-library-list");
    host.replaceChildren();
    items.forEach((item) => {
      let entry = document.createElement("button");
      entry.className = "project-library-item";
      entry.draggable = true;
      entry.dataset.itemKey = item.itemKey;
      entry.title = item.title || "Untitled";
      let title = document.createElement("span");
      title.className = "project-library-item-title";
      title.textContent = item.title || "Untitled";
      let meta = document.createElement("span");
      meta.className = "project-library-item-meta";
      meta.textContent = [
        (item.creators || [])[0],
        item.year,
      ].filter(Boolean).join(" · ") || item.publicationTitle || "";
      entry.append(title, meta);
      entry.addEventListener("click", () =>
        this.showCollectionPreview(item.itemKey));
      entry.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) return;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(
          "application/x-unizero-paper",
          item.itemKey,
        );
        event.dataTransfer.setData("text/plain", item.itemKey);
      });
      host.append(entry);
    });
  },

  renderProjectBoard() {
    let surface = document.getElementById("project-board-surface");
    surface.querySelectorAll(".board-paper-node").forEach((node) => node.remove());
    let nodes = this.project && Array.isArray(this.project.nodes)
      ? this.project.nodes
      : [];
    this.renderBoardEdges();
    document.getElementById("project-board-empty").hidden = nodes.length > 0;
    nodes.forEach((view) => {
      let node = view.node;
      let geometry = node.geometry || {};
      let card = document.createElement("article");
      card.className = "board-paper-node";
      if (node.id === this.boardSelectedNodeID) card.classList.add("selected");
      card.dataset.nodeId = node.id;
      card.style.left = `${Number(geometry.x) || 0}px`;
      card.style.top = `${Number(geometry.y) || 0}px`;
      card.style.width = `${Number(geometry.width) || 228}px`;
      card.style.height = `${Number(geometry.height) || 118}px`;
      card.tabIndex = 0;
      let title = document.createElement("div");
      title.className = "board-node-title";
      title.textContent = view.paper.title || "Untitled";
      let meta = document.createElement("div");
      meta.className = "board-node-meta";
      meta.textContent = [
        (view.paper.authors || [])[0],
        view.paper.year,
      ].filter(Boolean).join(" · ");
      card.append(title, meta);
      card.addEventListener("mousedown", (event) =>
        this.startBoardNodeDrag(event, view, card));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.selectBoardNode(view);
        }
      });
      surface.append(card);
    });
    this.updateBoardControls();
  },

  renderBoardEdges() {
    let svg = document.getElementById("project-board-edges");
    if (!svg) return;
    svg.replaceChildren();
    let nodes = this.project && Array.isArray(this.project.nodes)
      ? this.project.nodes
      : [];
    let edges = this.project && Array.isArray(this.project.edges)
      ? this.project.edges
      : [];
    let byID = new Map(nodes.map((view) => [view.node.id, view.node]));
    let center = (node) => ({
      x: node.geometry.x + node.geometry.width / 2,
      y: node.geometry.y + node.geometry.height / 2,
    });
    edges.forEach((edge) => {
      let source = byID.get(edge.sourceNodeID);
      let target = byID.get(edge.targetNodeID);
      if (!source || !target) return;
      let from = center(source);
      let to = center(target);
      let makeLine = (className) => {
        let line = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "line",
        );
        line.setAttribute("class", className);
        line.setAttribute("x1", String(from.x));
        line.setAttribute("y1", String(from.y));
        line.setAttribute("x2", String(to.x));
        line.setAttribute("y2", String(to.y));
        line.dataset.edgeId = edge.id;
        return line;
      };
      let hit = makeLine("board-manual-edge-hit");
      hit.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selectBoardEdge(edge);
      });
      let visible = makeLine(
        "board-manual-edge" +
        (edge.id === this.boardSelectedEdgeID ? " selected" : ""),
      );
      svg.append(hit, visible);
    });
  },

  updateBoardControls() {
    let connect = document.getElementById("board-connect");
    let remove = document.getElementById("board-delete");
    if (!connect || !remove) return;
    connect.disabled = !this.boardSelectedNodeID && !this.boardConnectSourceID;
    connect.classList.toggle("active", Boolean(this.boardConnectSourceID));
    connect.textContent = this.boardConnectSourceID
      ? this.strings.boardConnecting
      : this.strings.boardConnect;
    remove.disabled = !this.boardSelectedNodeID && !this.boardSelectedEdgeID;
  },

  toggleLibraryPane() {
    let view = document.getElementById("collection-view");
    let collapsed = view.classList.toggle("library-collapsed");
    let button = document.getElementById("toggle-library-pane");
    button.textContent = collapsed ? "▶" : "◀";
    button.title = collapsed
      ? this.strings.expandLibrary
      : this.strings.collapseLibrary;
  },

  positionBoardViewport(projectID) {
    if (!projectID || this.boardViewportProjectID === projectID) return;
    this.boardViewportProjectID = projectID;
    let viewport = document.getElementById("project-board-viewport");
    // The persisted coordinate plane has generous room in every direction. Start
    // a new Project near its centre rather than at the top-left corner.
    window.setTimeout(() => {
      if (this.boardViewportProjectID !== projectID) return;
      viewport.scrollLeft = Math.max(0, (3200 - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (2200 - viewport.clientHeight) / 2);
    }, 0);
  },

  boardPoint(event) {
    let viewport = document.getElementById("project-board-viewport");
    let rect = viewport.getBoundingClientRect();
    return {
      x: event.clientX - rect.left + viewport.scrollLeft,
      y: event.clientY - rect.top + viewport.scrollTop,
    };
  },

  async dropPaperOnBoard(event) {
    event.preventDefault();
    if (!api.addBoardNode || !this.project) return;
    let itemKey = event.dataTransfer &&
      (event.dataTransfer.getData("application/x-unizero-paper") ||
        event.dataTransfer.getData("text/plain"));
    if (!itemKey) return;
    let point = this.boardPoint(event);
    let scope = this.context && this.context.scope
      ? Object.assign({}, this.context.scope)
      : null;
    let generation = this.contextGeneration;
    this.setCollectionStatus(this.strings.loading);
    try {
      let view = await api.addBoardNode(itemKey, {
        x: point.x - 114,
        y: point.y - 59,
        width: 228,
        height: 118,
      }, scope);
      if (!this.contextIsCurrent(generation) || !this.project) return;
      this.project.nodes.push(view);
      this.boardSelectedNodeID = view.node.id;
      this.renderCollection();
      await this.showCollectionPreview(view.itemKey);
    } catch (error) {
      if (this.contextIsCurrent(generation)) {
        this.setCollectionStatus(this.strings.error + ": " + String(error), true);
      }
    }
  },

  startBoardNodeDrag(event, view, element) {
    if (event.button !== 0) return;
    event.preventDefault();
    let geometry = view.node.geometry;
    this._boardPointer = {
      view,
      element,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: geometry.x,
      startY: geometry.y,
      originalGeometry: { ...geometry },
      moved: false,
    };
  },

  moveBoardNodeDrag(event) {
    let drag = this._boardPointer;
    if (!drag) return;
    let dx = event.clientX - drag.startClientX;
    let dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    drag.element.classList.add("dragging");
    let x = drag.startX + dx;
    let y = drag.startY + dy;
    drag.element.style.left = `${x}px`;
    drag.element.style.top = `${y}px`;
    drag.view.node.geometry = {
      ...drag.view.node.geometry,
      x,
      y,
    };
    this.renderBoardEdges();
  },

  async finishBoardNodeDrag() {
    let drag = this._boardPointer;
    if (!drag) return;
    this._boardPointer = null;
    drag.element.classList.remove("dragging");
    if (!drag.moved) {
      this.selectBoardNode(drag.view);
      return;
    }
    let x = Number.parseFloat(drag.element.style.left);
    let y = Number.parseFloat(drag.element.style.top);
    let previous = drag.originalGeometry;
    drag.view.node.geometry = { ...drag.view.node.geometry, x, y };
    let scope = this.context && this.context.scope
      ? Object.assign({}, this.context.scope)
      : null;
    let generation = this.contextGeneration;
    try {
      let updated = await api.moveBoardNode(
        drag.view.node.id,
        drag.view.node.geometry,
        scope,
      );
      if (!this.contextIsCurrent(generation)) return;
      drag.view.node = updated.node;
      this.renderBoardEdges();
    } catch (error) {
      drag.view.node.geometry = previous;
      if (this.contextIsCurrent(generation)) {
        this.renderProjectBoard();
        this.setCollectionStatus(this.strings.error + ": " + String(error), true);
      }
    }
  },

  selectBoardNode(view) {
    if (this.boardConnectSourceID) {
      if (this.boardConnectSourceID === view.node.id) {
        this.boardConnectSourceID = null;
        this.updateBoardControls();
        return;
      }
      void this.createBoardEdge(this.boardConnectSourceID, view.node.id);
      return;
    }
    this.boardSelectedNodeID = view.node.id;
    this.boardSelectedEdgeID = null;
    document.querySelectorAll(".board-paper-node").forEach((element) => {
      element.classList.toggle(
        "selected",
        element.dataset.nodeId === view.node.id,
      );
    });
    document.querySelectorAll(".board-manual-edge").forEach((element) =>
      element.classList.remove("selected"));
    this.updateBoardControls();
    if (view.itemKey) void this.showCollectionPreview(view.itemKey);
  },

  selectBoardEdge(edge) {
    this.boardSelectedEdgeID = edge.id;
    this.boardSelectedNodeID = null;
    this.boardConnectSourceID = null;
    document.querySelectorAll(".board-paper-node").forEach((element) =>
      element.classList.remove("selected"));
    document.querySelectorAll(".board-manual-edge").forEach((element) => {
      element.classList.toggle(
        "selected",
        element.dataset.edgeId === edge.id,
      );
    });
    this.updateBoardControls();
  },

  toggleBoardConnect() {
    if (this.boardConnectSourceID) {
      this.boardConnectSourceID = null;
      this.updateBoardControls();
      return;
    }
    if (!this.boardSelectedNodeID) return;
    this.boardConnectSourceID = this.boardSelectedNodeID;
    this.updateBoardControls();
  },

  async createBoardEdge(sourceNodeID, targetNodeID) {
    if (!this.project || !api.addBoardEdge || this._boardConnecting) return;
    let duplicate = (this.project.edges || []).find((edge) =>
      (edge.sourceNodeID === sourceNodeID &&
        edge.targetNodeID === targetNodeID) ||
      (edge.sourceNodeID === targetNodeID &&
        edge.targetNodeID === sourceNodeID));
    if (duplicate) {
      this.selectBoardEdge(duplicate);
      return;
    }
    let scope = this.context && this.context.scope
      ? Object.assign({}, this.context.scope)
      : null;
    let generation = this.contextGeneration;
    this._boardConnecting = true;
    this.updateBoardControls();
    try {
      let edge = await api.addBoardEdge(sourceNodeID, targetNodeID, scope);
      if (!this.contextIsCurrent(generation) || !this.project) return;
      if (!Array.isArray(this.project.edges)) this.project.edges = [];
      this.project.edges.push(edge);
      this.boardConnectSourceID = null;
      this.boardSelectedNodeID = null;
      this.boardSelectedEdgeID = edge.id;
      this.renderProjectBoard();
    } catch (error) {
      if (this.contextIsCurrent(generation)) {
        this.setCollectionStatus(this.strings.error + ": " + String(error), true);
      }
    } finally {
      this._boardConnecting = false;
      this.updateBoardControls();
    }
  },

  async deleteBoardSelection() {
    if (this.boardSelectedEdgeID) {
      await this.deleteSelectedBoardEdge();
    } else if (this.boardSelectedNodeID) {
      await this.deleteSelectedBoardNode();
    }
  },

  async deleteSelectedBoardNode() {
    let nodeID = this.boardSelectedNodeID;
    if (!nodeID || !this.project || !api.deleteBoardNode ||
        this._boardDeletingID) return;
    this._boardDeletingID = nodeID;
    let scope = this.context && this.context.scope
      ? Object.assign({}, this.context.scope)
      : null;
    let generation = this.contextGeneration;
    try {
      let deleted = await api.deleteBoardNode(nodeID, scope);
      if (!this.contextIsCurrent(generation) || !this.project) return;
      this.project.nodes = this.project.nodes.filter(
        (view) => view.node.id !== nodeID,
      );
      let deletedEdges = new Set(deleted.deletedEdgeIDs || []);
      this.project.edges = (this.project.edges || []).filter(
        (edge) => !deletedEdges.has(edge.id) &&
          edge.sourceNodeID !== nodeID && edge.targetNodeID !== nodeID,
      );
      this.boardSelectedNodeID = null;
      this.boardConnectSourceID = null;
      this.collectionPreview = null;
      this.showCollection();
      this.renderCollection();
    } catch (error) {
      if (this.contextIsCurrent(generation)) {
        this.setCollectionStatus(this.strings.error + ": " + String(error), true);
      }
    } finally {
      if (this._boardDeletingID === nodeID) this._boardDeletingID = null;
      this.updateBoardControls();
    }
  },

  async deleteSelectedBoardEdge() {
    let edgeID = this.boardSelectedEdgeID;
    if (!edgeID || !this.project || !api.deleteBoardEdge ||
        this._boardDeletingID) return;
    this._boardDeletingID = edgeID;
    let scope = this.context && this.context.scope
      ? Object.assign({}, this.context.scope)
      : null;
    let generation = this.contextGeneration;
    try {
      await api.deleteBoardEdge(edgeID, scope);
      if (!this.contextIsCurrent(generation) || !this.project) return;
      this.project.edges = (this.project.edges || []).filter(
        (edge) => edge.id !== edgeID,
      );
      this.boardSelectedEdgeID = null;
      this.renderProjectBoard();
    } catch (error) {
      if (this.contextIsCurrent(generation)) {
        this.setCollectionStatus(this.strings.error + ": " + String(error), true);
      }
    } finally {
      if (this._boardDeletingID === edgeID) this._boardDeletingID = null;
      this.updateBoardControls();
    }
  },

  renderCollectionRow(item) {
    let row = document.createElement("tr");
    // Lets the graph scroll its selected paper into view in the table.
    row.dataset.itemKey = item.itemKey;

    let titleCell = document.createElement("td");
    let title = document.createElement("button");
    title.className = "collection-paper-link";
    title.textContent = item.title || "Untitled";
    title.title = this.strings.openRelations;
    title.addEventListener("click", () =>
      this.showDetail(item.itemKey, "references"));
    let meta = document.createElement("div");
    meta.className = "paper-meta";
    meta.textContent = item.publicationTitle || "";
    titleCell.append(title, meta);
    row.append(titleCell);

    row.append(this.cell((item.creators || []).slice(0, 3).join(", ") || "—", "creator"));
    row.append(this.cell(item.year || "—", "numeric"));
    row.append(this.cell(this.displayDate(item.dateAdded), "date-added"));
    row.append(this.collectionMarkdownCell(item));
    row.append(this.collectionRelationCell(item, "references"));
    row.append(this.collectionRelationCell(item, "citations"));
    return row;
  },

  collectionMarkdownCell(item) {
    let cell = document.createElement("td");
    cell.className = "state";
    let button = document.createElement("button");
    button.className = "state-action";
    if (item.hasMarkdown) {
      button.classList.add("ready");
      button.textContent = "✓ MD";
      button.title = this.strings.markdownReady;
      button.addEventListener("click", (event) => this.showMarkdownMenu(item, event));
    } else if (item.hasPDF) {
      button.classList.add("pending");
      button.textContent = "↻ MD";
      button.title = this.strings.generateMarkdown;
      button.addEventListener("click", () =>
        this.runCollectionAction(button, item, "markdown"));
    } else {
      button.classList.add("unavailable");
      button.textContent = "—";
      button.title = this.strings.noPdf;
      button.disabled = true;
    }
    cell.append(button);
    return cell;
  },

  /**
   * Obsidian URL manager for a converted paper.
   *
   * Opening and editing deliberately ignore Zotero's device-local attachment
   * path. Conversion supplies a default Obsidian URL and this menu lets the user
   * replace that URL directly.
   */
  async showMarkdownMenu(item, event) {
    let s = this.strings;
    let point = event ? { x: event.clientX, y: event.clientY } : null;
    let link = null;
    try {
      link = api.markdownLink ? await api.markdownLink(item.itemKey) : null;
    } catch (error) {
      link = null;
    }
    this.showMenu(point, item.title || "", ({ entry, note }) => {
      if (link && link.url) note(link.url);
      entry(s.graphOpenObsidian, Boolean(api.openMarkdown), () =>
        this.runCollectionMarkdownAction(item, () => api.openMarkdown(item.itemKey)));
      entry(s.select, Boolean(item.itemID), () => api.selectItem(item.itemID));
      // One action edits the URL text; it never opens a filesystem picker.
      entry(s.markdownRelink, Boolean(api.editMarkdownLink),
        () => this.runCollectionMarkdownAction(
          item, () => api.editMarkdownLink(item.itemKey), true));
      entry(s.markdownRegenerate, Boolean(item.hasPDF) && Boolean(api.convertItem),
        () => this.runCollectionAction(null, item, "markdown"));
    });
  },

  /** Run a link action against the table, reporting on the Collection status line. */
  async runCollectionMarkdownAction(item, run, refreshRow) {
    let generation = this.contextGeneration;
    let snapshot = this.collectionSnapshot;
    this.setCollectionStatus(this.strings.loading);
    try {
      let result = await run();
      if (!this.contextIsCurrent(generation) || this.collectionSnapshot !== snapshot) return;
      // A cancelled file picker is not a failure and must not claim one.
      if (refreshRow && result && result.url) {
        item.hasMarkdown = true;
        await this.applyPaperChange(item.itemKey, { hasMarkdown: true }, "metadata");
      }
      this.setCollectionStatus("");
    } catch (error) {
      if (!this.contextIsCurrent(generation) || this.collectionSnapshot !== snapshot) return;
      this.setCollectionStatus(this.strings.error + ": " + String(error), true);
    }
  },

  collectionRelationCell(item, kind) {
    let cell = document.createElement("td");
    cell.className = "state";
    let status = item[kind];
    let button = document.createElement("button");
    button.className = "state-action " + (status.loaded ? "ready" : "pending");
    if (status.loaded) {
      let count = status.total || status.count;
      button.textContent = `✓ ${new Intl.NumberFormat().format(count)}`;
      button.title = this.loadedTooltip(status);
      button.addEventListener("click", () => this.showDetail(item.itemKey, kind));
      // Right-click re-fetches from the providers, so a stale or partial load can be
      // refreshed in place. Kept off left-click, which stays the far more common
      // "open detail" and must not spend API calls (or trip rate limits) by accident.
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.refreshCollectionRelation(button, item, kind);
      });
    } else {
      button.textContent = "↻";
      button.title = kind === "references"
        ? this.strings.loadReferences
        : this.strings.loadCitations;
      button.addEventListener("click", () =>
        this.runCollectionAction(button, item, kind));
    }
    cell.append(button);
    return cell;
  },

  /** Tooltip for a loaded badge: "Loaded · <when> · <right-click hint>". */
  loadedTooltip(status) {
    let when = this.formatTimestamp(status && status.savedAt);
    let base = when ? `${this.strings.loaded} · ${when}` : this.strings.loaded;
    return this.strings.refreshHint ? `${base} · ${this.strings.refreshHint}` : base;
  },

  formatTimestamp(value) {
    if (!value) return "";
    let date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString();
  },

  async refreshCollectionRelation(button, item, kind) {
    if (button.disabled) return;
    button.disabled = true;
    let generation = this.contextGeneration;
    let snapshot = this.collectionSnapshot;
    let previous = button.textContent;
    button.textContent = "…";
    try {
      let updated = await api.loadRelation(item.itemKey, kind, true);
      if (!this.contextIsCurrent(generation) || this.collectionSnapshot !== snapshot) return;
      await this.applyPaperChange(item.itemKey, updated, kind);
    } catch (error) {
      if (!this.contextIsCurrent(generation) || this.collectionSnapshot !== snapshot) return;
      button.disabled = false;
      button.textContent = previous;
      this.setCollectionStatus(this.strings.error + ": " + String(error), true);
    }
  },

  /** `button` is optional: the same actions are also reachable from a menu. */
  async runCollectionAction(button, item, action) {
    let generation = this.contextGeneration;
    let snapshot = this.collectionSnapshot;
    let previous = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "…";
    }
    try {
      let updated = action === "markdown"
        ? await api.convertItem(item.itemKey)
        : await api.loadRelation(item.itemKey, action);
      if (!this.contextIsCurrent(generation) || this.collectionSnapshot !== snapshot) return;
      await this.applyPaperChange(
        item.itemKey,
        updated,
        action === "markdown" ? "metadata" : action,
      );
    } catch (error) {
      if (!this.contextIsCurrent(generation) || this.collectionSnapshot !== snapshot) return;
      if (button) {
        button.disabled = false;
        button.textContent = previous;
      }
      this.setCollectionStatus(this.strings.error + ": " + String(error), true);
    }
  },

  setCollectionStatus(text, error) {
    this.writeStatus("collection-status", text, error);
  },

  displayDate(value) {
    let match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : (value || "—");
  },

  resetFilters() {
    this.activeSource = "combined";
    this.dropdowns.source.setValue("combined");
    document.getElementById("refresh").title = "";
    this.filters.library = "all";
    this.filters.influence = "all";
    this.filters.publicationType = "all";
    this.filters.publicationLevel = "all";
    this.dropdowns.library.setValue("all");
    this.dropdowns.influence.setValue("all");
    this.dropdowns.publicationType.setValue("all");
    this.dropdowns.publicationLevel.setOptions(
      [["all", this.strings.allPublicationLevels]],
      "all",
    );
    document.getElementById("publication-level-field").hidden = true;
    document.getElementById("search").value = "";
    document.getElementById("year-from").value = "";
    document.getElementById("year-to").value = "";
  },

  configurePublicationLevels() {
    let levels = this.snapshot
      ? Array.from(new Set(this.snapshot.items
        .map((item) => item.publicationLevel)
        .filter((level) => typeof level === "string" && level.trim())))
        .sort((left, right) => left.localeCompare(right))
      : [];
    let field = document.getElementById("publication-level-field");
    field.hidden = levels.length === 0;
    let preferred = levels.includes(this.filters.publicationLevel)
      ? this.filters.publicationLevel
      : "all";
    this.filters.publicationLevel = preferred;
    this.dropdowns.publicationLevel.setOptions(
      [["all", this.strings.allPublicationLevels]]
        .concat(levels.map((level) => [level, level])),
      preferred,
    );
  },

  configureSources() {
    let sources = (this.snapshot && this.snapshot.sources) || [];
    // A "skipped" source was never queried (the paper lacks that identifier), so it
    // is not offered; a failed or empty one stays listed so it can be retried.
    let usable = sources.filter((source) => source.status !== "skipped");
    let field = document.getElementById("filter-source").closest(".filter-field");
    if (field) field.hidden = usable.length === 0;
    let options = [["combined", this.strings.combinedSource]].concat(
      usable.map((source) => [source.key, this.sourceOptionLabel(source)]),
    );
    let preferred = options.some((option) => option[0] === this.activeSource)
      ? this.activeSource
      : "combined";
    this.activeSource = preferred;
    this.dropdowns.source.setOptions(options, preferred);
  },

  configureKindPresentation() {
    let relation = this.kind === "relation";
    let graph = this.kind === "graph";
    let detail = document.getElementById("detail-view");
    detail.classList.toggle("relation-mode", relation);
    detail.classList.toggle("graph-mode", graph);
    document.getElementById("detail-graph-wrap").hidden = !graph;
    document.querySelectorAll("#detail-view .tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.kind === this.kind);
    });
    if (graph) { return; }

    let sourceField = document.getElementById("filter-source").closest(".filter-field");
    let libraryField = document.getElementById("filter-library").closest(".filter-field");
    let influenceField = document.getElementById("filter-influence")
      .closest(".filter-field");
    if (sourceField) {
      let hasSources = Boolean(
        this.snapshot &&
        (this.snapshot.sources || []).some((source) => source.status !== "skipped"),
      );
      sourceField.hidden = relation || !hasSources;
    }
    if (libraryField) libraryField.hidden = relation;
    if (influenceField) influenceField.hidden = relation;
    if (relation) {
      document.getElementById("publication-level-field").hidden = true;
    }

    document.getElementById("head-citations").textContent = relation
      ? this.strings.relationColumn
      : this.strings.citationsColumn;
    document.getElementById("head-influence").textContent = relation
      ? this.strings.sharedColumn
      : this.strings.influenceColumn;
    document.getElementById("head-source").textContent = this.strings.sourceColumn;
  },

  sourceOptionLabel(source) {
    if (String(source.status || "").indexOf("error") === 0) {
      return source.name + " · " + this.strings.error;
    }
    if (source.status === "unavailable") {
      return source.name + " · " + this.strings.restricted;
    }
    let count = source.total && source.total !== source.count
      ? source.count + "/" + new Intl.NumberFormat().format(source.total)
      : new Intl.NumberFormat().format(source.count);
    return source.name + " (" + count + ")";
  },

  sourceCode(key) {
    return { openAlex: "OA", crossref: "CR", semanticScholar: "S2" }[key] || key;
  },

  selectSource(value) {
    this.activeSource = value;
    let tab = this.activeTabState();
    if (tab) tab.activeSource = value;
    document.getElementById("refresh").title =
      value === "combined" ? "" : this.strings.refreshSource;
    this.render();
  },

  activeEntries() {
    if (!this.snapshot) return [];
    if (this.activeSource === "combined") return this.snapshot.items;
    return (this.snapshot.bySource && this.snapshot.bySource[this.activeSource]) || [];
  },

  async refreshActive() {
    let tab = this.activeTabState();
    if (!tab || tab.busy) return;
    if (tab.activeSource === "combined") {
      await this.load(true);
      return;
    }
    let sourceKey = tab.activeSource;
    let itemKey = tab.itemKey;
    let kind = tab.kind;
    let generation = this.contextGeneration;
    let request = this.beginTabRequest(tab, "snapshot");
    let libraryID = this.context && this.context.scope
      ? this.context.scope.libraryID
      : null;
    tab.error = "";
    this.setBusy(true, tab);
    if (this.tabIsActive(tab)) {
      this.setStatus(this.strings.loading);
      this.startProgress(kind, sourceKey);
    }
    try {
      let snapshot = await api.refreshSource(
        itemKey,
        kind,
        sourceKey,
        libraryID,
      );
      if (!this.tabRequestIsCurrent(tab, "snapshot", request, generation)) return;
      tab.snapshot = snapshot;
      tab.busy = false;
      if (this.tabIsActive(tab)) {
        this.snapshot = snapshot;
        this.activeSource = tab.activeSource;
        this.syncCollectionRelationStatus();
        this.configureSources();
        this.configurePublicationLevels();
        this.render();
      }
    } catch (error) {
      if (!this.tabRequestIsCurrent(tab, "snapshot", request, generation)) return;
      tab.error = this.strings.error + ": " + String(error);
      tab.busy = false;
      if (this.tabIsActive(tab)) this.setStatus(tab.error, true);
    } finally {
      if (this.tabRequestIsCurrent(tab, "snapshot", request, generation)) {
        this.setBusy(false, tab);
        if (this.tabIsActive(tab)) this.stopProgress();
      }
    }
  },

  publicationType(item) {
    let type = String(item.type || "").toLocaleLowerCase();
    if (type.includes("preprint") || type.includes("arxiv")) return "preprint";
    if (type.includes("conference") || type.includes("proceeding")) return "conference";
    if (type.includes("book") || type.includes("chapter")) return "book";
    if (type.includes("journal") || type === "article" ||
        type.includes("journal-article")) {
      return "journal";
    }
    return "other";
  },

  selectedYearRange() {
    let from = Number.parseInt(document.getElementById("year-from").value, 10);
    let to = Number.parseInt(document.getElementById("year-to").value, 10);
    from = Number.isFinite(from) ? from : null;
    to = Number.isFinite(to) ? to : null;
    if (from !== null && to !== null && from > to) {
      return { from: to, to: from };
    }
    return { from, to };
  },

  configureSort(reset) {
    let next = reset
      ? (this.kind === "citations" ? "influential" : "original")
      : this.filters.order;
    this.filters.order = next;
    let tab = this.activeTabState();
    if (tab) tab.filters.order = next;
    this.dropdowns.order.setValue(next);
  },

  /**
   * Every "open this paper" path in the window goes through here, so opening one
   * is opening a tab — there is no second way in that would bypass the strip.
   */
  async showDetail(itemKey, kind) {
    await this.openPaper(itemKey, kind);
  },

  async switchKind(kind) {
    let tab = this.activeTabState();
    if (!tab || kind === tab.kind) return;
    // Supersede a provider request owned by the old surface. It may still finish,
    // but its generation can no longer write into this tab.
    this.beginTabRequest(tab, "snapshot");
    tab.busy = false;
    tab.error = "";
    tab.kind = kind;
    tab.snapshot = null;
    tab.activeSource = "combined";
    tab.search = "";
    tab.yearFrom = "";
    tab.yearTo = "";
    this.kind = kind;
    this.snapshot = null;
    this.activeSource = "combined";
    this.setBusy(false, tab);
    this.stopProgress();
    this.configureSort(true);
    this.configureKindPresentation();
    await this.load(false);
  },

  async load(refresh) {
    let tab = this.activeTabState();
    if (!tab || tab.busy) return;
    // The graph tab is a different surface entirely: it reads the derived library
    // graph rather than a provider snapshot, so it skips sources and paging.
    if (tab.kind === "graph") {
      this.configureKindPresentation();
      await this.loadDetailGraph(Boolean(refresh));
      return;
    }
    let itemKey = tab.itemKey;
    let kind = tab.kind;
    let generation = this.contextGeneration;
    let request = this.beginTabRequest(tab, "snapshot");
    let libraryID = this.context && this.context.scope
      ? this.context.scope.libraryID
      : null;
    // A full (re)load lands on the combined view; the source picker is repopulated
    // from the fresh snapshot below.
    tab.activeSource = "combined";
    tab.error = "";
    if (this.tabIsActive(tab)) {
      this.activeSource = "combined";
      document.getElementById("refresh").title = "";
      this.setStatus(this.strings.loading);
      this.startProgress(kind);
    }
    this.setBusy(true, tab);
    try {
      let snapshot = await api.snapshot(
        itemKey,
        kind,
        Boolean(refresh),
        libraryID,
      );
      if (!this.tabRequestIsCurrent(tab, "snapshot", request, generation)) return;
      tab.snapshot = snapshot;
      tab.title = snapshot.seed.title;
      tab.busy = false;
      if (this.tabIsActive(tab) && tab.kind === kind) {
        this.snapshot = snapshot;
        this.activeSource = tab.activeSource;
        this.syncCollectionRelationStatus();
        this.setPaperTitle(snapshot.seed.title);
        this.configureSources();
        this.configurePublicationLevels();
        this.configureKindPresentation();
        this.render();
      } else {
        this.renderTabs();
      }
    } catch (error) {
      if (!this.tabRequestIsCurrent(tab, "snapshot", request, generation)) return;
      tab.snapshot = null;
      tab.busy = false;
      tab.error = this.strings.error + ": " + String(error);
      if (this.tabIsActive(tab) && tab.kind === kind) {
        this.snapshot = null;
        this.configurePublicationLevels();
        this.configureKindPresentation();
        this.setStatus(tab.error, true);
        this.render();
      }
    } finally {
      if (this.tabRequestIsCurrent(tab, "snapshot", request, generation)) {
        this.setBusy(false, tab);
        if (this.tabIsActive(tab)) this.stopProgress();
      }
    }
  },

  async loadMore() {
    let tab = this.activeTabState();
    if (!tab || tab.busy || tab.kind !== "citations") return;
    let generation = this.contextGeneration;
    let request = this.beginTabRequest(tab, "snapshot");
    let itemKey = tab.itemKey;
    let libraryID = this.context && this.context.scope
      ? this.context.scope.libraryID
      : null;
    this.setBusy(true, tab);
    if (this.tabIsActive(tab)) {
      this.setStatus(this.strings.loading);
      this.startProgress(tab.kind);
    }
    try {
      let snapshot = await api.loadMoreCitations(itemKey, libraryID);
      if (!this.tabRequestIsCurrent(tab, "snapshot", request, generation)) return;
      tab.snapshot = snapshot;
      tab.busy = false;
      if (this.tabIsActive(tab)) {
        this.snapshot = snapshot;
        this.syncCollectionRelationStatus();
        this.configureSources();
        this.configurePublicationLevels();
        this.configureKindPresentation();
        this.render();
      }
    } catch (error) {
      if (!this.tabRequestIsCurrent(tab, "snapshot", request, generation)) return;
      tab.busy = false;
      tab.error = this.strings.error + ": " + String(error);
      if (this.tabIsActive(tab)) this.setStatus(tab.error, true);
    } finally {
      if (this.tabRequestIsCurrent(tab, "snapshot", request, generation)) {
        this.setBusy(false, tab);
        if (this.tabIsActive(tab)) this.stopProgress();
      }
    }
  },

  setBusy(value, tab) {
    let owner = tab || this.activeTabState();
    if (owner) owner.busy = value;
    if (owner && !this.tabIsActive(owner)) return;
    this.busy = Boolean(value);
    document.getElementById("refresh").disabled = value;
    document.getElementById("load-more").disabled = value;
  },

  setStatus(text, error) {
    this.writeStatus("status", text, error);
  },

  /**
   * Both status lines sit above their table, so a failure reported while the user
   * is further down the page lands somewhere they cannot see — which reads as the
   * action having done nothing at all. Errors are rare enough to be worth
   * scrolling to, and `nearest` does nothing when the line is already visible.
   */
  writeStatus(id, text, error) {
    let status = document.getElementById(id);
    status.textContent = text || "";
    status.classList.toggle("error", !!error);
    if (error && status.scrollIntoView) {
      status.scrollIntoView({ block: "nearest" });
    }
  },

  /**
   * Show the in-window progress bar and poll the backend for per-source status while
   * a fetch is in flight. `onlySource` narrows the pills to a single-source refresh.
   */
  startProgress(kind, onlySource) {
    let bar = document.getElementById("progress");
    if (!bar) return;
    if (kind === "relation") {
      this.stopProgress();
      return;
    }
    let keys = onlySource
      ? [onlySource]
      : (kind === "references"
        ? ["openAlex", "crossref", "semanticScholar"]
        : ["openAlex", "semanticScholar"]);
    bar.hidden = false;
    this.renderProgress(keys.map((key) => ({ key, status: "pending" })));
    let poll = () => {
      let all = (api.relationProgress && api.relationProgress(kind)) || [];
      let filtered = all.filter((entry) => keys.includes(entry.key));
      this.renderProgress(filtered.length
        ? filtered
        : keys.map((key) => ({ key, status: "pending" })));
    };
    this._progressTimer = window.setInterval(poll, 220);
  },

  stopProgress() {
    if (this._progressTimer) {
      window.clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
    let bar = document.getElementById("progress");
    if (bar) bar.hidden = true;
  },

  renderProgress(list) {
    let host = document.getElementById("progress-sources");
    if (!host) return;
    host.replaceChildren();
    list.forEach((entry) => {
      let pill = document.createElement("span");
      pill.className = "progress-pill " + (entry.status || "pending");
      pill.textContent = this.sourceCode(entry.key) + " " + this.progressGlyph(entry.status);
      host.append(pill);
    });
  },

  progressGlyph(status) {
    return {
      pending: "…",
      ok: "✓",
      empty: "∅",
      error: "✕",
      restricted: "⚠",
      skipped: "–",
    }[status] || "…";
  },

  syncCollectionRelationStatus() {
    if (this.kind === "relation") return;
    if (!this.collectionSnapshot || !this.snapshot || !this.activeItemKey) return;
    let paper = this.collectionSnapshot.items
      .find((item) => item.itemKey === this.activeItemKey);
    if (!paper) return;
    paper[this.kind] = {
      loaded: true,
      count: this.snapshot.loaded,
      total: this.snapshot.total,
      savedAt: Date.now(),
    };
  },

  visibleItems() {
    if (!this.snapshot) return [];
    let query = document.getElementById("search").value.trim().toLocaleLowerCase();
    let years = this.selectedYearRange();
    let relation = this.kind === "relation";
    let items = this.activeEntries().filter((item) => {
      if (!relation && this.filters.library === "in" &&
          !item.membership.inLibrary) return false;
      if (!relation && this.filters.library === "out" &&
          item.membership.inLibrary) return false;
      if (!relation && this.filters.influence === "influential" &&
          item.isInfluential !== true) {
        return false;
      }
      if (this.filters.publicationType !== "all" &&
          this.publicationType(item) !== this.filters.publicationType) {
        return false;
      }
      if (this.filters.publicationLevel !== "all" &&
          item.publicationLevel !== this.filters.publicationLevel) {
        return false;
      }
      let year = Number(item.year);
      if (years.from !== null && (!Number.isFinite(year) || year < years.from)) {
        return false;
      }
      if (years.to !== null && (!Number.isFinite(year) || year > years.to)) {
        return false;
      }
      if (query) {
        let haystack = [
          item.title,
          item.primaryVenue,
          item.type,
          item.source,
        ].concat(item.authors || []).join(" ").toLocaleLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    let sort = this.filters.order;
    return items.slice().sort((left, right) => {
      if (sort === "shared") {
        return Number(right.sharedReferences || 0) -
            Number(left.sharedReferences || 0) ||
          Number((right.relationTypes || []).includes("cites")) -
            Number((left.relationTypes || []).includes("cites")) ||
          Number(left.sourceOrder || 0) - Number(right.sourceOrder || 0);
      }
      if (sort === "influential") {
        return Number(!!right.isInfluential) - Number(!!left.isInfluential) ||
          Number(right.influentialCitationCount || 0) -
            Number(left.influentialCitationCount || 0) ||
          Number(right.citationCount || 0) - Number(left.citationCount || 0) ||
          Number(left.sourceOrder || 0) - Number(right.sourceOrder || 0);
      }
      if (sort === "cited") {
        return Number(right.citationCount || 0) - Number(left.citationCount || 0);
      }
      if (sort === "newest") {
        return Number(right.year || 0) - Number(left.year || 0);
      }
      return Number(left.sourceOrder || Number.MAX_SAFE_INTEGER) -
        Number(right.sourceOrder || Number.MAX_SAFE_INTEGER);
    });
  },

  render() {
    this.cancelRowPreview();
    // configureKindPresentation also syncs the active tab.
    this.configureKindPresentation();
    let rows = document.getElementById("rows");
    rows.replaceChildren();
    let items = this.visibleItems();
    if (!this.snapshot) {
      this.renderEmpty(rows, this.busy ? this.strings.loading : this.strings.empty, 6);
      return;
    }
    if (!items.length) {
      let message = this.kind === "relation" && this.snapshot.total === 0
        ? this.strings.relationEmpty
        : this.strings.empty;
      this.renderEmpty(rows, message, 6);
    } else {
      items.forEach((item) => rows.append(this.renderRow(item)));
    }
    let shown = items.length;
    let loaded;
    let total;
    let label;
    if (this.activeSource === "combined") {
      loaded = this.snapshot.loaded;
      total = this.snapshot.total;
      label = this.snapshot.source;
    } else {
      let source = (this.snapshot.sources || [])
        .find((entry) => entry.key === this.activeSource);
      loaded = source ? source.count : shown;
      total = source ? source.total : shown;
      label = source ? source.name : this.activeSource;
    }
    let breakdown = this.kind === "relation" ? "" : (this.snapshot.sources || [])
      .filter((source) => source.status !== "skipped")
      .map((source) => {
        // A restricted or failed source contributes 0, but "S2 0" reads like the
        // paper simply has none; a glyph says why it is zero instead.
        let mark = source.status === "unavailable" ? "⚠"
          : String(source.status || "").indexOf("error") === 0 ? "✕"
            : source.count;
        return `${this.sourceCode(source.key)} ${mark}`;
      })
      .join(" / ");
    let counts = shown === loaded
      ? `${loaded}/${total}`
      : `${shown} / ${loaded}/${total}`;
    this.setStatus(`${counts} · ${
      this.kind === "relation" ? this.strings.relationSource : label
    }` + (breakdown ? ` · ${breakdown}` : ""));
    // Combined "Load more" pages every source at once; a single-source view only
    // shows what has already been fetched, so it hides the button.
    document.getElementById("load-more").hidden =
      this.activeSource !== "combined" ||
      this.kind !== "citations" ||
      !this.snapshot.hasMore;
  },

  renderEmpty(rows, message, columnCount) {
    let row = document.createElement("tr");
    let cell = document.createElement("td");
    cell.colSpan = columnCount;
    cell.className = "empty-cell";
    cell.textContent = message;
    row.append(cell);
    rows.append(row);
    if (rows.id === "rows") {
      document.getElementById("load-more").hidden = true;
    }
  },

  renderRow(item) {
    let row = document.createElement("tr");
    row.className = item.membership.inLibrary ? "in-library" : "not-in-library";
    row.addEventListener("mouseenter", () => this.scheduleRowPreview(item, row));
    row.addEventListener("mouseleave", () => this.cancelRowPreview());

    let titleCell = document.createElement("td");
    let title = document.createElement("button");
    title.className = "paper-link";
    title.textContent = item.title || item.text || "Untitled";
    title.title = this.kind === "relation" ? this.strings.select : this.strings.open;
    title.addEventListener("click", () => {
      if (this.kind === "relation") {
        api.selectItem(item.membership.itemID);
      } else {
        api.launchURL(this.paperURL(item));
      }
    });
    let meta = document.createElement("div");
    meta.className = "paper-meta";
    meta.textContent = (item.authors || []).slice(0, 4).join(", ") ||
      item.primaryVenue || "";
    titleCell.append(title, meta);
    row.append(titleCell);

    row.append(this.cell(item.year || "—", "numeric"));
    if (this.kind === "relation") {
      let relation = document.createElement("td");
      let badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = this.relationLabel(item);
      relation.append(badge);
      row.append(relation);
      row.append(this.cell(
        item.sharedReferences
          ? new Intl.NumberFormat().format(item.sharedReferences)
          : "—",
        "numeric",
      ));
      row.append(this.cell(this.strings.relationSource, "source"));
    } else {
    row.append(this.cell(
      item.citationCount == null
        ? "—"
        : new Intl.NumberFormat().format(item.citationCount),
      "numeric",
    ));

    let influence = document.createElement("td");
    if (item.isInfluential) {
      let badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = this.strings.influential;
      if (item.intents && item.intents.length) {
        badge.title = item.intents.join(", ");
      }
      if (item.influentialCitationCount != null) {
        let count = new Intl.NumberFormat().format(item.influentialCitationCount);
        badge.title = [badge.title, `${count} ${this.strings.influential}`]
          .filter(Boolean).join(" · ");
      }
      influence.append(badge);
    } else if (item.influentialCitationCount != null) {
      influence.textContent =
        new Intl.NumberFormat().format(item.influentialCitationCount);
    } else {
      influence.textContent = "—";
    }
    row.append(influence);
    row.append(this.cell(item.source || "—", "source"));
    }

    let library = document.createElement("td");
    library.className = "library";
    let action = document.createElement("button");
    action.className = "library-action " +
      (item.membership.inLibrary ? "present" : "add");
    action.textContent = item.membership.inLibrary ? "●" : "+";
    action.title = item.membership.inLibrary ? this.strings.present : this.strings.add;
    action.addEventListener("click", async () => {
      if (item.membership.inLibrary) {
        api.selectItem(item.membership.itemID);
        return;
      }
      action.disabled = true;
      action.textContent = "…";
      try {
        item.membership = await api.addToLibrary(this.activeItemKey, item);
        this.render();
      } catch (error) {
        action.disabled = false;
        action.textContent = "+";
        this.setStatus(this.strings.error + ": " + String(error), true);
      }
    });
    library.append(action);
    row.append(library);
    return row;
  },

  relationLabel(item) {
    let types = item.relationTypes || [];
    let cites = types.includes("cites");
    let coupled = types.includes("coupled");
    if (cites && coupled) return this.strings.relationBoth;
    if (cites) return this.strings.relationCites;
    return this.strings.relationCoupled;
  },

  cell(text, className) {
    let cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  },

  ensurePreview() {
    if (this._preview) return this._preview;
    let el = document.createElement("div");
    el.className = "row-preview";
    el.hidden = true;
    document.body.append(el);
    this._preview = el;
    return el;
  },

  scheduleRowPreview(item, row) {
    this.cancelRowPreview();
    // A short delay keeps the card from flickering as the pointer crosses rows.
    this._previewTimer = window.setTimeout(() => this.showRowPreview(item, row), 320);
  },

  cancelRowPreview() {
    if (this._previewTimer) {
      window.clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
    if (this._preview) this._preview.hidden = true;
  },

  showRowPreview(item, row) {
    let el = this.ensurePreview();
    el.replaceChildren(this.buildPreviewContent(item));
    el.hidden = false;
    // Measure after content is in, then prefer the right of the row, fall back to the
    // left, and clamp inside the viewport.
    let rect = row.getBoundingClientRect();
    let pw = el.offsetWidth;
    let ph = el.offsetHeight;
    let margin = 12;
    let left = rect.right + 10;
    if (left + pw > window.innerWidth - margin) left = rect.left - pw - 10;
    if (left < margin) left = Math.max(margin, window.innerWidth - pw - margin);
    let top = rect.top;
    if (top + ph > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - ph - margin);
    }
    if (top < margin) top = margin;
    el.style.left = left + "px";
    el.style.top = top + "px";
  },

  buildPreviewContent(item) {
    let frag = document.createDocumentFragment();

    let title = document.createElement("div");
    title.className = "row-preview-title";
    title.textContent = item.title || item.text || "Untitled";
    frag.append(title);

    let authors = (item.authors || []).join(", ");
    if (authors) {
      let line = document.createElement("div");
      line.className = "row-preview-meta";
      line.textContent = authors;
      frag.append(line);
    }
    let venueBits = [item.primaryVenue, item.year, item.type].filter(Boolean);
    if (venueBits.length) {
      let line = document.createElement("div");
      line.className = "row-preview-meta";
      line.textContent = venueBits.join(" · ");
      frag.append(line);
    }

    let tags = document.createElement("div");
    tags.className = "row-preview-tags";
    let addTag = (text, muted) => {
      if (!text) return;
      let tag = document.createElement("span");
      tag.className = "row-preview-tag" + (muted ? " muted" : "");
      tag.textContent = text;
      tags.append(tag);
    };
    if (item.source) addTag(item.source);
    if (this.kind === "relation") {
      addTag(this.relationLabel(item));
      if (item.sharedReferences) {
        addTag(new Intl.NumberFormat().format(item.sharedReferences) + " " +
          this.strings.sharedColumn, true);
      }
    }
    if (this.kind !== "relation" && item.citationCount != null) {
      addTag(new Intl.NumberFormat().format(item.citationCount) + " " +
        this.strings.citationsColumn, true);
    }
    if (this.kind !== "relation" && item.isInfluential) {
      let label = this.strings.influential;
      if (item.intents && item.intents.length) label += " · " + item.intents.join(", ");
      addTag(label);
    } else if (item.influentialCitationCount) {
      addTag(new Intl.NumberFormat().format(item.influentialCitationCount) + " " +
        this.strings.influential, true);
    }
    let ids = item.identifiers || {};
    if (ids.DOI) addTag("DOI " + ids.DOI, true);
    else if (ids.arXiv) addTag("arXiv " + ids.arXiv, true);
    else if (ids.paperID) addTag("Semantic Scholar", true);
    if (tags.children.length) frag.append(tags);

    let abstract = document.createElement("div");
    let text = String(item.abstract || "").trim();
    abstract.className = "row-preview-abstract" + (text ? "" : " empty");
    abstract.textContent = text || this.strings.noAbstract;
    frag.append(abstract);
    return frag;
  },

  paperURL(item) {
    if (item.identifiers && item.identifiers.DOI) {
      return "https://doi.org/" + item.identifiers.DOI;
    }
    if (item.identifiers && item.identifiers.arXiv) {
      return "https://arxiv.org/abs/" + item.identifiers.arXiv;
    }
    if (item.identifiers && item.identifiers.paperID) {
      return "https://www.semanticscholar.org/paper/" +
        item.identifiers.paperID;
    }
    return item.url || "";
  },
};

window.addEventListener("DOMContentLoaded", () => LiteratureExplorer.init());
