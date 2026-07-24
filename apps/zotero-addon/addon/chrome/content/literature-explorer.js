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
  mode: "collection",
  collectionSnapshot: null,
  collectionBusy: false,
  activeItemKey: null,
  kind: "references",
  snapshot: null,
  busy: false,
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
    document.getElementById("collection-search")
      .addEventListener("input", () => this.renderCollection());
    document.getElementById("collection-refresh")
      .addEventListener("click", () => this.loadCollection());
    document.getElementById("back-to-collection")
      .addEventListener("click", () => this.showCollection());
    document.getElementById("search").addEventListener("input", () => this.render());
    document.getElementById("year-from").addEventListener("input", () => this.render());
    document.getElementById("year-to").addEventListener("input", () => this.render());
    document.getElementById("refresh").addEventListener("click", () => this.load(true));
    document.getElementById("load-more").addEventListener("click", () => this.loadMore());
    this.reloadContext();
  },

  applyStrings() {
    let s = this.strings;
    document.title = s.title;
    document.getElementById("app-title").textContent = s.title;
    document.getElementById("back-to-collection").title = s.backToCollection;
    document.getElementById("label-collection-search").textContent = s.searchLabel;
    document.getElementById("collection-search").placeholder = s.collectionSearch;
    document.getElementById("collection-refresh").textContent = s.refresh;
    document.getElementById("collection-head-title").textContent = s.titleColumn;
    document.getElementById("collection-head-creator").textContent = s.creatorColumn;
    document.getElementById("collection-head-year").textContent = s.yearColumn;
    document.getElementById("collection-head-date-added").textContent =
      s.dateAddedColumn;
    document.getElementById("collection-head-markdown").textContent = s.markdownColumn;
    document.getElementById("collection-head-references").textContent = s.references;
    document.getElementById("collection-head-citations").textContent = s.citations;
    document.getElementById("tab-references").textContent = s.references;
    document.getElementById("tab-citations").textContent = s.citations;
    document.getElementById("label-search").textContent = s.searchLabel;
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
      this.render();
    };
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
      ["newest", this.strings.newest],
    ], "original", rerender("order"));
  },

  createDropdown(id, initialOptions, initialValue, onChange) {
    let host = document.getElementById(id);
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
    document.addEventListener("mousedown", (event) => {
      if (!host.contains(event.target) && !menu.contains(event.target)) close();
    }, true);
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
    };
  },

  reloadContext() {
    this.context = api.getContext();
    this.collectionSnapshot = null;
    this.snapshot = null;
    this.activeItemKey = this.context && this.context.itemKey || null;
    this.kind = this.context && this.context.kind || "references";
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
    document.getElementById("collection-view").hidden = mode !== "collection";
    document.getElementById("detail-view").hidden = mode !== "detail";
    document.getElementById("back-to-collection").hidden = mode !== "detail";
  },

  async loadCollection() {
    if (this.collectionBusy) return;
    this.showView("collection");
    this.collectionBusy = true;
    document.getElementById("collection-refresh").disabled = true;
    document.getElementById("paper-title").textContent =
      this.context && this.context.scope ? this.context.scope.name :
        this.strings.collectionOverview;
    this.setCollectionStatus(this.strings.loading);
    try {
      this.collectionSnapshot = await api.collectionSnapshot();
      document.getElementById("paper-title").textContent =
        this.collectionSnapshot.scope.name;
      this.renderCollection();
    } catch (error) {
      this.collectionSnapshot = null;
      this.setCollectionStatus(this.strings.error + ": " + String(error), true);
      this.renderCollection();
    } finally {
      this.collectionBusy = false;
      document.getElementById("collection-refresh").disabled = false;
    }
  },

  showCollection() {
    this.showView("collection");
    if (!this.collectionSnapshot) {
      this.loadCollection();
      return;
    }
    document.getElementById("paper-title").textContent =
      this.collectionSnapshot.scope.name;
    this.renderCollection();
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

  renderCollectionRow(item) {
    let row = document.createElement("tr");

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
      button.addEventListener("click", () => api.selectItem(item.itemID));
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

  collectionRelationCell(item, kind) {
    let cell = document.createElement("td");
    cell.className = "state";
    let status = item[kind];
    let button = document.createElement("button");
    button.className = "state-action " + (status.loaded ? "ready" : "pending");
    if (status.loaded) {
      let count = status.total || status.count;
      button.textContent = `✓ ${new Intl.NumberFormat().format(count)}`;
      button.title = this.strings.loaded;
      button.addEventListener("click", () => this.showDetail(item.itemKey, kind));
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

  async runCollectionAction(button, item, action) {
    button.disabled = true;
    let previous = button.textContent;
    button.textContent = "…";
    try {
      let updated = action === "markdown"
        ? await api.convertItem(item.itemKey)
        : await api.loadRelation(item.itemKey, action);
      Object.assign(item, updated);
      this.renderCollection();
    } catch (error) {
      button.disabled = false;
      button.textContent = previous;
      this.setCollectionStatus(this.strings.error + ": " + String(error), true);
    }
  },

  setCollectionStatus(text, error) {
    let status = document.getElementById("collection-status");
    status.textContent = text || "";
    status.classList.toggle("error", !!error);
  },

  displayDate(value) {
    let match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : (value || "—");
  },

  resetFilters() {
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
      ? (this.kind === "references" ? "original" : "influential")
      : this.filters.order;
    this.filters.order = next;
    this.dropdowns.order.setValue(next);
  },

  async showDetail(itemKey, kind) {
    let changedItem = itemKey !== this.activeItemKey;
    this.activeItemKey = itemKey;
    this.kind = kind || "references";
    this.showView("detail");
    if (changedItem) this.resetFilters();
    this.configureSort(true);
    let known = this.collectionSnapshot && this.collectionSnapshot.items
      .find((item) => item.itemKey === itemKey);
    document.getElementById("paper-title").textContent =
      known ? known.title : this.strings.loading;
    await this.load(false);
  },

  async switchKind(kind) {
    if (this.busy || kind === this.kind || !this.activeItemKey) return;
    this.kind = kind;
    this.configureSort(true);
    await this.load(false);
  },

  async load(refresh) {
    if (this.busy || !this.activeItemKey) return;
    this.setBusy(true);
    this.setStatus(this.strings.loading);
    try {
      this.snapshot = await api.snapshot(
        this.activeItemKey,
        this.kind,
        Boolean(refresh),
      );
      this.syncCollectionRelationStatus();
      document.getElementById("paper-title").textContent = this.snapshot.seed.title;
      this.configurePublicationLevels();
      this.render();
    } catch (error) {
      this.snapshot = null;
      this.configurePublicationLevels();
      this.setStatus(this.strings.error + ": " + String(error), true);
      this.render();
    } finally {
      this.setBusy(false);
    }
  },

  async loadMore() {
    if (this.busy || this.kind !== "citations" || !this.activeItemKey) return;
    this.setBusy(true);
    this.setStatus(this.strings.loading);
    try {
      this.snapshot = await api.loadMoreCitations(this.activeItemKey);
      this.syncCollectionRelationStatus();
      this.configurePublicationLevels();
      this.render();
    } catch (error) {
      this.setStatus(this.strings.error + ": " + String(error), true);
    } finally {
      this.setBusy(false);
    }
  },

  setBusy(value) {
    this.busy = value;
    document.getElementById("refresh").disabled = value;
    document.getElementById("load-more").disabled = value;
  },

  setStatus(text, error) {
    let status = document.getElementById("status");
    status.textContent = text || "";
    status.classList.toggle("error", !!error);
  },

  syncCollectionRelationStatus() {
    if (!this.collectionSnapshot || !this.snapshot || !this.activeItemKey) return;
    let paper = this.collectionSnapshot.items
      .find((item) => item.itemKey === this.activeItemKey);
    if (!paper) return;
    paper[this.kind] = {
      loaded: true,
      count: this.snapshot.loaded,
      total: this.snapshot.total,
    };
  },

  visibleItems() {
    if (!this.snapshot) return [];
    let query = document.getElementById("search").value.trim().toLocaleLowerCase();
    let years = this.selectedYearRange();
    let items = this.snapshot.items.filter((item) => {
      if (this.filters.library === "in" && !item.membership.inLibrary) return false;
      if (this.filters.library === "out" && item.membership.inLibrary) return false;
      if (this.filters.influence === "influential" && item.isInfluential !== true) {
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
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.kind === this.kind);
    });
    let rows = document.getElementById("rows");
    rows.replaceChildren();
    let items = this.visibleItems();
    if (!this.snapshot) {
      this.renderEmpty(rows, this.busy ? this.strings.loading : this.strings.empty, 6);
      return;
    }
    if (!items.length) {
      this.renderEmpty(rows, this.strings.empty, 6);
    } else {
      items.forEach((item) => rows.append(this.renderRow(item)));
    }
    let shown = items.length;
    let loaded = this.snapshot.loaded;
    let total = this.snapshot.total;
    this.setStatus(
      shown === loaded
        ? `${loaded}/${total} · ${this.snapshot.source}`
        : `${shown} / ${loaded}/${total} · ${this.snapshot.source}`,
    );
    document.getElementById("load-more").hidden =
      this.kind !== "citations" || !this.snapshot.hasMore;
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

    let titleCell = document.createElement("td");
    let title = document.createElement("button");
    title.className = "paper-link";
    title.textContent = item.title || item.text || "Untitled";
    title.title = this.strings.open;
    title.addEventListener("click", () => api.launchURL(this.paperURL(item)));
    let meta = document.createElement("div");
    meta.className = "paper-meta";
    meta.textContent = (item.authors || []).slice(0, 4).join(", ") ||
      item.primaryVenue || "";
    titleCell.append(title, meta);
    row.append(titleCell);

    row.append(this.cell(item.year || "—", "numeric"));
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

  cell(text, className) {
    let cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
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
