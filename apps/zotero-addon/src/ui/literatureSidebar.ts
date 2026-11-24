/**
 * The item-pane References / Citations section.
 *
 * A References row can be expanded to show the passages of this paper quoted about
 * it — the citation excerpts kept in the paper's own excerpt note
 * (docs/UNICONNECTION.md §4). A highlight dragged from the reader's annotation
 * sidebar, or text dragged straight out of the PDF, onto a References row attaches
 * that passage to the row's paper. Quoted rows come first; the rest of the list is
 * capped until the user asks for all of it, since the search box finds any row.
 *
 * References come from the Views snapshot producers (provider cache, fetched on
 * demand). Citations never reach a provider: they are the library papers that quote
 * this one or whose cached References contain it (UniConnection). This module owns
 * no data; it draws, and hands every write to src/zotero.
 *
 * Host traps: the item pane is an
 * XHTML document, so every element is created in the XHTML namespace and no
 * `<button>` is used (it does not render there); Zotero calls onRender repeatedly,
 * so an existing section for the same item is kept rather than rebuilt; and every
 * listener lives on the section's own nodes, so removing the section cleans up.
 */

import type { LibraryMembership, LiteratureCandidate, LiteratureSnapshot } from "../modules/literatureRelations";
import { uniConnection, type ExcerptGroup } from "../modules/uniConnection";
import type { ExcerptRecord } from "../zotero/excerptNoteFormat";
import { addExcerpt, assertWritable, ExcerptError, removeExcerpt } from "../zotero/excerptNotes";
import {
  ANNOTATION_DRAG_TYPE,
  annotationsFromDrop,
  openExcerpt,
  parseAnnotationDrop,
} from "../zotero/excerptAnnotations";
import { libraryHit, searchLibrary, type LibraryHit } from "../zotero/librarySearch";
import { getString } from "../utils/locale";
import {
  citationRows,
  filterRows,
  libraryRows,
  referenceRows,
  rowCredit,
  scopedKeyOf,
  searchTokens,
  type PaperSummary,
  type SidebarRow,
} from "./literatureSidebarModel";

export type SidebarTab = "references" | "citations";

/** What the section needs from Views; kept narrow so Views stays the data owner. */
export interface LiteratureSidebarPort {
  /** Saved References snapshot only; never touches the network. */
  cachedReferences(item: Zotero.Item): Promise<LiteratureSnapshot | undefined>;
  /** Fetches References on a miss, or always when `refresh`. */
  fetchReferences(item: Zotero.Item, refresh: boolean): Promise<LiteratureSnapshot>;
  /** Whether a References lookup is possible for this paper at all. */
  canFetchReferences(item: Zotero.Item): boolean;
  /** Finish resolving title-less cached References in the background; true when any changed. */
  resolvePendingReferences(item: Zotero.Item): Promise<boolean>;
  addToLibrary(item: Zotero.Item, candidate: LiteratureCandidate): Promise<LibraryMembership>;
  openExplorer(win: Window, item: Zotero.Item, kind: SidebarTab): void;
  /** The hover card for a provider row, when the user has it enabled. */
  attachTip(element: HTMLElement, candidate: LiteratureCandidate, item?: Zotero.Item): void;
}

interface TabState {
  /** References only: the provider snapshot. */
  snapshot?: LiteratureSnapshot;
  excerpts: ExcerptGroup[];
  /** Citations only: library papers that cite this one (UniConnection.relationsOf). */
  citing: string[];
  loaded: boolean;
  loading: boolean;
  message?: string;
}

interface SectionState {
  item: Zotero.Item;
  root: HTMLElement;
  tab: SidebarTab;
  references: TabState;
  citations: TabState;
  query: string;
  hits: LibraryHit[];
  /** Explicit expand/collapse choices; rows without one use their default. */
  expanded: Map<string, boolean>;
  busy: Set<string>;
  /** The References list past REFERENCE_PREVIEW is shown. */
  showAll: boolean;
  searchTimer?: number;
  statusTimer?: number;
  generation: number;
  loading?: Promise<void>;
  ui: {
    tabs: Record<SidebarTab, HTMLElement>;
    input: HTMLInputElement;
    refresh: HTMLElement;
    status: HTMLElement;
    list: HTMLElement;
  };
}

