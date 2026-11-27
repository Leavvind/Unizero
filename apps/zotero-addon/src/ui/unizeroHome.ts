/**
 * Uniconnection: the library-wide view of paper-to-paper relations, as a tab of the
 * main window opened from a button on the items toolbar
 * (docs/UNICONNECTION.md §4.1). Relations are the `unizero://paper/…` links
 * written in papers' Raw and Canvas (src/zotero/paperLinkSources.ts); the tab reads
 * those files when it opens or reloads.
 *
 * Overview, left, References: the papers being worked on, latest activity first (a
 * mention written in the paper's Raw or Canvas, an annotation made), each with the
 * papers it mentions. Right, Citations: each mentioned paper, with who mentions it.
 * A partner opens to its mentions: the paragraph's text, a PDF button for each
 * `zotero://open-pdf` link in that paragraph, and the Raw or Canvas holding it. A
 * Canvas opens in Obsidian at the card holding the mention (`obsidian://unizero`).
 * Selecting a paper highlights its partners in the other column; double-clicking it
 * opens its own page in this tab.
 *
 * Citations also lists the Obsidian Vault notes that mention a paper, from the
 * snapshot the plugin sends (src/zotero/vaultMentionStore.ts). A note shows only its
 * name, not its passages; clicking it opens the note in Obsidian through
 * `obsidian://unizero`, at its first mention.
 *
 * Paper page: References (what this paper's Raw and Canvas mention), Citations (whose
 * Raw and Canvas, and which Vault notes, mention it), and a folded Bibliography of the providers' References,
 * Citations and the library Relation list. Opening the fold reads only caches; the
 * providers are asked only when the user clicks Fetch.
 *
 * Everything else is read locally (Zotero, the files). The one write is the Canvas
 * button on a paper without one, which creates it, empty.
 *
 * Host traps:
 * - Zotero saves its open tabs and restores them at startup by type; a type it has
 *   no hook for stops the restore there. So each window's `Zotero_Tabs.getState` is
 *   wrapped to leave the tab out of the saved session (unwrapped on unload), and where
 *   the tab-hook table exists it registers hooks that drop a stray saved tab.
 * - Tab types are split on "-" by Zotero, so the type has none. The internal type
 *   stays `unizeroHome` (renaming it would orphan saved state; AGENTS.md "Stable state").
 * - Zotero 9+ can hold several library views per window, each with its own items
 *   toolbar; buttons are added to every toolbar found, again whenever a tab opens.
 */

