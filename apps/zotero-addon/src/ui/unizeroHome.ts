/**
 * Unizero Home: the library-wide UniConnection overview, as a tab of the main window
 * opened from a button on the items toolbar (docs/UNICONNECTION.md §5.4).
 *
 * Left, References: the papers being worked on, latest activity first (a highlight,
 * a passage attached, a note edited, References loaded), each with the papers it
 * quoted. Right, Citations: each quoted paper, with who quoted it. Partners are only
 * the hand-attached passages (excerpt notes), never the providers' References; a
 * partner opens to its passages, which open the PDF. Each paper has buttons for its PDF, Raw, Canvas,
 * UniConnection full and its place in the library; double-click opens the PDF.
 * Selecting a paper highlights its partners in the other column. Everything is read
 * locally (index, Zotero); nothing here reaches a provider. The
 * one write is the Canvas button on a paper without one, which creates it, empty.
 *
 * Host traps:
 * - Zotero saves its open tabs and restores them at startup by type; a type it has
 *   no hook for stops the restore there. So each window's `Zotero_Tabs.getState` is
 *   wrapped to leave Home out of the saved session (unwrapped on unload), and where
 *   the tab-hook table exists Home registers hooks that drop a stray saved Home tab.
 * - Tab types are split on "-" by Zotero, so the type has none.
 * - Zotero 9+ can hold several library views per window, each with its own items
 *   toolbar; buttons are added to every toolbar found, again whenever a tab opens.
 */

import { config } from "../../package.json";
import { uniConnection } from "../modules/uniConnection";
import { libraryActivity, sqlTime } from "../zotero/uniConnectionActivity";
import { openExcerpt } from "../zotero/excerptAnnotations";
import { canvasAttachment, ensureCanvasAttachment } from "../zotero/canvasAdapter";
import { attachmentSummary, pdfAttachment, rawAttachment } from "../zotero/literatureCollectionAdapter";
import { libraryHit } from "../zotero/librarySearch";
import { getString } from "../utils/locale";
import { rowCredit } from "./literatureSidebarModel";
import {
  columnRows,
  homeColumns,
  type ActivityKind,
  type HomeColumn,
  type HomeExcerpt,
  type HomePaper,
  type HomePartner,
  type HomeQuery,
  type HomeRow,
  type HomeSort,
} from "./unizeroHomeModel";

const TAB_TYPE = `${config.addonRef}Home`;
const BUTTON_CLASS = `${config.addonRef}-home-button`;
const STYLE_ID = `${config.addonRef}-home-style`;
const XHTML = "http://www.w3.org/1999/xhtml";
const CLASS = "unizero-home";
const RELOAD_DELAY_MS = 1500;
/** Rows drawn per column before "Show more"; search narrows the rest. */
const ROW_PAGE = 300;
/** Partners shown under a row before "N more". */
const PARTNER_PAGE = 5;

type OpenTarget = "pdf" | "raw" | "canvas" | "full" | "library";

interface ColumnState extends HomeQuery {
  limit: number;
  ui: {
    heading: HTMLElement;
    list: HTMLElement;
    search: HTMLInputElement;
    sort: HTMLSelectElement;
  };
}

interface HomeView {
  win: Window;
  tabID: string;
  root: HTMLElement;
  libraryID: number;
  /** Empty: the whole library. */
  collectionKey: string;
  subcollections: boolean;
  papers: HomePaper[];
  data: Record<HomeColumn, HomeRow[]>;
  selected?: { column: HomeColumn; key: string };
  /** Partners the user folded; passages show by default. By `column|row|partner`. */
  collapsed: Set<string>;
  /** Rows showing all their partners, by `column|row`. */
  expanded: Set<string>;
  columns: Record<HomeColumn, ColumnState>;
  loading: boolean;
  error?: string;
  generation: number;
  /** Library data changed while the tab was in the background. */
  stale: boolean;
  ui: { library: HTMLSelectElement; collection: HTMLSelectElement; subcollections: HTMLInputElement; status: HTMLElement };
}

interface WindowHooks {
  getState?: (...args: unknown[]) => unknown;
  wrapped?: (...args: unknown[]) => unknown;
  hookActions: string[];
}

export interface UnizeroHomeDeps {
  openFull(win: Window, item: Zotero.Item): void;
}

function t(key: string, fallback: string, args?: Record<string, unknown>): string {
  const id = `home-${key}`;
  let value: string | undefined;
  try {
    value = args ? getString(id, { args }) : getString(id);
  } catch {
    value = undefined;
  }
  if (value && !value.endsWith(id)) { return value; }
  return fallback.replace(/\{ \$(\w+) \}/g, (_, name: string) => String(args?.[name] ?? ""));
}

function create<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
  if (className) { element.className = className; }
  if (text !== undefined) { element.textContent = text; }
  return element;
}

function option(doc: Document, value: string, label: string): HTMLOptionElement {
  const element = create(doc, "option", undefined, label);
  element.value = value;
  return element;
}