const XHTML = "http://www.w3.org/1999/xhtml";
const SECTION_CLASS = "unizero-sidebar";
const SEARCH_DELAY_MS = 250;
const STATUS_MS = 6000;
/** References rows shown before "Show all"; quoted rows and search results are never capped. */
const REFERENCE_PREVIEW = 15;

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

/** A clickable div (see header: `<button>` does not render in the item pane). */
function action(doc: Document, className: string, text: string, title: string, run: () => void): HTMLElement {
  const element = create(doc, "div", `${SECTION_CLASS}__action ${className}`, text);
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  element.title = title;
  element.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      run();
    }
  });
  return element;
}

/**
 * A `sidebar-*` string from the add-on's Fluent file, or the English fallback when
 * it is missing (or Fluent is not up yet). `{ $name }` placeholders take `args`.
 */
function t(key: string, fallback: string, args?: Record<string, unknown>): string {
  const id = `sidebar-${key}`;
  let value: string | undefined;
  try {
    value = args ? getString(id, { args }) : getString(id);
  } catch {
    value = undefined;
  }
  if (value && !value.endsWith(id)) { return value; }
  return fallback.replace(/\{ \$(\w+) \}/g, (_, name: string) => String(args?.[name] ?? ""));
}

function summaryOf(scopedKey: string): PaperSummary | undefined {
  const separator = scopedKey.indexOf(":");
  const item = Zotero.Items.getByLibraryAndKey(
    Number(scopedKey.slice(0, separator)),
    scopedKey.slice(separator + 1),
  ) as Zotero.Item | false;
  return item && !item.deleted && item.isRegularItem() ? libraryHit(item) : undefined;
}

function keyOf(candidate: LiteratureCandidate): string | undefined {
  const itemID = candidate.membership?.inLibrary ? candidate.membership.itemID : undefined;
  if (!itemID) { return; }
  const item = Zotero.Items.get(itemID) as Zotero.Item | false;
  return item && !item.deleted ? scopedKeyOf({ libraryID: item.libraryID, itemKey: String(item.key) }) : undefined;
}

function itemOf(row: SidebarRow): Zotero.Item | undefined {
  if (!row.scopedKey || row.missing) { return; }
  const separator = row.scopedKey.indexOf(":");
  const item = Zotero.Items.getByLibraryAndKey(
    Number(row.scopedKey.slice(0, separator)),
    row.scopedKey.slice(separator + 1),
  ) as Zotero.Item | false;
  return item && !item.deleted ? item : undefined;
}

function hasAnnotationDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types || []).includes(ANNOTATION_DRAG_TYPE);
}

function errorText(error: unknown): string {
  return error instanceof ExcerptError ? error.message : String((error as Error)?.message || error);
}

export class LiteratureSidebar {
  private readonly sections = new WeakMap<HTMLElement, SectionState>();
  /** Survives section rebuilds, like the tab the user was last on. */
  private lastTab: SidebarTab = "references";

  public constructor(private readonly port: LiteratureSidebarPort) {}

  /** Mount the section for `item` in `body`, or keep the one already there. */
  public render(body: HTMLElement, item: Zotero.Item): void {
    const existing = body.querySelector(`.${SECTION_CLASS}`) as HTMLElement | null;
    const state = existing ? this.sections.get(existing) : undefined;
    if (state && state.item.id === item.id) { return; }
    body.querySelectorAll(`.${SECTION_CLASS}`).forEach((element) => {
      const old = this.sections.get(element as HTMLElement);
      if (old) { this.dispose(old); }
      element.remove();
    });
    this.mount(body, item);
  }

  /** Remove the section (a tab type this section does not serve). */
  public clear(body: HTMLElement): void {
    body.querySelectorAll(`.${SECTION_CLASS}`).forEach((element) => {
      const old = this.sections.get(element as HTMLElement);
      if (old) { this.dispose(old); }
      element.remove();
    });
  }

  /** Resolves when the section's first load has settled. */
  public async whenLoaded(body: HTMLElement): Promise<void> {
    const root = body.querySelector(`.${SECTION_CLASS}`) as HTMLElement | null;
    await (root && this.sections.get(root)?.loading);
  }

