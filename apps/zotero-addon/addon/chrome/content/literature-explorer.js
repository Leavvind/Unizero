/**
 * Thin view for the per-paper References / Relation / Citations browser.
 *
 * All Zotero, provider, and cache work lives behind window.arguments[0].api.
 * This file owns only display state and DOM events.
 */

"use strict";

var api = window.arguments[0].api;

var LiteratureExplorer = {
  strings: api.strings,
  /** `{ libraryID, itemKey, kind }` for the paper the window was last opened on. */
  context: null,
  contextGeneration: 0,
  activeItemKey: null,
  kind: "references",
  snapshot: null,
  busy: false,
  /**
   * Open paper tabs, in strip order; `activeTab` indexes the one on screen.
   *
   * Only one detail view exists in the DOM. A tab holds the state that view would
   * be in, and switching writes the outgoing state out and the incoming state back
   * — cheaper than a view per tab, and it means a paper reopened from a cached
   * snapshot costs no provider call.
   */
  tabs: [],
  activeTab: -1,
  /** Completed References/Citations snapshots, reused when a tab returns to a kind. */
  snapshotCache: new Map(),
  /** "combined" or a RelationSourceKey — which source's list the table shows. */
  activeSource: "combined",
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
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => this.switchKind(tab.dataset.kind));
    });
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
    window.addEventListener("keydown", (event) => {
      // Ctrl+W closes the paper, the way it closes a browser tab; closing the
      // last one closes the window.
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
      this.tabs.includes(tab) &&
      tab.requests[channel] === request;
  },

  tabIsActive(tab) {
    return Boolean(tab) && this.activeTabState() === tab;
  },

  libraryID() {
    return this.context ? this.context.libraryID : null;
  },

  destroy() {
    this.contextGeneration += 1;
    this.snapshotCache.clear();
    this.stopProgress();
    this.cancelRowPreview();
  },

  /**
   * Point the window at the paper it was (re)opened on.
   *
   * Tabs are keyed by item key, which is only unique within one library, so a
   * window reused for another library drops its tabs — and every request still in
   * flight for them — rather than resolve the same key against the wrong library.
   * Within one library the open tabs stay, and the paper is opened beside them.
   */
  reloadContext() {
    let previous = this.libraryID();
    let next = api.getContext();
    this.context = next ? Object.assign({}, next) : null;
    if (!this.context || this.context.libraryID !== previous) {
      this.contextGeneration += 1;
      this.tabs = [];
      this.activeTab = -1;
      this.snapshot = null;
      this.busy = false;
      this.stopProgress();
      this.snapshotCache.clear();
    }
    if (!this.context || !this.context.itemKey) {
      this.renderTabs();
      this.setStatus("");
      return;
    }
    return this.openPaper(this.context.itemKey, this.context.kind || "references");
  },

  // ------------------------------------------------------------------ Tab strip

  /**
   * Move the live detail view's state into its owning tab.
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
    tab.busy = this.busy;
    this.rememberSnapshot(tab.itemKey, tab.kind, tab.snapshot);
  },

  /** Put a paper state's data back into the one detail view and redraw from it. */
  async restoreTab(tab) {
    this.activeItemKey = tab.itemKey;
    this.kind = tab.kind;
    this.snapshot = tab.snapshot;
    this.activeSource = tab.activeSource;
    this.filters = Object.assign({}, tab.filters);
    document.getElementById("search").value = tab.search;
    document.getElementById("year-from").value = tab.yearFrom;
    document.getElementById("year-to").value = tab.yearTo;
    this.busy = Boolean(tab.busy);
    this.setBusy(this.busy, tab);
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
    let relationKind = kind || "references";
    let cached = this.cachedSnapshot(itemKey, relationKind);
    return {
      itemKey,
      title: cached?.seed?.title || "",
      kind: relationKind,
      snapshot: cached,
      activeSource: "combined",
      // A fresh paper state starts unfiltered; it is not the previous tab's
      // filters carried over.
      filters: {
        library: "all",
        influence: "all",
        publicationType: "all",
        publicationLevel: "all",
        order: relationKind === "citations" ? "influential" : "original",
      },
      search: "",
      yearFrom: "",
      yearTo: "",
      scroll: 0,
      busy: false,
      // Set once the cache probe says this paper has nothing saved: the prompt to
      // fetch replaces the empty table, and no provider call happens until it is
      // clicked.
      needsFetch: false,
      error: "",
      requests: { snapshot: 0 },
    };
  },

  snapshotCacheKey(itemKey, kind) {
    let libraryID = this.libraryID();
    return `${libraryID == null ? "none" : libraryID}:${itemKey}:${kind}`;
  },

  cachedSnapshot(itemKey, kind) {
    if (kind !== "references" && kind !== "citations") return null;
    let key = this.snapshotCacheKey(itemKey, kind);
    let snapshot = this.snapshotCache.get(key) || null;
    if (snapshot) {
      // Map insertion order doubles as a small LRU for a long-lived window.
      this.snapshotCache.delete(key);
      this.snapshotCache.set(key, snapshot);
    }
    return snapshot;
  },

  rememberSnapshot(itemKey, kind, snapshot) {
    if (!snapshot || (kind !== "references" && kind !== "citations")) return;
    let key = this.snapshotCacheKey(itemKey, kind);
    this.snapshotCache.delete(key);
    this.snapshotCache.set(key, snapshot);
    while (this.snapshotCache.size > 48) {
      this.snapshotCache.delete(this.snapshotCache.keys().next().value);
    }
  },

  /**
   * Point a tab at another relation kind without drawing it.
   *
   * The request bump supersedes a provider call owned by the old kind: it may
   * still finish, but it can no longer write into this tab.
   */
  setTabKind(tab, kind) {
    this.rememberSnapshot(tab.itemKey, tab.kind, tab.snapshot);
    this.beginTabRequest(tab, "snapshot");
    tab.busy = false;
    tab.error = "";
    tab.needsFetch = false;
    tab.kind = kind;
    tab.snapshot = this.cachedSnapshot(tab.itemKey, kind);
    if (tab.snapshot) tab.title = tab.snapshot.seed.title;
    tab.activeSource = "combined";
    tab.filters.order = kind === "citations" ? "influential" : "original";
    tab.search = "";
    tab.yearFrom = "";
    tab.yearTo = "";
    tab.scroll = 0;
  },

  /**
   * Open a paper, or come back to it if it is already open.
   *
   * Tab identity is the paper, not the relation kind: opening a paper that already
   * has a tab switches that tab to the requested kind instead of adding a second.
   */
  async openPaper(itemKey, kind) {
    if (!itemKey) return;
    let index = this.tabs.findIndex((tab) => tab.itemKey === itemKey);
    if (index >= 0 && index === this.activeTab) {
      if (kind && kind !== this.kind) await this.switchKind(kind);
      return;
    }
    this.captureTab();
    if (index === -1) {
      this.tabs.push(this.newPaperState(itemKey, kind));
      index = this.tabs.length - 1;
    } else if (kind && kind !== this.tabs[index].kind) {
      this.setTabKind(this.tabs[index], kind);
    }
    this.activeTab = index;
    await this.restoreTab(this.tabs[index]);
  },

  async activateTab(index) {
    if (index === this.activeTab || !this.tabs[index]) return;
    this.captureTab();
    this.activeTab = index;
    await this.restoreTab(this.tabs[index]);
  },

  async closeTab(index) {
    let tab = this.tabs[index];
    if (!tab) return;
    let wasActive = index === this.activeTab;
    this.tabs.splice(index, 1);
    if (!this.tabs.length) {
      this.activeTab = -1;
      window.close();
      return;
    }
    if (!wasActive) {
      if (index < this.activeTab) this.activeTab -= 1;
      this.renderTabs();
      return;
    }
    // Nothing to write back into a tab that is going away. Land on the neighbour
    // a browser would pick: the tab that slid into this slot, else the one before.
    this.activeTab = Math.min(index, this.tabs.length - 1);
    await this.restoreTab(this.tabs[this.activeTab]);
  },

  /** The heading and the tab carry the same name; keep them from disagreeing. */
  setPaperTitle(title) {
    let tab = this.activeTabState();
    if (tab) tab.title = title;
    // Always redraw: a load writes the title into the tab before it gets here.
    this.renderTabs();
    document.getElementById("paper-title").textContent = title;
  },

  renderTabs() {
    let strip = document.getElementById("page-tabs");
    if (!strip) return;
    strip.replaceChildren();
    this.tabs.forEach((tab, index) => {
      let label = tab.title || this.strings.loading;
      let button = document.createElement("button");
      button.className = "page-tab" + (index === this.activeTab ? " active" : "");
      button.title = label;
      let text = document.createElement("span");
      text.className = "page-tab-label";
      text.textContent = label;
      button.append(text);
      button.addEventListener("click", () => this.activateTab(index));
      // Middle-click closes, the way it does in every tabbed window.
      button.addEventListener("auxclick", (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        this.closeTab(index);
      });
      let close = document.createElement("button");
      close.className = "page-tab-close";
      close.textContent = "×";
      close.title = this.strings.closeTab;
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        this.closeTab(index);
      });
      button.append(close);
      strip.append(button);
    });
  },

  // ------------------------------------------------------------- Detail view

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
    document.getElementById("refresh").title =
      preferred === "combined" ? "" : this.strings.refreshSource;
  },

  configureKindPresentation() {
    let relation = this.kind === "relation";
    let detail = document.getElementById("detail-view");
    detail.classList.toggle("relation-mode", relation);
    document.querySelectorAll("#detail-view .tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.kind === this.kind);
    });

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
    let libraryID = this.libraryID();
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
      this.rememberSnapshot(itemKey, kind, snapshot);
      tab.busy = false;
      if (this.tabIsActive(tab)) {
        this.snapshot = snapshot;
        this.activeSource = tab.activeSource;
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

  async switchKind(kind) {
    let tab = this.activeTabState();
    if (!tab || kind === tab.kind) return;
    this.setTabKind(tab, kind);
    this.kind = kind;
    this.snapshot = tab.snapshot;
    this.activeSource = "combined";
    this.filters = Object.assign({}, tab.filters);
    document.getElementById("search").value = "";
    document.getElementById("year-from").value = "";
    document.getElementById("year-to").value = "";
    this.setBusy(false, tab);
    this.stopProgress();
    this.configureSort(false);
    this.configureKindPresentation();
    if (tab.snapshot) {
      this.setPaperTitle(tab.snapshot.seed.title);
      this.configureSources();
      this.configurePublicationLevels();
      this.render();
      return;
    }
    await this.load(false);
  },

  async load(refresh) {
    let tab = this.activeTabState();
    if (!tab || tab.busy) return;
    let itemKey = tab.itemKey;
    let kind = tab.kind;
    let generation = this.contextGeneration;
    let request = this.beginTabRequest(tab, "snapshot");
    let libraryID = this.libraryID();
    // A full (re)load lands on the combined view; the source picker is repopulated
    // from the fresh snapshot below.
    tab.activeSource = "combined";
    tab.error = "";
    tab.needsFetch = false;
    if (this.tabIsActive(tab)) {
      this.activeSource = "combined";
      document.getElementById("refresh").title = "";
      this.stopProgress();
      this.setStatus(refresh
        ? this.strings.loading
        : this.strings.readingCache);
      if (refresh) this.startProgress(kind);
    }
    this.setBusy(true, tab);
    try {
      let cacheStatus = null;
      if (!refresh && kind !== "relation" && api.snapshotStatus) {
        try {
          cacheStatus = await api.snapshotStatus(itemKey, kind, libraryID);
        } catch (error) {
          console.warn("Relation cache status unavailable", error);
        }
        if (!this.tabRequestIsCurrent(
          tab,
          "snapshot",
          request,
          generation,
        )) return;
      }
      // Nothing saved for this paper. Opening one is not an instruction to call
      // the providers, so the fetch waits to be asked for: that is what keeps a
      // click from turning into an unannounced round of network work, and it puts
      // every cache miss on screen instead of hiding it behind a progress bar.
      // A missing cacheStatus means the probe itself failed rather than that the
      // cache is empty, so it falls through to the fetch and surfaces the error.
      if (kind !== "relation" && !refresh && cacheStatus && !cacheStatus.loaded) {
        tab.snapshot = null;
        tab.needsFetch = true;
        // Before rendering, not only in the `finally`: the prompt is the
        // not-busy empty state, and a still-busy view would draw "Loading…" over
        // the very thing that says nothing is being loaded.
        this.setBusy(false, tab);
        if (this.tabIsActive(tab) && tab.kind === kind) {
          this.snapshot = null;
          // Including the source picker: without a snapshot behind them, the
          // previous paper's per-source options would otherwise stay on screen.
          this.configureSources();
          this.configurePublicationLevels();
          this.configureKindPresentation();
          this.render();
        } else {
          this.renderTabs();
        }
        return;
      }
      if (
        this.tabIsActive(tab) &&
        kind !== "relation" &&
        !refresh &&
        !cacheStatus
      ) {
        this.setStatus(this.strings.loading);
        this.startProgress(kind);
      }
      let snapshot = await api.snapshot(
        itemKey,
        kind,
        Boolean(refresh),
        libraryID,
      );
      if (!this.tabRequestIsCurrent(tab, "snapshot", request, generation)) return;
      tab.snapshot = snapshot;
      tab.title = snapshot.seed.title;
      this.rememberSnapshot(itemKey, kind, snapshot);
      tab.busy = false;
      if (this.tabIsActive(tab) && tab.kind === kind) {
        this.snapshot = snapshot;
        this.activeSource = tab.activeSource;
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
      tab.error = this.strings.error + ": " + String(error);
      // Clear busy before rendering, not only in the `finally`: the retry prompt
      // is a not-busy empty state, and a still-busy view would draw "Loading…"
      // over the failure — leaving a paper that failed to fetch looking like one
      // still fetching, with nothing to click.
      this.setBusy(false, tab);
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
    let libraryID = this.libraryID();
    this.setBusy(true, tab);
    if (this.tabIsActive(tab)) {
      this.setStatus(this.strings.loading);
      this.startProgress(tab.kind);
    }
    try {
      let snapshot = await api.loadMoreCitations(itemKey, libraryID);
      if (!this.tabRequestIsCurrent(tab, "snapshot", request, generation)) return;
      tab.snapshot = snapshot;
      this.rememberSnapshot(itemKey, tab.kind, snapshot);
      tab.busy = false;
      if (this.tabIsActive(tab)) {
        this.snapshot = snapshot;
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
      let tab = this.activeTabState();
      if (this.busy) {
        this.renderEmpty(rows, this.strings.loading, 6);
      } else if (tab && tab.needsFetch && this.kind !== "relation") {
        this.renderFetchPrompt(rows, 6);
        this.setStatus(this.strings.notCached);
      } else if (tab && tab.error) {
        // A failed fetch leaves nothing to show, and the status line it wrote
        // sits above a table that says only "no results" — which reads as the
        // paper having none. The same prompt the cache miss uses puts the retry
        // where the missing rows are, so a fetch that failed for a reason the
        // user has since fixed (a DOI filled in, a provider back up) can be
        // asked for again without hunting for the toolbar.
        this.renderFetchPrompt(rows, 6, tab.error);
        this.setStatus(tab.error, true);
      } else {
        this.renderEmpty(rows, this.strings.empty, 6);
      }
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

  /**
   * Empty state for a paper with nothing saved yet.
   *
   * The providers are reached from here and from Refresh, and from nowhere else,
   * so opening a paper never starts network work on its own — and a paper whose
   * shard went missing is visible as such rather than as another wait.
   */
  renderFetchPrompt(rows, columnCount, text) {
    let row = document.createElement("tr");
    let cell = document.createElement("td");
    cell.colSpan = columnCount;
    cell.className = "empty-cell";
    let message = document.createElement("div");
    message.textContent = text || this.strings.notCached;
    let action = document.createElement("button");
    action.className = "fetch-now";
    action.textContent = this.strings.fetchNow;
    action.addEventListener("click", () => void this.load(true));
    cell.append(message, action);
    row.append(cell);
    rows.append(row);
    document.getElementById("load-more").hidden = true;
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