function itemOf(key: string): Zotero.Item | undefined {
  const separator = key.indexOf(":");
  const item = Zotero.Items.getByLibraryAndKey(Number(key.slice(0, separator)), key.slice(separator + 1)) as
    Zotero.Item | false;
  return item && !item.deleted ? item : undefined;
}

/** The libraries Home offers: the user library and groups (not feeds). */
function homeLibraries(): Array<{ libraryID: number; name: string }> {
  return (Zotero.Libraries.getAll() as any[])
    .filter((each) => each.libraryType === "user" || each.libraryType === "group");
}

function paperOf(item: Zotero.Item): HomePaper {
  return {
    ...libraryHit(item),
    dateAdded: sqlTime((item as any).dateAdded),
    venue: String(item.getField("publicationTitle") || ""),
  };
}

function relativeTime(time: number): string {
  const days = Math.floor((Date.now() - time) / 86_400_000);
  if (days <= 0) { return t("today", "today"); }
  if (days < 30) { return t("days-ago", "{ $count } d ago", { count: days }); }
  return new Date(time).toISOString().slice(0, 10);
}

function activityLabel(kind: ActivityKind): string {
  switch (kind) {
    case "highlight": return t("activity-highlight", "Highlighted");
    case "excerpt": return t("activity-excerpt", "Quoted");
    case "note": return t("activity-note", "Note edited");
    case "references": return t("activity-references", "References loaded");
  }
}

export class UnizeroHome {
  private readonly views = new Map<Window, HomeView>();
  private readonly hooks = new Map<Window, WindowHooks>();
  private observerID?: string;
  private reloadTimer?: ReturnType<typeof setTimeout>;

  public constructor(private readonly deps: UnizeroHomeDeps) {}

  /** Per main window: toolbar buttons, stylesheet, and the session guard. */
  public register(win: Window): void {
    if (this.hooks.has(win)) { return; }
    this.addStyle(win.document);
    this.guardSession(win);
    this.addButtons(win);
    this.observe();
  }

  public unregister(win: Window): void {
    this.close(win);
    for (const button of Array.from(win.document.querySelectorAll(`.${BUTTON_CLASS}`))) { button.remove(); }
    win.document.getElementById(STYLE_ID)?.remove();
    this.releaseSession(win);
    if (!this.hooks.size && !this.views.size) { this.unobserve(); }
  }

  public shutdown(): void {
    for (const win of [...this.hooks.keys(), ...this.views.keys()]) { this.unregister(win); }
    this.unobserve();
  }

  /** Open Home in `win`, or switch to its Home tab. */
  public open(win: Window): void {
    const tabs = (win as any).Zotero_Tabs;
    if (!tabs?.add) { return; }
    const existing = this.views.get(win);
    if (existing) {
      tabs.select(existing.tabID);
      if (existing.stale) { void this.load(existing); }
      return;
    }
    const { id, container } = tabs.add({
      type: TAB_TYPE,
      title: t("title", "Unizero Home"),
      data: {},
      select: true,
      onClose: () => this.forget(win),
    });
    const view = this.mount(win, id, container as HTMLElement);
    this.views.set(win, view);
    void this.load(view);
  }

  // ------------------------------------------------------------------ host

  private close(win: Window): void {
    const view = this.views.get(win);
    if (!view) { return; }
    this.forget(win);
    try { (win as any).Zotero_Tabs?.close?.(view.tabID); } catch { /* window closing */ }
  }

  private forget(win: Window): void {
    const view = this.views.get(win);
    if (!view) { return; }
    view.generation += 1;
    this.views.delete(win);
  }