  private dispose(state: SectionState): void {
    state.generation += 1;
    const win = state.root.ownerDocument.defaultView;
    if (win && state.searchTimer) { win.clearTimeout(state.searchTimer); }
    if (win && state.statusTimer) { win.clearTimeout(state.statusTimer); }
  }

  private mount(body: HTMLElement, item: Zotero.Item): void {
    const doc = body.ownerDocument;
    const root = create(doc, "div", SECTION_CLASS);

    const tabBar = create(doc, "div", `${SECTION_CLASS}__tabs`);
    const tabs = {} as Record<SidebarTab, HTMLElement>;
    for (const tab of ["references", "citations"] as const) {
      const element = create(doc, "div", `${SECTION_CLASS}__tab`);
      element.dataset.tab = tab;
      element.setAttribute("role", "tab");
      tabs[tab] = element;
      tabBar.append(element);
    }

    const toolbar = create(doc, "div", `${SECTION_CLASS}__toolbar`);
    const input = create(doc, "input", `${SECTION_CLASS}__search`);
    input.type = "search";
    const status = create(doc, "div", `${SECTION_CLASS}__status`);
    status.hidden = true;
    const list = create(doc, "div", `${SECTION_CLASS}__list`);
    list.setAttribute("role", "list");

    const empty = (): TabState => ({ excerpts: [], citing: [], loaded: false, loading: false });
    const state: SectionState = {
      item,
      root,
      tab: this.lastTab,
      references: empty(),
      citations: empty(),
      query: "",
      hits: [],
      expanded: new Map(),
      busy: new Set(),
      showAll: false,
      generation: 0,
      ui: { tabs, input, refresh: undefined as unknown as HTMLElement, status, list },
    };
    this.sections.set(root, state);

    // Tab switching on mousedown in the capture phase: Zotero's item pane has been
    // seen to swallow plain clicks on the way up.
    tabBar.addEventListener("mousedown", (event) => {
      const tab = (event.target as HTMLElement)?.closest(`.${SECTION_CLASS}__tab`) as HTMLElement | null;
      if (!tab) { return; }
      event.preventDefault();
      this.selectTab(state, tab.dataset.tab as SidebarTab);
    }, true);

    input.addEventListener("input", () => {
      state.query = input.value;
      this.draw(state);
      this.scheduleLibrarySearch(state);
    });

    state.ui.refresh = action(doc, `${SECTION_CLASS}__refresh`, "⟳", "",
      () => { void this.load(state, state.tab, "refresh"); });
    toolbar.append(
      input,
      state.ui.refresh,
      action(doc, `${SECTION_CLASS}__open`, "⤢", t("open-home", "Open in Unizero Home"),
        () => {
          const win = doc.defaultView;
          if (win) { this.port.openExplorer(win, item, state.tab); }
        }),
    );

    root.append(tabBar, toolbar, status, list);
    body.append(root);
    this.selectTab(state, state.tab);
  }

  private selectTab(state: SectionState, tab: SidebarTab): void {
    state.tab = tab;
    this.lastTab = tab;
    state.hits = [];
    this.draw(state);
    this.scheduleLibrarySearch(state);
    const tabState = state[tab];
    if (tabState.loaded || tabState.loading) { return; }
    // References fetch on a cache miss as soon as the section opens; Citations only
    // read the local index.
    const loading = this.load(state, tab, "open");
    if (!state.loading) { state.loading = loading; }
  }