import { config } from "../../package.json";
import type { LiteratureCandidate, LiteratureSnapshot } from "../modules/literatureRelations";
import { scopedKey as scopedKeyOf, type MentionGroup, type PaperMention } from "../modules/paperLinkIndex";
import { paperLinks, type PaperLinkRefresh } from "../zotero/paperLinkSources";
import { vaultNoteKey, type VaultMention, type VaultNoteGroup } from "../modules/vaultMentionIndex";
import { vaultMentions } from "../zotero/vaultMentionStore";
import { paperHighlights, sqlTime } from "../zotero/uniConnectionActivity";
import { openPdfAnchor } from "../zotero/pdfAnchors";
import { launchObsidianURL } from "../zotero/obsidianLaunch";
import { canvasAttachment, ensureCanvasAttachment } from "../zotero/canvasAdapter";
import { attachmentSummary, pdfAttachment, rawAttachment } from "../zotero/literatureCollectionAdapter";
import { libraryHit } from "../zotero/librarySearch";
import { getString } from "../utils/locale";
import { pdfAnchorPage } from "@unizero/links";
import {
  columnRows,
  homeColumns,
  obsidianCanvasURL,
  obsidianNoteURL,
  paperCredit,
  shortAuthors,
  type ActivityKind,
  type HomeColumn,
  type HomeMention,
  type HomeNote,
  type HomePair,
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
/** Bibliography rows shown per list before "Show all". */
const BIBLIOGRAPHY_PAGE = 50;

type OpenTarget = "pdf" | "raw" | "canvas" | "library";
type BibliographyKind = "references" | "citations" | "relation";

interface ColumnState extends HomeQuery {
  limit: number;
  ui: {
    heading: HTMLElement;
    list: HTMLElement;
    search: HTMLInputElement;
    sort: HTMLSelectElement;
  };
}

interface BibliographyList {
  snapshot?: LiteratureSnapshot;
  loading: boolean;
  message?: string;
  all: boolean;
}

/** One paper's page; kept while the user moves between related papers. */
interface PaperPage {
  scopedKey: string;
  /** The Bibliography fold is open. */
  open: boolean;
  /** Caches have been read for this paper. */
  read: boolean;
  lists: Record<BibliographyKind, BibliographyList>;
}

interface HomeView {
  win: Window;
  tabID: string;
  root: HTMLElement;
  libraryID: number;
  /** Empty: the whole library. */
  collectionKey: string;
  subcollections: boolean;
  /** Papers in scope (the status line's count). */
  paperCount: number;
  /** The last file read: how many notes could not be read. */
  refresh?: PaperLinkRefresh;
  data: Record<HomeColumn, HomeRow[]>;
  /** Drawn rows by `column|scopedKey`, reused while the row and its partner fold are unchanged. */
  drawn: Map<string, { row: HomeRow; all: boolean; element: HTMLElement }>;
  selected?: { column: HomeColumn; key: string };
  /** Partners the user folded; mentions show by default. By `column|row|partner`. */
  collapsed: Set<string>;
  /** Rows showing all their partners, by `column|row`. */
  expanded: Set<string>;
  columns: Record<HomeColumn, ColumnState>;
  /** The paper page on show, and the pages behind it (Back). */
  page?: PaperPage;
  history: PaperPage[];
  loading: boolean;
  error?: string;
  generation: number;
  /** Library data changed while the tab was in the background. */
  stale: boolean;
  ui: {
    library: HTMLSelectElement;
    collection: HTMLSelectElement;
    subcollections: HTMLInputElement;
    status: HTMLElement;
    columns: HTMLElement;
    page: HTMLElement;
  };
}

interface WindowHooks {
  getState?: (...args: unknown[]) => unknown;
  wrapped?: (...args: unknown[]) => unknown;
  hookActions: string[];
}

/** The providers' bibliography, through the add-on's data plane (modules/views.ts). */
export interface UnizeroHomeDeps {
  /** Saved References, Citations, or the library Relation list; never touches the network. */
  cachedBibliography(item: Zotero.Item, kind: BibliographyKind): Promise<LiteratureSnapshot | undefined>;
  /** Asks the providers; only on an explicit click. */
  fetchBibliography(item: Zotero.Item, kind: "references" | "citations", refresh: boolean): Promise<LiteratureSnapshot>;
  /** The next page of provider Citations. */
  loadMoreCitations(item: Zotero.Item): Promise<LiteratureSnapshot>;
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

/** The libraries Uniconnection offers: the user library and groups (not feeds). */
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

function summaryOf(key: string): HomePaper | undefined {
  const item = itemOf(key);
  return item?.isRegularItem() ? paperOf(item) : undefined;
}

function homeMention(mention: PaperMention): HomeMention {
  return {
    attachmentKey: mention.source.attachmentKey,
    purpose: mention.source.purpose,
    line: mention.line,
    ...(mention.nodeId !== undefined ? { nodeId: mention.nodeId } : {}),
    text: mention.text,
    pdf: mention.pdf,
    ...(mention.time !== undefined ? { time: mention.time } : {}),
  };
}

function vaultHomeMention(mention: VaultMention): HomeMention {
  return {
    purpose: "vault",
    note: mention.note,
    line: mention.line,
    ...(mention.nodeId !== undefined ? { nodeId: mention.nodeId } : {}),
    text: mention.text,
    pdf: mention.pdf,
    ...(mention.time !== undefined ? { time: mention.time } : {}),
  };
}

/** Vault notes' mentions as note → cited pairs; the note's key stands where a citing paper's would. */
function vaultPairs(mentions: VaultMention[]): HomePair[] {
  const pairs = new Map<string, HomePair>();
  for (const mention of mentions) {
    const citing = vaultNoteKey(mention.note), cited = scopedKeyOf(mention.cited);
    const key = `${citing}|${cited}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { citing, cited, missing: !summaryOf(cited), mentions: [], note: mention.note };
      pairs.set(key, pair);
    }
    pair.mentions.push(vaultHomeMention(mention));
  }
  return [...pairs.values()];
}

function syncedAgo(time: number): string {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) { return t("just-now", "just now"); }
  if (minutes < 60) { return t("minutes-ago", "{ $count } min ago", { count: minutes }); }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) { return t("hours-ago", "{ $count } h ago", { count: hours }); }
  return relativeTime(time);
}

/** The index's mentions as citing → cited pairs. */
function homePairs(mentions: PaperMention[]): HomePair[] {
  const pairs = new Map<string, HomePair>();
  for (const mention of mentions) {
    const citing = scopedKeyOf(mention.citing), cited = scopedKeyOf(mention.cited);
    const key = `${citing}|${cited}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { citing, cited, missing: !summaryOf(cited), mentions: [] };
      pairs.set(key, pair);
    }
    pair.mentions.push(homeMention(mention));
  }
  return [...pairs.values()];
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
    case "mention": return t("activity-mention", "Mentioned");
  }
}

function emptyPage(scopedKey: string): PaperPage {
  const list = (): BibliographyList => ({ loading: false, all: false });
  return { scopedKey, open: false, read: false, lists: { references: list(), citations: list(), relation: list() } };
}

export class UnizeroHome {
  private readonly views = new Map<Window, HomeView>();
  private readonly hooks = new Map<Window, WindowHooks>();
  private observerID?: string;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private unsubscribeVault?: () => void;

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

  /** Open Uniconnection in `win`, or switch to its tab. */
  public open(win: Window): void {
    const tabs = (win as any).Zotero_Tabs;
    if (!tabs?.add) { return; }
    const existing = this.views.get(win);
    if (existing) {
      tabs.select(existing.tabID);
      this.reshow(existing);
      return;
    }
    const { id, container } = tabs.add({
      type: TAB_TYPE,
      title: t("title", "Uniconnection"),
      data: {},
      select: true,
      onClose: () => this.forget(win),
    });
    const view = this.mount(win, id, container as HTMLElement);
    this.views.set(win, view);
    void this.load(view);
  }

  /** Open Uniconnection on `item`'s paper page (the item context menu). */
  public openPaper(win: Window, item: Zotero.Item): void {
    const paper = item.isRegularItem() ? item : item.parentItem;
    if (!paper || paper.deleted) { return; }
    this.open(win);
    const view = this.views.get(win);
    if (view) { this.showPaper(view, `${paper.libraryID}:${paper.key}`); }
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
    view.drawn.clear();
    this.views.delete(win);
  }

  /** Keep the tab out of the saved session; see the header. */
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
        // A saved tab (from an older build, or a crash) is skipped, not restored.
        restoreState: async () => ({}),
        // Reopening a closed tab opens a fresh one.
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
      button.setAttribute("tooltiptext", t("button", "Open Uniconnection"));
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

  /**
   * The tab is shown again: re-read it. Obsidian edits Raw and Canvas files without
   * telling Zotero, and unchanged files are skipped, so this is cheap. A load already
   * under way for the current state is not restarted.
   */
  private reshow(view: HomeView): void {
    if (view.loading && !view.stale) { return; }
    void this.load(view);
  }