  /** Keep Home out of the saved session; see the header. */
  private guardSession(win: Window): void {
    const tabs = (win as any).Zotero_Tabs;
    const record: WindowHooks = { hookActions: [] };
    if (typeof tabs?.getState === "function") {
      const getState = tabs.getState as (...args: unknown[]) => unknown;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const state = getState.apply(this, args);
        return Array.isArray(state)
          ? state.filter((tab: { type?: string }) => !String(tab?.type || "").startsWith(TAB_TYPE))
          : state;
      };
      tabs.getState = wrapped;
      record.getState = getState;
      record.wrapped = wrapped;
    }
    const table = tabs?.tabHooks as Record<string, Record<string, unknown>> | undefined;
    if (table && typeof table === "object") {
      const drop = {
        // A saved Home tab (from an older build, or a crash) is skipped, not restored.
        restoreState: async () => ({}),
        // Reopening a closed Home tab opens a fresh one.
        undoClose: async () => { this.open(win); },
      } as Record<string, unknown>;
      for (const [action, hook] of Object.entries(drop)) {
        table[action] ||= {};
        if (!table[action][TAB_TYPE]) {
          table[action][TAB_TYPE] = hook;
          record.hookActions.push(action);
        }
      }
    }
    this.hooks.set(win, record);
  }

  private releaseSession(win: Window): void {
    const record = this.hooks.get(win);
    if (!record) { return; }
    const tabs = (win as any).Zotero_Tabs;
    if (tabs && record.getState && tabs.getState === record.wrapped) { tabs.getState = record.getState; }
    for (const action of record.hookActions) { delete tabs?.tabHooks?.[action]?.[TAB_TYPE]; }
    this.hooks.delete(win);
  }

  private addButtons(win: Window): void {
    const doc = win.document;
    const toolbars = doc.querySelectorAll("#zotero-items-toolbar, .zotero-items-toolbar");
    for (const toolbar of Array.from(new Set(Array.from(toolbars)))) {
      if (toolbar.querySelector(`.${BUTTON_CLASS}`)) { continue; }
      const button = (doc as any).createXULElement("toolbarbutton") as Element;
      button.setAttribute("class", `zotero-tb-button ${BUTTON_CLASS}`);
      button.setAttribute("tooltiptext", t("button", "Open Unizero Home"));
      button.setAttribute("tabindex", "-1");
      button.addEventListener("command", () => this.open(win));
      const spacer = Array.from(toolbar.children).find((child) =>
        child.localName === "spacer" && child.getAttribute("flex"));
      toolbar.insertBefore(button, spacer || null);
    }
  }

  private addStyle(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) { return; }
    const style = create(doc, "style");
    style.id = STYLE_ID;
    style.textContent = HOME_CSS;
    doc.documentElement.appendChild(style);
  }

  /** Library changes reload a visible Home; tab events add toolbar buttons and refresh a stale Home. */
  private observe(): void {
    if (this.observerID) { return; }
    this.observerID = Zotero.Notifier.registerObserver({
      notify: async (event: string, type: string, ids: unknown[]) => {
        if (type === "tab") {
          for (const win of this.hooks.keys()) { this.addButtons(win); }
          if (event === "select") {
            for (const view of this.views.values()) {
              if (ids.includes(view.tabID) && view.stale) { void this.load(view); }
            }
          }
          return;
        }
        if (!this.views.size) { return; }
        if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = undefined;
          for (const view of this.views.values()) {
            if (this.visible(view)) { void this.load(view); } else { view.stale = true; }
          }
        }, RELOAD_DELAY_MS);
      },
    }, ["item", "collection-item", "tab"], `${config.addonRef}-home`);
  }

  private unobserve(): void {
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
    this.reloadTimer = undefined;
    if (this.observerID) { Zotero.Notifier.unregisterObserver(this.observerID); }
    this.observerID = undefined;
  }

  private visible(view: HomeView): boolean {
    return (view.win as any).Zotero_Tabs?.selectedID === view.tabID;
  }

  // ------------------------------------------------------------------ view

  private mount(win: Window, tabID: string, container: HTMLElement): HomeView {
    const doc = win.document;
    const pane = (win as any).ZoteroPane;
    let libraryID = Zotero.Libraries.userLibraryID;
    let collectionKey = "";
    try {
      libraryID = pane?.getSelectedLibraryID?.() ?? pane?.getSelectedLibraryIDs?.()?.[0] ?? libraryID;
      const collection = pane?.getSelectedCollection?.() ?? pane?.getSelectedCollections?.()?.[0];
      if (collection?.libraryID === libraryID) { collectionKey = String(collection.key); }
    } catch {
      // Start from the user library.
    }

    const root = create(doc, "div", CLASS);
    const header = create(doc, "div", `${CLASS}__header`);
    header.append(create(doc, "div", `${CLASS}__title`, t("title", "Unizero Home")));
    const library = create(doc, "select", `${CLASS}__select`);
    const collection = create(doc, "select", `${CLASS}__select`);
    const subLabel = create(doc, "label", `${CLASS}__check`);
    const subcollections = create(doc, "input");
    subcollections.type = "checkbox";
    subLabel.append(subcollections, doc.createTextNode(` ${t("subcollections", "Include subcollections")}`));
    const refresh = create(doc, "div", `${CLASS}__action`, "⟳");
    refresh.title = t("refresh", "Read the library again");
    refresh.setAttribute("role", "button");
    const status = create(doc, "div", `${CLASS}__status`);
    header.append(library, collection, subLabel, refresh, status);

    const columnsElement = create(doc, "div", `${CLASS}__columns`);
    root.append(header, columnsElement);
    container.append(root);

    const view: HomeView = {
      win, tabID, root, libraryID, collectionKey, subcollections: false,
      papers: [], data: { references: [], citations: [] }, collapsed: new Set(), expanded: new Set(),
      columns: {} as Record<HomeColumn, ColumnState>,
      loading: false, generation: 0, stale: false,
      ui: { library, collection, subcollections, status },
    };
    for (const column of ["references", "citations"] as const) {
      view.columns[column] = this.column(view, column, columnsElement);
    }

    library.addEventListener("change", () => {
      view.libraryID = Number(library.value);
      view.collectionKey = "";
      view.selected = undefined;
      void this.load(view);
    });
    collection.addEventListener("change", () => {
      view.collectionKey = collection.value;
      void this.load(view);
    });
    subcollections.addEventListener("change", () => {
      view.subcollections = subcollections.checked;
      void this.load(view);
    });
    refresh.addEventListener("click", () => { void this.load(view, true); });
    return view;
  }

  private column(view: HomeView, column: HomeColumn, parent: HTMLElement): ColumnState {
    const doc = view.win.document;
    const element = create(doc, "div", `${CLASS}__column`);
    element.dataset.column = column;
    const heading = create(doc, "div", `${CLASS}__heading`);
    const hint = create(doc, "div", `${CLASS}__hint`, column === "references"
      ? t("references-hint", "Papers by latest activity — highlights, quotes, notes, References — and what each quoted")
      : t("citations-hint", "Papers you quoted, and who quoted them"));
    const toolbar = create(doc, "div", `${CLASS}__toolbar`);
    const search = create(doc, "input", `${CLASS}__search`);
    search.type = "search";
    search.placeholder = t("search", "Search title, author, year");
    const sort = create(doc, "select", `${CLASS}__select`);
    sort.append(
      option(doc, "default", column === "references"
        ? t("sort-recent-activity", "Recent activity")
        : t("sort-recent-cited", "Recently cited")),
      option(doc, "count", column === "references"
        ? t("sort-most-quoting", "Quotes most papers")
        : t("sort-most-cited", "Quoted by most papers")),
      option(doc, "dateAdded", t("sort-added", "Date added")),
      option(doc, "year", t("sort-year", "Year")),
    );
    toolbar.append(search, sort);
    const list = create(doc, "div", `${CLASS}__list`);
    list.setAttribute("role", "listbox");
    element.append(heading, hint, toolbar, list);
    parent.append(element);

    const state: ColumnState = {
      column, sort: "default", query: "", limit: ROW_PAGE,
      ui: { heading, list, search, sort },
    };
    search.addEventListener("input", () => {
      state.query = search.value;
      state.limit = ROW_PAGE;
      this.drawColumn(view, state);
    });
    sort.addEventListener("change", () => {
      state.sort = sort.value as HomeSort;
      this.drawColumn(view, state);
    });
    return state;
  }

  private async load(view: HomeView, rebuild = false): Promise<void> {
    const generation = ++view.generation;
    view.loading = true;
    view.stale = false;
    view.error = undefined;
    // Opened from a feed, or the group is gone: the picker has no entry for it.
    if (!homeLibraries().some((each) => each.libraryID === view.libraryID)) {
      view.libraryID = Zotero.Libraries.userLibraryID;
      view.collectionKey = "";
      view.selected = undefined;
    }
    this.drawScope(view);
    this.drawStatus(view);
    try {
      if (rebuild) { await uniConnection.build(view.libraryID); }
      const collectionKey = view.collectionKey;
      const items = await this.scopeItems(view);
      // A deleted collection falls back to the whole library; show that in the picker.
      if (view.collectionKey !== collectionKey && generation === view.generation) { this.drawScope(view); }
      const [pairs, references, activity] = await Promise.all([
        uniConnection.excerptPairs(view.libraryID),
        uniConnection.referencesLoadedAt(view.libraryID),
        libraryActivity(view.libraryID),
      ]);
      if (generation !== view.generation) { return; }
      view.papers = items.map(paperOf);
      view.data = homeColumns(view.papers, pairs, { ...activity, references }, (key) => {
        const item = itemOf(key);
        return item?.isRegularItem() ? paperOf(item) : undefined;
      });
    } catch (error) {
      if (generation !== view.generation) { return; }
      view.error = String((error as Error)?.message || error);
      ztoolkit.log("[home] load failed", error);
    } finally {
      if (generation === view.generation) {
        view.loading = false;
        this.draw(view);
      }
    }
  }

  private async scopeItems(view: HomeView): Promise<Zotero.Item[]> {
    const live = (item: Zotero.Item) => item.isRegularItem() && !item.deleted;
    if (!view.collectionKey) {
      return (await Zotero.Items.getAll(view.libraryID, true, false) as Zotero.Item[]).filter(live);
    }
    const collection = Zotero.Collections.getByLibraryAndKey(view.libraryID, view.collectionKey) as
      Zotero.Collection | false;
    if (!collection) {
      view.collectionKey = "";
      return this.scopeItems(view);
    }
    const collections = [collection];
    if (view.subcollections) {
      collections.push(...(Zotero.Collections.getByParent(collection.id, true) as Zotero.Collection[]));
    }
    const items = new Map<number, Zotero.Item>();
    for (const each of collections) {
      for (const item of each.getChildItems(false, false) as Zotero.Item[]) {
        if (live(item)) { items.set(item.id, item); }
      }
    }
    return [...items.values()];
  }

  private drawScope(view: HomeView): void {
    const doc = view.win.document;
    const { library, collection, subcollections } = view.ui;
    library.replaceChildren(...homeLibraries()
      .map((each) => option(doc, String(each.libraryID), String(each.name))));
    library.value = String(view.libraryID);

    const all = Zotero.Collections.getByLibrary(view.libraryID, true) as Zotero.Collection[];
    const byParent = new Map<string, Zotero.Collection[]>();
    for (const each of all) {
      const parent = String(each.parentKey || "");
      byParent.set(parent, [...(byParent.get(parent) || []), each]);
    }
    const options = [option(doc, "", t("all-items", "All items"))];
    const walk = (parent: string, depth: number) => {
      for (const each of (byParent.get(parent) || []).sort((a, b) => a.name.localeCompare(b.name))) {
        options.push(option(doc, String(each.key), `${"  ".repeat(depth)}${each.name}`));
        walk(String(each.key), depth + 1);
      }
    };
    walk("", 0);
    collection.replaceChildren(...options);
    collection.value = view.collectionKey;
    subcollections.checked = view.subcollections;
    subcollections.disabled = !view.collectionKey;
  }

  private drawStatus(view: HomeView): void {
    view.ui.status.textContent = view.loading
      ? t("loading", "Loading…")
      : view.error || t("papers", "{ $count } papers", { count: view.papers.length });
  }

  private draw(view: HomeView): void {
    if (!view.root.isConnected) { return; }
    this.drawStatus(view);
    for (const column of ["references", "citations"] as const) { this.drawColumn(view, view.columns[column]); }
  }

  private drawColumn(view: HomeView, state: ColumnState): void {
    const doc = view.win.document;
    const rows = columnRows(view.data[state.column], state);
    const label = state.column === "references"
      ? t("column-references", "References")
      : t("column-citations", "Citations");
    state.ui.heading.textContent = `${label} · ${rows.length}`;
    const list = state.ui.list;
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    if (!rows.length) {
      list.append(create(doc, "div", `${CLASS}__empty`, view.loading
        ? t("loading", "Loading…")
        : state.column === "references"
          ? t("references-empty", "Nothing has happened to the papers here yet: no highlights, quotes, notes or References.")
          : t("citations-empty", "No paper here has been quoted yet.")));
      return;
    }
    const linked = this.linked(view, state.column);
    for (const row of rows.slice(0, state.limit)) { list.append(this.rowElement(view, state, row, linked)); }
    if (rows.length > state.limit) {
      const more = create(doc, "div", `${CLASS}__action ${CLASS}__more`,
        t("show-more", "Show { $count } more", { count: Math.min(ROW_PAGE, rows.length - state.limit) }));
      more.setAttribute("role", "button");
      more.addEventListener("click", () => {
        state.limit += ROW_PAGE;
        this.drawColumn(view, state);
      });
      list.append(more);
    }
    list.scrollTop = scrollTop;
  }

  /** Papers to highlight in `column`: the selected paper's partners from the other column. */
  private linked(view: HomeView, column: HomeColumn): Set<string> {
    const selected = view.selected;
    if (!selected || selected.column === column) { return new Set(); }
    const row = view.data[selected.column].find((each) => each.scopedKey === selected.key);
    return new Set(row?.partners.map((each) => each.scopedKey) || []);
  }

  private rowElement(view: HomeView, state: ColumnState, row: HomeRow, linked: Set<string>): HTMLElement {
    const doc = view.win.document;
    const references = state.column === "references";
    const element = create(doc, "div", `${CLASS}__row`);
    element.setAttribute("role", "option");
    element.tabIndex = 0;
    element.dataset.key = row.scopedKey;
    const selected = view.selected?.column === state.column && view.selected.key === row.scopedKey;
    element.classList.toggle("is-selected", selected);
    element.classList.toggle("is-linked", linked.has(row.scopedKey));
    element.setAttribute("aria-selected", String(selected));

    const head = create(doc, "div", `${CLASS}__head`);
    head.append(this.icon(doc, row.paper), this.paperText(doc, row.paper, `${CLASS}__text`));
    const meta = create(doc, "div", `${CLASS}__meta`);
    if (references && row.highlights) {
      const highlights = create(doc, "span", `${CLASS}__badge`, `🖍 ${row.highlights}`);
      highlights.title = t("highlights", "{ $count } annotations", { count: row.highlights });
      meta.append(highlights);
    }
    const papers = row.partners.length;
    if (papers) {
      const badge = create(doc, "span", `${CLASS}__badge`, `${references ? "→" : "←"} ${papers}`);
      badge.title = references
        ? t("quoting", "Quotes { $count } papers", { count: papers })
        : t("quoted-by", "Quoted by { $count } papers", { count: papers });
      meta.append(badge);
    }
    if (row.quotes) {
      const passages = create(doc, "span", `${CLASS}__badge ${CLASS}__badge--quote`, `❝ ${row.quotes}`);
      passages.title = t("passages", "{ $count } passages", { count: row.quotes });
      meta.append(passages);
    }
    if (row.time) {
      const time = create(doc, "span", `${CLASS}__time`,
        row.activity ? `${activityLabel(row.activity.kind)} · ${relativeTime(row.time)}` : relativeTime(row.time));
      time.title = new Date(row.time).toLocaleString();
      meta.append(time);
    }
    head.append(meta);
    element.append(head, this.actions(view, row.scopedKey, `${CLASS}__actions`));

    if (row.partners.length) {
      const partners = create(doc, "div", `${CLASS}__partners`);
      const id = `${state.column}|${row.scopedKey}`;
      const all = view.expanded.has(id);
      const shown = all ? row.partners : row.partners.slice(0, PARTNER_PAGE);
      for (const partner of shown) { partners.append(this.partnerElement(view, state, row, partner)); }
      if (row.partners.length > PARTNER_PAGE) {
        const toggle = create(doc, "div", `${CLASS}__partner-more`, all
          ? t("fewer", "Show fewer")
          : t("partners-more", "{ $count } more", { count: row.partners.length - PARTNER_PAGE }));
        toggle.setAttribute("role", "button");
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          if (all) { view.expanded.delete(id); } else { view.expanded.add(id); }
          this.drawColumn(view, state);
        });
        partners.append(toggle);
      }
      element.append(partners);
    }

    head.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey) {
        this.reveal(view, row.paper.itemID);
        return;
      }
      const current = view.selected?.column === state.column && view.selected.key === row.scopedKey;
      view.selected = current ? undefined : { column: state.column, key: row.scopedKey };
      // In place, so a double-click lands on the same element.
      this.applySelection(view);
    });
    head.addEventListener("dblclick", () => { void this.openTarget(view, row.scopedKey, "pdf"); });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target === element) { void this.openTarget(view, row.scopedKey, "pdf"); }
    });
    return element;
  }

  /** One paper the row quoted (References) or that quoted it (Citations); opens to the passages. */
  private partnerElement(view: HomeView, state: ColumnState, row: HomeRow, partner: HomePartner): HTMLElement {
    const doc = view.win.document;
    const id = `${state.column}|${row.scopedKey}|${partner.scopedKey}`;
    const open = !view.collapsed.has(id);
    const element = create(doc, "div", `${CLASS}__partner`);
    element.classList.toggle("is-open", open);
    element.classList.toggle("is-missing", !partner.paper);
    const line = create(doc, "div", `${CLASS}__partner-line`);
    const chevron = create(doc, "span", `${CLASS}__chevron`, open ? "▾" : "▸");
    line.append(chevron);
    if (partner.paper) {
      line.append(this.paperText(doc, partner.paper, `${CLASS}__partner-text`));
    } else {
      line.append(create(doc, "span", `${CLASS}__partner-text`, t("missing", "Removed from the library")));
    }
    const meta = create(doc, "span", `${CLASS}__partner-meta`, `❝ ${partner.excerpts.length}`);
    if (partner.time) { meta.textContent += ` · ${relativeTime(partner.time)}`; }
    line.append(meta);
    if (partner.paper) { line.append(this.actions(view, partner.scopedKey, `${CLASS}__partner-actions`)); }
    line.title = state.column === "references"
        ? t("partner-quoted-hint", "Passages quoted from this paper — click to fold, double-click to open the PDF")
        : t("partner-quoting-hint", "Passages this paper quotes — click to fold, double-click to open the PDF");
    line.addEventListener("click", (event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && partner.paper) {
        this.reveal(view, partner.paper.itemID);
        return;
      }
      // In place, so a double-click lands on the same element.
      const opening = view.collapsed.has(id);
      if (opening) { view.collapsed.delete(id); } else { view.collapsed.add(id); }
      element.classList.toggle("is-open", opening);
      chevron.textContent = opening ? "▾" : "▸";
      element.querySelector(`.${CLASS}__passages`)?.remove();
      if (opening) { element.append(this.passagesElement(view, partner)); }
    });
    line.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (partner.paper) { void this.openTarget(view, partner.scopedKey, "pdf"); }
    });
    element.append(line);

    if (open) { element.append(this.passagesElement(view, partner)); }
    return element;
  }

  private passagesElement(view: HomeView, partner: HomePartner): HTMLElement {
    const list = create(view.win.document, "div", `${CLASS}__passages`);
    for (const excerpt of partner.excerpts) { list.append(this.passageElement(view, excerpt)); }
    return list;
  }

  /** Re-mark the selected row and its partners in the other column without redrawing. */
  private applySelection(view: HomeView): void {
    for (const column of ["references", "citations"] as const) {
      const linked = this.linked(view, column);
      for (const row of Array.from(view.columns[column].ui.list.querySelectorAll(`.${CLASS}__row`)) as HTMLElement[]) {
        const key = row.dataset.key || "";
        const selected = view.selected?.column === column && view.selected.key === key;
        row.classList.toggle("is-selected", selected);
        row.setAttribute("aria-selected", String(selected));
        row.classList.toggle("is-linked", linked.has(key));
      }
    }
  }

  /** Buttons opening what the paper has: PDF, Raw, Canvas (made on demand), full, library. */
  private actions(view: HomeView, scopedKey: string, className: string): HTMLElement {
    const doc = view.win.document;
    const bar = create(doc, "span", className);
    const item = itemOf(scopedKey);
    if (!item) { return bar; }
    let files = { hasPDF: false, hasRaw: false, hasCanvas: false };
    try {
      files = attachmentSummary(item);
    } catch (error) {
      ztoolkit.log("[home] reading attachments failed", error);
    }
    const button = (target: OpenTarget, label: string, title: string) => {
      const element = create(doc, "span", `${CLASS}__open`, label);
      element.setAttribute("role", "button");
      element.title = title;
      element.dataset.target = target;
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.openTarget(view, scopedKey, target);
      });
      element.addEventListener("dblclick", (event) => event.stopPropagation());
      bar.append(element);
    };
    if (files.hasPDF) { button("pdf", "PDF", t("open-pdf-hint", "Open the PDF")); }
    if (files.hasRaw) { button("raw", "Raw", t("open-raw-hint", "Open the Raw Markdown")); }
    button("canvas", files.hasCanvas ? "Canvas" : "+ Canvas", files.hasCanvas
      ? t("open-canvas-hint", "Open the Canvas")
      : t("create-canvas-hint", "Create an empty Canvas for this paper and open it"));
    button("full", "⤢", t("open-full-hint", "Open in UniConnection full"));
    button("library", "⌖", t("reveal-hint", "Show in the library"));
    return bar;
  }

  private async openTarget(view: HomeView, scopedKey: string, target: OpenTarget): Promise<void> {
    const item = itemOf(scopedKey);
    if (!item) { return; }
    const pane = (view.win as any).ZoteroPane;
    try {
      switch (target) {
        case "full":
          this.deps.openFull(view.win, item);
          return;
        case "library":
          this.reveal(view, item.id);
          return;
        case "pdf": {
          const pdf = pdfAttachment(item);
          if (pdf) { await pane.viewAttachment(pdf.id); } else { this.reveal(view, item.id); }
          return;
        }
        case "raw": {
          const raw = rawAttachment(item);
          if (raw) { await pane.viewAttachment(raw.id); }
          return;
        }
        case "canvas": {
          const canvas = canvasAttachment(item) || (await ensureCanvasAttachment(item)).attachment;
          await pane.viewAttachment(canvas.id);
          return;
        }
      }
    } catch (error) {
      ztoolkit.log(`[home] opening ${target} failed`, error);
      view.ui.status.textContent = t("open-failed", "Could not open it: { $error }", {
        error: String((error as Error)?.message || error),
      });
    }
  }

  private passageElement(view: HomeView, excerpt: HomeExcerpt): HTMLElement {
    const doc = view.win.document;
    const element = create(doc, "div", `${CLASS}__passage`);
    const quote = create(doc, "span", `${CLASS}__quote`, `“${excerpt.text}”`);
    quote.title = t("open-pdf", "Open in the PDF");
    quote.setAttribute("role", "link");
    quote.addEventListener("click", (event) => {
      event.stopPropagation();
      void openExcerpt(view.libraryID, excerpt).catch((error) => ztoolkit.log("[home] open passage failed", error));
    });
    element.append(quote);
    if (excerpt.pageLabel) { element.append(create(doc, "span", `${CLASS}__page`, `p. ${excerpt.pageLabel}`)); }
    return element;
  }

  private icon(doc: Document, paper: HomePaper): HTMLElement {
    const icon = create(doc, "img", `${CLASS}__icon`);
    try {
      icon.setAttribute("src", Zotero.ItemTypes.getImageSrc((paper.type || "journalArticle") as any) as string);
    } catch {
      // An unknown type has no icon.
    }
    return icon;
  }

  private paperText(doc: Document, paper: HomePaper, className: string): HTMLElement {
    const text = create(doc, "div", className);
    const credit = rowCredit({ authors: paper.authors, year: paper.year } as any);
    if (credit) { text.append(create(doc, "span", `${CLASS}__credit`, `${credit} `)); }
    text.append(create(doc, "span", `${CLASS}__name`, paper.title || "Untitled"));
    text.title = [credit, paper.title, paper.venue].filter(Boolean).join(" · ");
    return text;
  }

  private reveal(view: HomeView, itemID: number): void {
    const win = view.win as any;
    win.Zotero_Tabs?.select?.("zotero-pane");
    win.ZoteroPane?.selectItem?.(itemID);
  }
}