  private async load(
    state: SectionState,
    tab: SidebarTab,
    mode: "open" | "refresh" | "excerpts",
  ): Promise<void> {
    const tabState = state[tab];
    if (tabState.loading) { return; }
    const generation = state.generation;
    const item = state.item;
    tabState.loading = true;
    tabState.message = undefined;
    this.draw(state);
    try {
      if (tab === "citations") {
        const [excerpts, relations] = await Promise.all([
          uniConnection.excerptsAbout(item),
          uniConnection.relationsOf(item),
        ]);
        if (generation !== state.generation) { return; }
        tabState.excerpts = excerpts;
        tabState.citing = relations.map((hit) => hit.scopedKey);
        tabState.loaded = true;
        if (!this.rows(state, "citations").length) {
          tabState.message = t("no-citing",
            "No paper in your library cites this one yet. Only papers whose References have been loaded count.");
        }
        return;
      }
      let snapshot = tabState.snapshot;
      if (mode === "refresh") {
        snapshot = await this.port.fetchReferences(item, true);
      } else if (mode === "open") {
        snapshot = await this.port.cachedReferences(item);
        if (!snapshot && this.port.canFetchReferences(item)) {
          snapshot = await this.port.fetchReferences(item, false);
        }
      }
      const excerpts = await uniConnection.excerptsFrom(item);
      if (generation !== state.generation) { return; }
      tabState.snapshot = snapshot;
      tabState.excerpts = excerpts;
      tabState.loaded = true;
      if (!snapshot) {
        tabState.message = this.port.canFetchReferences(item)
          ? t("nothing-saved", "Nothing saved for this paper yet.")
          : t("no-identifier", "This paper has no DOI or Semantic Scholar ID to look it up by.");
      }
    } catch (error) {
      if (generation !== state.generation) { return; }
      tabState.message = errorText(error);
      ztoolkit.log(`[sidebar] ${tab} ${mode} failed`, error);
    } finally {
      if (generation === state.generation) {
        tabState.loading = false;
        this.draw(state);
      }
    }
    if (tab === "references" && mode === "open" && tabState.snapshot) {
      void this.resolveInBackground(state);
    }
  }

  private async resolveInBackground(state: SectionState): Promise<void> {
    const generation = state.generation;
    try {
      if (!await this.port.resolvePendingReferences(state.item)) { return; }
      const snapshot = await this.port.cachedReferences(state.item);
      if (generation !== state.generation || !snapshot) { return; }
      state.references.snapshot = snapshot;
      this.draw(state);
    } catch (error) {
      ztoolkit.log("[sidebar] resolving references failed", error);
    }
  }

  private scheduleLibrarySearch(state: SectionState): void {
    const win = state.root.ownerDocument.defaultView;
    if (!win) { return; }
    if (state.searchTimer) { win.clearTimeout(state.searchTimer); }
    if (state.tab !== "references" || !searchTokens(state.query).length) {
      if (state.hits.length) {
        state.hits = [];
        this.draw(state);
      }
      return;
    }
    const query = state.query;
    const generation = state.generation;
    state.searchTimer = win.setTimeout(async () => {
      try {
        const hits = await searchLibrary(state.item.libraryID, searchTokens(query).join(" "));
        if (generation !== state.generation || query !== state.query) { return; }
        state.hits = hits;
        this.draw(state);
      } catch (error) {
        ztoolkit.log("[sidebar] library search failed", error);
      }
    }, SEARCH_DELAY_MS);
  }

  private setStatus(state: SectionState, text: string, type: "success" | "fail" | "info" = "info"): void {
    const { status } = state.ui;
    const win = state.root.ownerDocument.defaultView;
    status.textContent = text;
    status.dataset.type = type;
    status.hidden = false;
    status.style.display = "";
    if (!win) { return; }
    if (state.statusTimer) { win.clearTimeout(state.statusTimer); }
    state.statusTimer = win.setTimeout(() => {
      status.hidden = true;
      status.style.display = "none";
    }, STATUS_MS);
  }

  private rows(state: SectionState, tab: SidebarTab): SidebarRow[] {
    const tabState = state[tab];
    return tab === "references"
      ? referenceRows(tabState.snapshot?.items || [], tabState.excerpts, keyOf, summaryOf)
      : citationRows(tabState.excerpts, tabState.citing, summaryOf);
  }