  /** Reload visible tabs after a burst of changes; hidden ones reload when shown. */
  private scheduleReload(): void {
    if (!this.views.size) { return; }
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      for (const view of this.views.values()) {
        if (this.visible(view)) { void this.load(view); } else { view.stale = true; }
      }
    }, RELOAD_DELAY_MS);
  }

  /**
   * Library, collection and tag changes and a new Vault snapshot from Obsidian reload
   * a visible tab; tab events add toolbar buttons, and selecting the tab re-reads it.
   */
  private observe(): void {
    if (this.observerID) { return; }
    this.unsubscribeVault = vaultMentions.subscribe(() => this.scheduleReload());
    this.observerID = Zotero.Notifier.registerObserver({
      notify: async (event: string, type: string, ids: unknown[]) => {
        if (type === "tab") {
          for (const win of this.hooks.keys()) { this.addButtons(win); }
          if (event === "select") {
            for (const view of this.views.values()) {
              if (ids.includes(view.tabID)) { this.reshow(view); }
            }
          }
          return;
        }
        this.scheduleReload();
      },
    }, ["item", "item-tag", "collection", "collection-item", "tab"], `${config.addonRef}-home`);
  }

  private unobserve(): void {
    this.unsubscribeVault?.();
    this.unsubscribeVault = undefined;
    if (this.reloadTimer) { clearTimeout(this.reloadTimer); }
    this.reloadTimer = undefined;
    if (this.observerID) { Zotero.Notifier.unregisterObserver(this.observerID); }
    this.observerID = undefined;
  }

  private visible(view: HomeView): boolean {
    return (view.win as any).Zotero_Tabs?.selectedID === view.tabID;
  }

  private live(view: HomeView): boolean {
    return this.views.get(view.win) === view && view.root.isConnected;
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
    header.append(create(doc, "div", `${CLASS}__title`, t("title", "Uniconnection")));
    const library = create(doc, "select", `${CLASS}__select`);
    const collection = create(doc, "select", `${CLASS}__select`);
    const subLabel = create(doc, "label", `${CLASS}__check`);
    const subcollections = create(doc, "input");
    subcollections.type = "checkbox";
    subLabel.append(subcollections, doc.createTextNode(` ${t("subcollections", "Include subcollections")}`));
    const refresh = create(doc, "div", `${CLASS}__action`, "⟳");
    refresh.title = t("refresh", "Read the library, Raw and Canvas files again");
    refresh.setAttribute("role", "button");
    const status = create(doc, "div", `${CLASS}__status`);
    header.append(library, collection, subLabel, refresh, status);

    const columnsElement = create(doc, "div", `${CLASS}__columns`);
    const page = create(doc, "div", `${CLASS}__page`);
    page.hidden = true;
    root.append(header, columnsElement, page);
    container.append(root);

    const view: HomeView = {
      win, tabID, root, libraryID, collectionKey, subcollections: false,
      paperCount: 0, data: { references: [], citations: [] }, drawn: new Map(),
      collapsed: new Set(), expanded: new Set(),
      columns: {} as Record<HomeColumn, ColumnState>,
      history: [],
      loading: false, generation: 0, stale: false,
      ui: { library, collection, subcollections, status, columns: columnsElement, page },
    };
    for (const column of ["references", "citations"] as const) {
      view.columns[column] = this.column(view, column, columnsElement);
    }

    library.addEventListener("change", () => {
      view.libraryID = Number(library.value);
      view.collectionKey = "";
      view.selected = undefined;
      this.showOverview(view);
      void this.load(view);
    });
    collection.addEventListener("change", () => {
      view.collectionKey = collection.value;
      this.showOverview(view);
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
      ? t("references-hint", "Papers by latest activity — mentions written in their Raw or Canvas, annotations — and what each mentions")
      : t("citations-hint", "Papers mentioned in other papers' Raw or Canvas, and who mentions them"));
    const toolbar = create(doc, "div", `${CLASS}__toolbar`);
    const search = create(doc, "input", `${CLASS}__search`);
    search.type = "search";
    search.placeholder = t("search", "Search titles, authors, years and mentions");
    const sort = create(doc, "select", `${CLASS}__select`);
    sort.append(
      option(doc, "default", column === "references"
        ? t("sort-recent-activity", "Recent activity")
        : t("sort-recent-cited", "Recently mentioned")),
      option(doc, "count", column === "references"
        ? t("sort-most-quoting", "Mentions most papers")
        : t("sort-most-cited", "Mentioned by most papers")),
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
      if (rebuild) { paperLinks.clear(); }
      // Every library's Raw and Canvas: a mention may cross libraries.
      const [refresh] = await Promise.all([paperLinks.refresh(), vaultMentions.ready()]);
      const collectionKey = view.collectionKey;
      const items = await this.scopeItems(view);
      // A deleted collection falls back to the whole library; show that in the picker.
      if (view.collectionKey !== collectionKey && generation === view.generation) { this.drawScope(view); }
      const highlights = await paperHighlights(view.libraryID);
      if (generation !== view.generation) { return; }
      const scope = new Map(items.map((item) => [`${item.libraryID}:${item.key}`, item]));
      view.paperCount = scope.size;
      view.refresh = refresh;
      view.data = homeColumns({ keys: scope.keys(), paper: (key) => paperOf(scope.get(key)!) },
        [...homePairs(paperLinks.index.mentions()), ...vaultPairs(vaultMentions.index.mentions())],
        { highlights }, summaryOf);
    } catch (error) {
      if (generation !== view.generation) { return; }
      view.error = String((error as Error)?.message || error);
      ztoolkit.log("[uniconnection] load failed", error);
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
    const status = view.ui.status;
    status.title = "";
    if (view.loading) {
      status.textContent = t("loading", "Reading Raw and Canvas files…");
      return;
    }
    if (view.error) {
      status.textContent = view.error;
      return;
    }
    const parts = [t("papers", "{ $count } papers", { count: view.paperCount })];
    const failed = paperLinks.index.failures();
    if (failed.length) {
      parts.push(t("unreadable", "{ $count } notes unreadable", { count: failed.length }));
      status.title = failed.slice(0, 10).map((each) => `${each.source.title}: ${each.error}`).join("\n");
    }
    if (view.refresh?.unavailable) {
      parts.push(t("unavailable", "{ $count } notes not on this computer", { count: view.refresh.unavailable }));
    }
    for (const snapshot of vaultMentions.index.snapshots()) {
      parts.push(t("vault-synced", "Vault { $vault } synced { $time }", {
        vault: snapshot.vaultName, time: syncedAgo(snapshot.receivedAt),
      }));
    }
    status.textContent = parts.join(" · ");
  }

  private draw(view: HomeView): void {
    if (!view.root.isConnected) { return; }
    this.drawStatus(view);
    for (const column of ["references", "citations"] as const) { this.drawColumn(view, view.columns[column]); }
    if (view.page) { this.drawPage(view); }
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
        ? t("loading", "Reading Raw and Canvas files…")
        : state.column === "references"
          ? t("references-empty", "Nothing has happened to the papers here yet: no annotations, and no paper mentioned in their Raw or Canvas.")
          : t("citations-empty", "No paper here is mentioned in another paper's Raw or Canvas yet.")));
      return;
    }
    // Rows from an earlier load are not coming back.
    const current = new Set(view.data[state.column]);
    for (const [key, drawn] of view.drawn) {
      if (key.startsWith(`${state.column}|`) && !current.has(drawn.row)) { view.drawn.delete(key); }
    }
    const linked = this.linked(view, state.column);
    for (const row of rows.slice(0, state.limit)) { list.append(this.drawnRow(view, state, row, linked)); }
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

  /**
   * The row's element, reused from the last draw while the row object (replaced on
   * every load) and its partner fold are unchanged: searching and sorting then
   * re-append nodes instead of rebuilding them and re-reading every paper's
   * attachments. Selection is marked afresh; partner folds are kept in place.
   */
  private drawnRow(view: HomeView, state: ColumnState, row: HomeRow, linked: Set<string>): HTMLElement {
    const key = `${state.column}|${row.scopedKey}`;
    const all = view.expanded.has(key);
    const known = view.drawn.get(key);
    if (known && known.row === row && known.all === all) {
      this.markRow(view, state.column, known.element, row.scopedKey, linked);
      return known.element;
    }
    const element = this.rowElement(view, state, row, linked);
    view.drawn.set(key, { row, all, element });
    return element;
  }

  private markRow(view: HomeView, column: HomeColumn, element: HTMLElement, key: string, linked: Set<string>): void {
    const selected = view.selected?.column === column && view.selected.key === key;
    element.classList.toggle("is-selected", selected);
    element.setAttribute("aria-selected", String(selected));
    element.classList.toggle("is-linked", linked.has(key));
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
    this.markRow(view, state.column, element, row.scopedKey, linked);

    const head = create(doc, "div", `${CLASS}__head`);
    head.title = t("row-hint", "Click to select, double-click to open this paper's page");
    head.append(this.icon(doc, row.paper), this.paperText(doc, row.paper, `${CLASS}__text`));
    const meta = create(doc, "div", `${CLASS}__meta`);
    if (references && row.highlights) {
      const highlights = create(doc, "span", `${CLASS}__badge`, `🖍 ${row.highlights}`);
      highlights.title = t("highlights", "{ $count } annotations", { count: row.highlights });
      meta.append(highlights);
    }
    const papers = row.partners.filter((each) => !each.note).length;
    const notes = row.partners.length - papers;
    if (papers) {
      const badge = create(doc, "span", `${CLASS}__badge`, `${references ? "→" : "←"} ${papers}`);
      badge.title = references
        ? t("quoting", "Mentions { $count } papers", { count: papers })
        : t("quoted-by", "Mentioned by { $count } papers", { count: papers });
      meta.append(badge);
    }
    if (notes) {
      const badge = create(doc, "span", `${CLASS}__badge ${CLASS}__badge--note`, `✎ ${notes}`);
      badge.title = t("noted-by", "Mentioned in { $count } Vault notes", { count: notes });
      meta.append(badge);
    }
    if (row.mentions) {
      const mentions = create(doc, "span", `${CLASS}__badge ${CLASS}__badge--quote`, `❝ ${row.mentions}`);
      mentions.title = t("mentions", "{ $count } mentions", { count: row.mentions });
      meta.append(mentions);
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
    head.addEventListener("dblclick", () => { this.showPaper(view, row.scopedKey); });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target === element) { this.showPaper(view, row.scopedKey); }
    });
    return element;
  }

  /** One paper the row mentions (References) or that mentions it (Citations); opens to the mentions. */
  private partnerElement(view: HomeView, state: ColumnState, row: HomeRow, partner: HomePartner): HTMLElement {
    if (partner.note) { return this.noteElement(view, partner.note, partner.mentions); }
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
      line.append(create(doc, "span", `${CLASS}__partner-text`, t("missing", "Not in the library")));
    }
    const meta = create(doc, "span", `${CLASS}__partner-meta`, `❝ ${partner.mentions.length}`);
    if (partner.time) { meta.textContent += ` · ${relativeTime(partner.time)}`; }
    line.append(meta);
    if (partner.paper) {
      line.append(this.actions(view, partner.scopedKey, `${CLASS}__partner-actions`));
    }
    line.title = t("partner-hint", "Click to fold, double-click to open this paper's page");
    // A References row's mentions sit in the row's own notes; a Citations row's in the partner's.
    const citing = state.column === "references" ? row.scopedKey : partner.scopedKey;
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
      if (opening) { element.append(this.mentionsElement(view, citing, partner.mentions)); }
    });
    line.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (partner.paper) { this.showPaper(view, partner.scopedKey); }
    });
    element.append(line);

    if (open) { element.append(this.mentionsElement(view, citing, partner.mentions)); }
    return element;
  }

  private mentionsElement(view: HomeView, citing: string, mentions: HomeMention[]): HTMLElement {
    const list = create(view.win.document, "div", `${CLASS}__passages`);
    for (const mention of mentions) { list.append(this.mentionElement(view, citing, mention)); }
    return list;
  }

  /** One evidence unit: its text, its PDF anchors, and the Raw or Canvas it is in. */
  private mentionElement(view: HomeView, citing: string, mention: HomeMention): HTMLElement {
    const doc = view.win.document;
    const element = create(doc, "div", `${CLASS}__passage`);
    element.append(create(doc, "span", `${CLASS}__quote`, mention.text || "…"));
    const buttons = create(doc, "span", `${CLASS}__passage-actions`);
    mention.pdf.forEach((url, index) => {
      const page = pdfAnchorPage(url);
      const label = page ? `PDF p. ${page}` : mention.pdf.length > 1 ? `PDF ${index + 1}` : "PDF";
      buttons.append(this.button(doc, label, t("open-anchor-hint", "Open the PDF at this passage"), () => {
        void openPdfAnchor(url).then((opened) => {
          if (!opened) { this.notice(view, t("anchor-missing", "That PDF or annotation is not in the library.")); }
        }).catch((error) => this.failed(view, "pdf", error));
      }, "pdf"));
    });
    // Vault notes are drawn by noteElement, without their passages.
    if (mention.purpose === "vault") { return element; }
    const { attachmentKey } = mention;
    if (mention.purpose === "canvas") {
      buttons.append(this.button(doc, "Canvas", t("open-mention-canvas-hint", "Open the Canvas in Obsidian at the card holding this mention"),
        () => { this.openCanvas(view, citing, attachmentKey, mention.nodeId); }, "canvas"));
    } else {
      buttons.append(this.button(doc, "Raw", t("open-mention-raw-hint", "Open the Raw holding this mention (line { $line })", { line: mention.line + 1 }),
        () => { void this.openSource(view, citing, attachmentKey); }, "raw"));
    }
    element.append(buttons);
    return element;
  }

  private button(doc: Document, label: string, title: string, run: () => void, target?: string): HTMLElement {
    const element = create(doc, "span", `${CLASS}__open`, label);
    element.setAttribute("role", "button");
    element.title = title;
    if (target) { element.dataset.target = target; }
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      run();
    });
    element.addEventListener("dblclick", (event) => event.stopPropagation());
    return element;
  }

  /** Re-mark the selected row and its partners in the other column without redrawing. */
  private applySelection(view: HomeView): void {
    for (const column of ["references", "citations"] as const) {
      const linked = this.linked(view, column);
      for (const row of Array.from(view.columns[column].ui.list.querySelectorAll(`.${CLASS}__row`)) as HTMLElement[]) {
        this.markRow(view, column, row, row.dataset.key || "", linked);
      }
    }
  }

  /** Buttons opening what the paper has: PDF, Raw, Canvas (made on demand), library. */
  private actions(view: HomeView, scopedKey: string, className: string): HTMLElement {
    const doc = view.win.document;
    const bar = create(doc, "span", className);
    const item = itemOf(scopedKey);
    if (!item) { return bar; }
    let files = { hasPDF: false, hasRaw: false, hasCanvas: false };
    try {
      files = attachmentSummary(item);
    } catch (error) {
      ztoolkit.log("[uniconnection] reading attachments failed", error);
    }
    const button = (target: OpenTarget, label: string, title: string) => {
      bar.append(this.button(doc, label, title, () => { void this.openTarget(view, scopedKey, target); }, target));
    };
    if (files.hasPDF) { button("pdf", "PDF", t("open-pdf-hint", "Open the PDF")); }
    if (files.hasRaw) { button("raw", "Raw", t("open-raw-hint", "Open the Raw Markdown")); }
    button("canvas", files.hasCanvas ? "Canvas" : "+ Canvas", files.hasCanvas
      ? t("open-canvas-hint", "Open the Canvas")
      : t("create-canvas-hint", "Create an empty Canvas for this paper and open it"));
    button("library", "⌖", t("reveal-hint", "Show in the library"));
    return bar;
  }

  private async openTarget(view: HomeView, scopedKey: string, target: OpenTarget): Promise<void> {
    const item = itemOf(scopedKey);
    if (!item) { return; }
    const pane = (view.win as any).ZoteroPane;
    try {
      switch (target) {
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
      this.failed(view, target, error);
    }
  }

  /** The Raw or Canvas attachment of `citing` that holds a mention. */
  private async openSource(view: HomeView, citing: string, attachmentKey: string): Promise<void> {
    const libraryID = Number(citing.slice(0, citing.indexOf(":")));
    const attachment = Zotero.Items.getByLibraryAndKey(libraryID, attachmentKey) as Zotero.Item | false;
    if (!attachment || attachment.deleted) {
      this.notice(view, t("source-missing", "That note is no longer in the library."));
      return;
    }
    try {
      await (view.win as any).ZoteroPane.viewAttachment(attachment.id);
    } catch (error) {
      this.failed(view, "note", error);
    }
  }

  /** A Vault note in Obsidian, at the mention when one is given. */
  private openNote(view: HomeView, note: HomeNote, line?: number, nodeId?: string): void {
    try {
      launchObsidianURL(obsidianNoteURL(note, line, nodeId));
    } catch (error) {
      this.failed(view, "obsidian", error);
    }
  }

  /**
   * A paper's Zotero Canvas in Obsidian, at the card holding a mention. Obsidian, not
   * Zotero's file handler, so the card can be selected; the plugin finds the file
   * through the bridge. The Vault to open it in is the one that reported last.
   */
  private openCanvas(view: HomeView, citing: string, attachmentKey: string, nodeId?: string): void {
    const separator = citing.indexOf(":");
    const vault = vaultMentions.index.snapshots().reduce<{ vaultName: string; receivedAt: number } | undefined>(
      (best, snapshot) => !best || snapshot.receivedAt > best.receivedAt ? snapshot : best, undefined);
    try {
      launchObsidianURL(obsidianCanvasURL({
        libraryID: Number(citing.slice(0, separator)), itemKey: citing.slice(separator + 1), attachmentKey,
      }, nodeId, vault?.vaultName));
    } catch (error) {
      this.failed(view, "canvas", error);
    }
  }

  /**
   * A Vault note that mentions a paper: its name and how many mentions, without their
   * passages. Clicking it opens the note in Obsidian at its first mention.
   */
  private noteElement(view: HomeView, note: HomeNote, mentions: HomeMention[]): HTMLElement {
    const doc = view.win.document;
    const element = create(doc, "div", `${CLASS}__partner ${CLASS}__vault-note`);
    const line = create(doc, "div", `${CLASS}__partner-line`);
    const meta = create(doc, "span", `${CLASS}__partner-meta`, `❝ ${mentions.length}`);
    const time = Math.max(0, ...mentions.map((mention) => mention.time || 0));
    if (time) { meta.textContent += ` · ${relativeTime(time)}`; }
    line.append(this.noteText(doc, note, `${CLASS}__partner-text`), meta);
    line.setAttribute("role", "button");
    line.title = `${t("open-note-hint", "Open { $note } in Obsidian", { note: note.title })}\n${note.vaultName}: ${note.path}`;
    const first = mentions[0];
    line.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openNote(view, note, first?.line, first?.nodeId);
    });
    line.addEventListener("dblclick", (event) => event.stopPropagation());
    element.append(line);
    return element;
  }

  private failed(view: HomeView, what: string, error: unknown): void {
    ztoolkit.log(`[uniconnection] opening ${what} failed`, error);
    this.notice(view, t("open-failed", "Could not open it: { $error }", {
      error: String((error as Error)?.message || error),
    }));
  }

  private notice(view: HomeView, text: string): void {
    view.ui.status.textContent = text;
  }

  // ------------------------------------------------------------------ paper page

  private showPaper(view: HomeView, scopedKey: string): void {
    if (!itemOf(scopedKey)?.isRegularItem()) { return; }
    if (view.page?.scopedKey === scopedKey) { return; }
    if (view.page) { view.history.push(view.page); }
    view.page = emptyPage(scopedKey);
    this.drawPage(view);
    view.ui.page.scrollTop = 0;
  }

  private back(view: HomeView): void {
    view.page = view.history.pop();
    if (view.page) { this.drawPage(view); } else { this.showOverview(view); }
  }

  private showOverview(view: HomeView): void {
    view.page = undefined;
    view.history = [];
    view.ui.page.hidden = true;
    view.ui.page.replaceChildren();
    view.ui.columns.hidden = false;
  }

  private drawPage(view: HomeView): void {
    const page = view.page;
    if (!page || !view.root.isConnected) { return; }
    const doc = view.win.document;
    const item = itemOf(page.scopedKey);
    if (!item?.isRegularItem()) {
      // Deleted while on show.
      this.back(view);
      return;
    }
    const paper = paperOf(item);
    const scrollTop = view.ui.page.scrollTop;
    view.ui.columns.hidden = true;
    view.ui.page.hidden = false;

    const header = create(doc, "div", `${CLASS}__page-header`);
    const back = create(doc, "div", `${CLASS}__action`, view.history.length
      ? t("back", "← Back")
      : t("back-overview", "← Uniconnection"));
    back.setAttribute("role", "button");
    back.addEventListener("click", () => this.back(view));
    const title = create(doc, "div", `${CLASS}__page-title`);
    title.append(this.icon(doc, paper), this.paperText(doc, paper, `${CLASS}__page-text`));
    header.append(back, title, this.actions(view, page.scopedKey, `${CLASS}__actions ${CLASS}__page-actions`));

    const reference = { libraryID: item.libraryID, itemKey: item.key };
    const sections = [
      this.relationSection(view, "references", paperLinks.index.references(reference), page.scopedKey),
      this.relationSection(view, "citations", paperLinks.index.citations(reference), page.scopedKey,
        vaultMentions.index.citations(reference)),
    ];
    view.ui.page.replaceChildren(header, ...sections, this.bibliographyElement(view, page, item));
    view.ui.page.scrollTop = scrollTop;
  }

  /** References: what this paper's notes mention. Citations: whose notes mention it. */
  /** References: what this paper's notes mention. Citations: whose notes, and which Vault notes, mention it. */
  private relationSection(
    view: HomeView,
    kind: "references" | "citations",
    groups: MentionGroup[],
    own: string,
    notes: VaultNoteGroup[] = [],
  ): HTMLElement {
    const doc = view.win.document;
    const section = create(doc, "div", `${CLASS}__section`);
    const label = kind === "references" ? t("column-references", "References") : t("column-citations", "Citations");
    section.append(
      create(doc, "div", `${CLASS}__heading`, `${label} · ${groups.length + notes.length}`),
      create(doc, "div", `${CLASS}__hint`, kind === "references"
        ? t("page-references-hint", "Papers mentioned in this paper's Raw or Canvas")
        : t("page-citations-hint", "Papers whose Raw or Canvas mentions this one, and Vault notes that do")),
    );
    if (!groups.length && !notes.length) {
      section.append(create(doc, "div", `${CLASS}__empty`, view.loading
        ? t("loading", "Reading Raw and Canvas files…")
        : kind === "references"
          ? t("page-references-empty", "This paper's Raw and Canvas mention no other paper yet. Type @ in them in Obsidian to link one.")
          : t("page-citations-empty", "No other paper's Raw or Canvas mentions this one yet.")));
      return section;
    }
    for (const group of groups) {
      const key = scopedKeyOf(group.paper);
      const other = summaryOf(key);
      const element = create(doc, "div", `${CLASS}__partner is-open`);
      element.classList.toggle("is-missing", !other);
      const line = create(doc, "div", `${CLASS}__partner-line`);
      line.append(other
        ? this.paperText(doc, other, `${CLASS}__partner-text`)
        : create(doc, "span", `${CLASS}__partner-text`, `${t("missing", "Not in the library")} (${key})`));
      line.append(create(doc, "span", `${CLASS}__partner-meta`, `❝ ${group.mentions.length}`));
      if (other) {
        line.append(this.actions(view, key, `${CLASS}__partner-actions`));
        line.title = t("page-partner-hint", "Double-click to open this paper's page");
        line.addEventListener("dblclick", () => this.showPaper(view, key));
      }
      const citing = kind === "references" ? own : key;
      element.append(line, this.mentionsElement(view, citing, group.mentions.map(homeMention)));
      section.append(element);
    }
    if (notes.length) {
      section.append(create(doc, "div", `${CLASS}__subheading`, t("page-notes", "Vault notes · { $count }", { count: notes.length })));
    }
    for (const group of notes) {
      section.append(this.noteElement(view, group.note, group.mentions.map(vaultHomeMention)));
    }
    return section;
  }

  /** A Vault note's title, with its Vault and folder for telling notes of one name apart. */
  private noteText(doc: Document, note: HomeNote, className: string): HTMLElement {
    const element = create(doc, "span", className);
    element.append(create(doc, "span", `${CLASS}__note-icon`, note.format === "canvas" ? "▦" : "✎"));
    element.append(create(doc, "strong", undefined, note.title));
    const folder = note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "";
    element.append(create(doc, "span", `${CLASS}__note-path`, ` · ${note.vaultName}${folder ? ` / ${folder}` : ""}`));
    return element;
  }

  // ------------------------------------------------------------------ bibliography

  private bibliographyElement(view: HomeView, page: PaperPage, item: Zotero.Item): HTMLElement {
    const doc = view.win.document;
    const details = create(doc, "details", `${CLASS}__bibliography`);
    details.open = page.open;
    const summary = create(doc, "summary", `${CLASS}__heading`, t("bibliography", "Bibliography (providers)"));
    summary.title = t("bibliography-hint", "The providers' References and Citations, and related papers in the library. Opening reads only what is saved; nothing is fetched until you click Fetch.");
    details.append(summary);
    details.addEventListener("toggle", () => {
      if (page.open === details.open) { return; }
      page.open = details.open;
      if (page.open && !page.read) { void this.readBibliography(view, page, item); }
    });
    if (!page.open) { return details; }
    for (const kind of ["references", "citations", "relation"] as const) {
      details.append(this.bibliographyList(view, page, item, kind));
    }
    return details;
  }

  /** Saved lists only: opening the fold never reaches a provider. */
  private async readBibliography(view: HomeView, page: PaperPage, item: Zotero.Item): Promise<void> {
    page.read = true;
    for (const kind of ["references", "citations", "relation"] as const) { page.lists[kind].loading = true; }
    this.redrawPage(view, page);
    await Promise.all((["references", "citations", "relation"] as const).map(async (kind) => {
      const list = page.lists[kind];
      try {
        list.snapshot = await this.deps.cachedBibliography(item, kind);
      } catch (error) {
        list.message = String((error as Error)?.message || error);
      } finally {
        list.loading = false;
      }
    }));
    this.redrawPage(view, page);
  }

  private async fetchBibliography(
    view: HomeView,
    page: PaperPage,
    item: Zotero.Item,
    kind: "references" | "citations",
    action: "fetch" | "refresh" | "more",
  ): Promise<void> {
    const list = page.lists[kind];
    if (list.loading) { return; }
    list.loading = true;
    list.message = undefined;
    this.redrawPage(view, page);
    try {
      list.snapshot = action === "more"
        ? await this.deps.loadMoreCitations(item)
        : await this.deps.fetchBibliography(item, kind, action === "refresh");
    } catch (error) {
      list.message = String((error as Error)?.message || error);
    } finally {
      list.loading = false;
      this.redrawPage(view, page);
    }
  }

  /** Redraw only while `page` is still the one on show in a live tab. */
  private redrawPage(view: HomeView, page: PaperPage): void {
    if (this.live(view) && view.page === page) { this.drawPage(view); }
  }

  private bibliographyList(view: HomeView, page: PaperPage, item: Zotero.Item, kind: BibliographyKind): HTMLElement {
    const doc = view.win.document;
    const list = page.lists[kind];
    const element = create(doc, "div", `${CLASS}__bib-list`);
    const head = create(doc, "div", `${CLASS}__bib-head`);
    const label = kind === "references"
      ? t("bib-references", "References")
      : kind === "citations" ? t("bib-citations", "Cited by") : t("bib-relation", "Related in your library");
    const items = list.snapshot?.items || [];
    const count = list.snapshot ? ` · ${kind === "citations" ? list.snapshot.total || items.length : items.length}` : "";
    head.append(create(doc, "span", `${CLASS}__bib-title`, `${label}${count}`));
    if (kind !== "relation") {
      const fetch = list.snapshot ? "refresh" : "fetch";
      head.append(this.button(doc, list.loading
        ? t("bib-loading", "Loading…")
        : fetch === "refresh" ? t("bib-refetch", "Fetch again") : t("bib-fetch", "Fetch from providers"),
      t("bib-fetch-hint", "Ask the providers for this list"),
      () => { void this.fetchBibliography(view, page, item, kind, fetch); }));
      if (kind === "citations" && list.snapshot?.hasMore && !list.loading) {
        head.append(this.button(doc, t("bib-more", "Load more"), t("bib-more-hint", "Fetch the next page"),
          () => { void this.fetchBibliography(view, page, item, kind, "more"); }));
      }
    }
    element.append(head);
    if (list.message) { element.append(create(doc, "div", `${CLASS}__empty`, list.message)); }
    if (!list.snapshot) {
      if (!list.loading && page.read && !list.message) {
        element.append(create(doc, "div", `${CLASS}__empty`, kind === "relation"
          ? t("bib-relation-empty", "No library paper shares References with this one yet.")
          : t("bib-nothing-saved", "Nothing saved for this paper yet.")));
      }
      return element;
    }
    if (!items.length) {
      element.append(create(doc, "div", `${CLASS}__empty`, t("bib-empty", "The list is empty.")));
      return element;
    }
    const shown = list.all ? items : items.slice(0, BIBLIOGRAPHY_PAGE);
    for (const candidate of shown) { element.append(this.candidateElement(view, candidate)); }
    if (items.length > shown.length) {
      const more = create(doc, "div", `${CLASS}__partner-more`,
        t("bib-show-all", "Show all { $count }", { count: items.length }));
      more.setAttribute("role", "button");
      more.addEventListener("click", () => {
        list.all = true;
        this.redrawPage(view, page);
      });
      element.append(more);
    }
    return element;
  }

  private candidateElement(view: HomeView, candidate: LiteratureCandidate): HTMLElement {
    const doc = view.win.document;
    const element = create(doc, "div", `${CLASS}__bib-row`);
    const libraryItem = candidate.membership.inLibrary && candidate.membership.itemID
      ? Zotero.Items.get(candidate.membership.itemID) as Zotero.Item | false
      : false;
    const authors = shortAuthors(candidate.authors || []);
    const credit = authors && candidate.year ? `${authors} (${candidate.year})` : authors || candidate.year || "";
    if (credit) { element.append(create(doc, "span", `${CLASS}__credit`, `${credit} `)); }
    element.append(create(doc, "span", `${CLASS}__name`, candidate.title || candidate.text || "Untitled"));
    if (candidate.primaryVenue) { element.title = candidate.primaryVenue; }
    if (libraryItem && !libraryItem.deleted && libraryItem.isRegularItem()) {
      element.classList.add("is-in-library");
      element.title = t("bib-in-library", "In your library — double-click to open its page");
      const key = `${libraryItem.libraryID}:${libraryItem.key}`;
      element.addEventListener("dblclick", () => this.showPaper(view, key));
    }
    return element;
  }

  // ------------------------------------------------------------------ shared

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
    const credit = paperCredit(paper);
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
  .${CLASS}__columns[hidden], .${CLASS}__page[hidden] { display: none; }
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
  .${CLASS}__quote { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .${CLASS}__passage-actions { flex: none; display: inline-flex; gap: 3px; }
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
  .${CLASS}__open[data-target="obsidian"] { border-color: color-mix(in srgb, var(--accent-purple, #a28ae5) 35%, transparent); }
  .${CLASS}__note-icon { margin-inline-end: 4px; opacity: .7; }
  .${CLASS}__vault-note .${CLASS}__partner-line { cursor: pointer; }
  .${CLASS}__note-path { opacity: .6; font-weight: normal; }
  .${CLASS}__subheading { margin: 10px 0 4px; font-weight: 600; opacity: .8; }
  .${CLASS}__open[data-target="canvas"] { border-color: color-mix(in srgb, var(--accent-purple, #a28ae5) 60%, transparent); }
  .${CLASS}__partner-more {
    display: inline-block;
    margin: 2px 0 0 20px;
    font-size: 0.85em;
    opacity: 0.7;
    cursor: pointer;
  }
  .${CLASS}__partner-more:hover { opacity: 1; text-decoration: underline; }
  .${CLASS}__page {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .${CLASS}__page-header { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
  .${CLASS}__page-title { flex: 1; min-width: 0; display: flex; gap: 6px; align-items: flex-start; font-size: 1.1em; }
  .${CLASS}__page-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .${CLASS}__page-actions { margin: 0; }
  .${CLASS}__section, .${CLASS}__bibliography {
    border: 1px solid var(--material-border, rgb(128 128 128 / 30%));
    border-radius: 6px;
    padding: 8px 6px 6px;
  }
  .${CLASS}__section .${CLASS}__partner { margin: 4px 0 6px; }
  .${CLASS}__bibliography > summary { cursor: pointer; }
  .${CLASS}__bib-list { margin: 8px 4px 4px; }
  .${CLASS}__bib-head { display: flex; align-items: center; gap: 6px; padding: 0 4px 4px; }
  .${CLASS}__bib-title { flex: 1; font-weight: 600; }
  .${CLASS}__bib-row { padding: 2px 8px; border-radius: 3px; line-height: 1.35; overflow-wrap: anywhere; }
  .${CLASS}__bib-row + .${CLASS}__bib-row { border-top: 1px solid var(--material-border, rgb(128 128 128 / 14%)); }
  .${CLASS}__bib-row.is-in-library { border-left: 3px solid var(--accent-green, #39b54a); cursor: pointer; }
  .${CLASS}__bib-row.is-in-library:hover { background: var(--fill-quinary, rgb(128 128 128 / 10%)); }
`;