const HOME_CSS = `
  .${BUTTON_CLASS} {
    list-style-image: url("chrome://${config.addonRef}/content/icons/reference.svg");
    -moz-context-properties: fill, fill-opacity;
    fill: currentColor;
  }
  .${CLASS} {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    padding: 10px 12px 12px;
    background: var(--material-background, Canvas);
    color: var(--fill-primary, CanvasText);
  }
  .${CLASS}__header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--material-border, rgb(128 128 128 / 30%));
  }
  .${CLASS}__title {
    font-size: 1.2em;
    font-weight: 600;
    margin-right: 8px;
  }
  .${CLASS}__select, .${CLASS}__search {
    padding: 3px 6px;
    border-radius: 4px;
    border: 1px solid var(--material-border, rgb(128 128 128 / 35%));
    background: var(--material-background, transparent);
    color: inherit;
  }
  .${CLASS}__search { flex: 1; min-width: 0; }
  .${CLASS}__check { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .${CLASS}__status { margin-left: auto; opacity: 0.7; }
  .${CLASS}__action {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid rgb(128 128 128 / 35%);
    background: rgb(128 128 128 / 10%);
    cursor: pointer;
    user-select: none;
  }
  .${CLASS}__action:hover { background: rgb(128 128 128 / 22%); }
  .${CLASS}__columns {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 12px;
  }
  .${CLASS}__column {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--material-border, rgb(128 128 128 / 30%));
    border-radius: 6px;
    padding: 8px 4px 4px;
  }
  .${CLASS}__heading { padding: 0 8px; font-weight: 600; }
  .${CLASS}__hint { padding: 0 8px 6px; font-size: 0.85em; opacity: 0.65; }
  .${CLASS}__toolbar { display: flex; align-items: center; gap: 6px; padding: 0 6px 6px; }
  .${CLASS}__list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
  .${CLASS}__empty { margin: 8px; opacity: 0.7; }
  .${CLASS}__more { display: block; margin: 8px 6px; text-align: center; }
  .${CLASS}__row {
    padding: 4px 6px 6px;
    border-radius: 4px;
    border-left: 3px solid transparent;
    cursor: default;
  }
  .${CLASS}__row + .${CLASS}__row { border-top: 1px solid var(--material-border, rgb(128 128 128 / 18%)); }
  .${CLASS}__head { display: flex; align-items: flex-start; gap: 6px; }
  .${CLASS}__head:hover { background: var(--fill-quinary, rgb(128 128 128 / 10%)); }
  .${CLASS}__partners { margin: 2px 0 0 20px; }
  .${CLASS}__partner-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.92em;
    cursor: pointer;
  }
  .${CLASS}__partner-line:hover { background: var(--fill-quinary, rgb(128 128 128 / 10%)); }
  .${CLASS}__partner.is-missing .${CLASS}__partner-text { opacity: 0.55; font-style: italic; }
  .${CLASS}__chevron { flex: none; width: 10px; opacity: 0.6; }
  .${CLASS}__partner-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .${CLASS}__partner.is-open .${CLASS}__partner-text { white-space: normal; }
  .${CLASS}__partner-meta { flex: none; opacity: 0.65; white-space: nowrap; }
  .${CLASS}__passages { padding: 2px 4px 4px 20px; }
  .${CLASS}__passage {
    display: flex;
    gap: 6px;
    align-items: baseline;
    margin: 3px 0;
    padding: 3px 6px;
    border-left: 2px solid var(--accent-yellow, #ffd400);
    background: var(--fill-quinary, rgb(128 128 128 / 8%));
  }
  .${CLASS}__quote { flex: 1; min-width: 0; font-style: italic; overflow-wrap: anywhere; cursor: pointer; }
  .${CLASS}__quote:hover { text-decoration: underline; }
  .${CLASS}__page { flex: none; font-size: 0.85em; opacity: 0.7; }
  .${CLASS}__row.is-selected { background: var(--fill-quarternary, rgb(128 128 128 / 22%)); }
  .${CLASS}__row.is-linked {
    border-left-color: var(--accent-blue, #4a8fe0);
    background: color-mix(in srgb, var(--accent-blue, #4a8fe0) 12%, transparent);
  }
  .${CLASS}__icon { flex: none; width: 14px; height: 14px; margin-top: 2px; }
  .${CLASS}__text {
    flex: 1;
    min-width: 0;
    line-height: 1.35;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
  }
  .${CLASS}__credit { font-weight: 600; }
  .${CLASS}__name { opacity: 0.85; }
  .${CLASS}__meta { flex: none; display: flex; gap: 4px; align-items: center; font-size: 0.85em; }
  .${CLASS}__badge {
    padding: 0 5px;
    border-radius: 8px;
    background: var(--fill-quarternary, rgb(128 128 128 / 20%));
    white-space: nowrap;
  }
  .${CLASS}__badge--quote { background: color-mix(in srgb, var(--accent-yellow, #ffd400) 35%, transparent); }
  .${CLASS}__time { opacity: 0.6; white-space: nowrap; }
  .${CLASS}__actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 3px 0 0 20px; }
  .${CLASS}__partner-actions { flex: none; display: none; gap: 3px; }
  .${CLASS}__partner-line:hover .${CLASS}__partner-actions { display: inline-flex; }
  .${CLASS}__open {
    padding: 0 6px;
    border-radius: 3px;
    border: 1px solid rgb(128 128 128 / 30%);
    font-size: 0.8em;
    line-height: 1.6;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    opacity: 0.8;
  }
  .${CLASS}__open:hover { opacity: 1; background: rgb(128 128 128 / 18%); }
  .${CLASS}__open[data-target="pdf"] { border-color: color-mix(in srgb, var(--accent-red, #db2c3a) 50%, transparent); }
  .${CLASS}__open[data-target="canvas"] { border-color: color-mix(in srgb, var(--accent-purple, #a28ae5) 60%, transparent); }
  .${CLASS}__partner-more {
    display: inline-block;
    margin: 2px 0 0 20px;
    font-size: 0.85em;
    opacity: 0.7;
    cursor: pointer;
  }
  .${CLASS}__partner-more:hover { opacity: 1; text-decoration: underline; }
`;