  private draw(state: SectionState): void {
    if (!state.root.isConnected) { return; }
    const doc = state.root.ownerDocument;
    const { tabs, input, refresh, list } = state.ui;

    for (const tab of ["references", "citations"] as const) {
      const tabState = state[tab];
      const total = tab === "references"
        ? tabState.snapshot?.total ?? tabState.snapshot?.items.length
        : this.rows(state, tab).length;
      const label = tab === "references"
        ? t("tab-references", "References")
        : t("tab-citations", "Citations");
      tabs[tab].textContent = typeof total === "number" && tabState.loaded ? `${label} ${total}` : label;
      tabs[tab].classList.toggle("is-active", tab === state.tab);
      tabs[tab].setAttribute("aria-selected", String(tab === state.tab));
    }
    input.placeholder = state.tab === "references"
      ? t("search-references", "Search references and your library")
      : t("search-citations", "Search citations");
    refresh.title = state.tab === "references"
      ? t("refresh", "Fetch this list again from the providers")
      : t("refresh-citations", "Read your library again");

    const tabState = state[state.tab];
    const rows = this.rows(state, state.tab);
    const visible = filterRows(rows, state.query);
    const extra = state.tab === "references" && searchTokens(state.query).length
      ? libraryRows(state.hits, rows, scopedKeyOf({ libraryID: state.item.libraryID, itemKey: String(state.item.key) }))
      : [];

    list.replaceChildren();
    if (tabState.loading && !rows.length) {
      list.append(create(doc, "div", `${SECTION_CLASS}__empty`, t("loading", "Loading…")));
      return;
    }
    if (tabState.message && !rows.length) {
      const box = create(doc, "div", `${SECTION_CLASS}__empty`, tabState.message);
      if (state.tab === "references" && this.port.canFetchReferences(state.item)) {
        box.append(action(doc, `${SECTION_CLASS}__fetch`, t("fetch", "Fetch from providers"), t("fetch", "Fetch from providers"),
          () => { void this.load(state, state.tab, "refresh"); }));
      }
      list.append(box);
    } else if (tabState.message) {
      list.append(create(doc, "div", `${SECTION_CLASS}__empty`, tabState.message));
    }

    const quoted = visible.filter((row) => row.group === "quoted");
    const provider = visible.filter((row) => row.group === "provider");
    if (state.tab === "references") {
      this.group(state, list, t("group-quoted", "Quoted passages"), quoted);
      if (!quoted.length && !searchTokens(state.query).length && rows.length) {
        list.append(create(doc, "div", `${SECTION_CLASS}__hint`,
          t("drag-hint", "Drag a highlight, or text selected in the PDF, onto a reference to attach it.")));
      }
      const capped = !state.showAll && !searchTokens(state.query).length && provider.length > REFERENCE_PREVIEW;
      this.group(state, list, t("group-references", "References"),
        capped ? provider.slice(0, REFERENCE_PREVIEW) : provider, provider.length);
      if (capped) {
        list.append(action(doc, `${SECTION_CLASS}__more`,
          t("show-all", "Show all { $count }", { count: provider.length }),
          t("show-all-hint", "Or type in the search box to find a reference"),
          () => { state.showAll = true; this.draw(state); }));
      }
      this.group(state, list, t("group-library", "From your library"), extra);
    } else {
      this.group(state, list, t("group-quoted-in", "Quoted in your library"), quoted);
      this.group(state, list, t("group-cited-by", "Cite this paper"),
        visible.filter((row) => row.group === "library"));
    }
    if (rows.length && !visible.length && !extra.length) {
      list.append(create(doc, "div", `${SECTION_CLASS}__empty`, t("no-matches", "No matches.")));
    }
  }

  private group(state: SectionState, list: HTMLElement, title: string, rows: SidebarRow[], total = rows.length): void {
    if (!rows.length) { return; }
    const doc = list.ownerDocument;
    list.append(create(doc, "div", `${SECTION_CLASS}__group`, `${title} · ${total}`));
    for (const row of rows) { list.append(this.rowElement(state, row)); }
  }

  private isExpanded(state: SectionState, row: SidebarRow): boolean {
    const choice = state.expanded.get(row.id);
    if (choice !== undefined) { return choice; }
    // How other papers quote this one is the point of that group; open it.
    return state.tab === "citations" && row.group === "quoted";
  }

  private rowElement(state: SectionState, row: SidebarRow): HTMLElement {
    const doc = state.root.ownerDocument;
    const references = state.tab === "references";
    const element = create(doc, "div", `${SECTION_CLASS}__row`);
    element.setAttribute("role", "listitem");
    element.dataset.libraryState = row.missing ? "missing" : row.inLibrary ? "in" : "out";
    const expandable = row.excerpts.length > 0 || (references && row.inLibrary);
    const expanded = expandable && this.isExpanded(state, row);
    element.classList.toggle("is-expanded", expanded);

    const head = create(doc, "div", `${SECTION_CLASS}__head`);
    head.append(create(doc, "span", `${SECTION_CLASS}__chevron`, expandable ? (expanded ? "▾" : "▸") : ""));
    const icon = create(doc, "img", `${SECTION_CLASS}__icon`);
    try {
      icon.setAttribute("src", Zotero.ItemTypes.getImageSrc((row.type || "journalArticle") as any) as string);
    } catch {
      // An unknown type simply has no icon.
    }
    head.append(icon);

    const text = create(doc, "div", `${SECTION_CLASS}__text`);
    if (row.number !== undefined) { text.append(create(doc, "span", `${SECTION_CLASS}__number`, `[${row.number}] `)); }
    const credit = rowCredit(row);
    if (credit) { text.append(create(doc, "span", `${SECTION_CLASS}__credit`, `${credit} `)); }
    text.append(create(doc, "span", `${SECTION_CLASS}__title`, row.title || "Untitled"));
    // Two lines at most (CSS); the hover card, or this tooltip, shows the rest.
    if (!row.candidate) { text.title = [credit, row.title].filter(Boolean).join(" "); }
    head.append(text);

    if (row.excerpts.length) {
      const badge = create(doc, "span", `${SECTION_CLASS}__badge`, `❝ ${row.excerpts.length}`);
      badge.title = `${row.excerpts.length} quoted passage${row.excerpts.length === 1 ? "" : "s"}`;
      head.append(badge);
    }
    if (!row.inLibrary && !row.missing && row.candidate) {
      head.append(action(doc, `${SECTION_CLASS}__add`, state.busy.has(row.id) ? "…" : "+",
        t("add", "Add this paper to Zotero"), () => { void this.addToLibrary(state, row); }));
    }

    head.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        this.reveal(state, row);
        return;
      }
      if (!expandable) { return; }
      state.expanded.set(row.id, !expanded);
      this.draw(state);
    });
    if (row.candidate) { this.port.attachTip(head, row.candidate, itemOf(row)); }
    element.append(head);

    if (expanded) {
      const body = create(doc, "div", `${SECTION_CLASS}__excerpts`);
      for (const excerpt of row.excerpts) { body.append(this.excerptElement(state, row, excerpt)); }
      if (references && row.inLibrary) {
        body.append(create(doc, "div", `${SECTION_CLASS}__drop-hint`,
          t("drop-hint", "Drop a highlight or PDF selection here")));
      }
      element.append(body);
    }

    if (references) { this.acceptDrops(state, element, row); }
    return element;
  }

  private excerptElement(state: SectionState, row: SidebarRow, excerpt: ExcerptRecord): HTMLElement {
    const doc = state.root.ownerDocument;
    const element = create(doc, "div", `${SECTION_CLASS}__excerpt`);
    const quote = create(doc, "div", `${SECTION_CLASS}__quote`, `“${excerpt.text}”`);
    quote.title = t("open-pdf", "Open in the PDF");
    quote.setAttribute("role", "link");
    quote.addEventListener("click", () => {
      void openExcerpt(state.item.libraryID, excerpt)
        .then((opened) => {
          if (!opened) { this.setStatus(state, t("pdf-missing", "That PDF is no longer in the library."), "fail"); }
        })
        .catch((error) => this.setStatus(state, errorText(error), "fail"));
    });
    element.append(quote);
    const meta = create(doc, "div", `${SECTION_CLASS}__excerpt-meta`);
    if (excerpt.pageLabel) { meta.append(create(doc, "span", "", `p. ${excerpt.pageLabel}`)); }
    if (state.tab === "references" && row.scopedKey) {
      meta.append(action(doc, `${SECTION_CLASS}__remove`, "×", t("remove", "Remove this passage from the note"),
        () => { void this.removeExcerpt(state, row, excerpt); }));
    }
    element.append(meta);
    return element;
  }

  private acceptDrops(state: SectionState, element: HTMLElement, row: SidebarRow): void {
    element.addEventListener("dragover", (event) => {
      if (!hasAnnotationDrag(event)) { return; }
      event.preventDefault();
      if (event.dataTransfer) { event.dataTransfer.dropEffect = "copy"; }
      element.classList.add("is-drop-target");
    });
    element.addEventListener("dragleave", (event) => {
      if (!element.contains(event.relatedTarget as Node | null)) {
        element.classList.remove("is-drop-target");
      }
    });
    element.addEventListener("drop", (event) => {
      if (!hasAnnotationDrag(event)) { return; }
      event.preventDefault();
      event.stopPropagation();
      element.classList.remove("is-drop-target");
      const raw = event.dataTransfer?.getData(ANNOTATION_DRAG_TYPE) || "";
      void this.attach(state, row, raw);
    });
  }

  private async attach(state: SectionState, row: SidebarRow, raw: string): Promise<void> {
    const cited = itemOf(row);
    if (!cited || !row.inLibrary) {
      this.setStatus(state, row.candidate
        ? t("add-first", "Add this paper to Zotero first (+), then drop the passage on it.")
        : t("target-missing", "That paper is no longer in the library."), "fail");
      return;
    }
    try {
      // Before annotationsFromDrop, which may create highlights: a drop refused
      // afterwards would leave them in the PDF, attached to nothing.
      assertWritable(state.item, cited);
      const annotations = await annotationsFromDrop(parseAnnotationDrop(raw), state.item);
      let added = 0;
      for (const annotation of annotations) {
        if (await addExcerpt(state.item, cited, annotation)) { added += 1; }
      }
      state.expanded.set(row.id, true);
      if (!state.root.isConnected) { return; }
      await this.load(state, "references", "excerpts");
      this.setStatus(state, added
        ? t("attached", "Attached { $count } passage(s) to { $paper }.",
          { count: added, paper: rowCredit(row) || row.title })
        : t("already-attached", "Already attached."), added ? "success" : "info");
    } catch (error) {
      this.setStatus(state, errorText(error), "fail");
      if (!(error instanceof ExcerptError)) { ztoolkit.log("[sidebar] attach failed", error); }
    }
  }

  private async removeExcerpt(state: SectionState, row: SidebarRow, excerpt: ExcerptRecord): Promise<void> {
    if (!row.scopedKey) { return; }
    const separator = row.scopedKey.indexOf(":");
    try {
      const removed = await removeExcerpt(state.item, {
        libraryID: Number(row.scopedKey.slice(0, separator)),
        key: row.scopedKey.slice(separator + 1),
      }, excerpt.annotationKey);
      await this.load(state, "references", "excerpts");
      if (removed) {
        this.setStatus(state, t("removed", "Passage removed from the note."), "success");
      } else {
        this.setStatus(state, t("remove-not-found",
          "This passage could not be cut out of the note automatically; delete it in the note itself."), "fail");
      }
    } catch (error) {
      this.setStatus(state, errorText(error), "fail");
    }
  }

  private async addToLibrary(state: SectionState, row: SidebarRow): Promise<void> {
    if (!row.candidate || state.busy.has(row.id)) { return; }
    state.busy.add(row.id);
    this.draw(state);
    try {
      await this.port.addToLibrary(state.item, row.candidate);
      const snapshot = await this.port.cachedReferences(state.item);
      if (snapshot) { state.references.snapshot = snapshot; }
      this.setStatus(state, t("added", "Added { $paper } to Zotero.", { paper: rowCredit(row) || row.title }), "success");
    } catch (error) {
      this.setStatus(state, t("add-failed", "Could not add this paper: { $error }", { error: errorText(error) }), "fail");
    } finally {
      state.busy.delete(row.id);
      this.draw(state);
    }
  }

  /** Ctrl/Cmd-click: select the paper in the library, or open its web page. */
  private reveal(state: SectionState, row: SidebarRow): void {
    const win = state.root.ownerDocument.defaultView as any;
    const item = itemOf(row);
    if (item && win?.ZoteroPane) {
      win.Zotero_Tabs?.select?.("zotero-pane");
      win.ZoteroPane.selectItem(item.id);
      return;
    }
    const doi = (row.candidate?.identifiers as Record<string, string> | undefined)?.DOI;
    const url = doi ? `https://doi.org/${doi}` : row.candidate?.url;
    if (url && /^https?:\/\//.test(url)) { Zotero.launchURL(url); }
  }
}
