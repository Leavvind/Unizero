/**
 * Bridge for the independent References/Citations browser.
 *
 * The XHTML/JS window is intentionally a thin view. Provider calls, cache policy,
 * library scoping, and Zotero mutations stay in Views/application code and cross
 * the window boundary through this small API object.
 */

import { config } from "../../package.json";
import { convertItems } from "../features/conversion/commands";
import type Views from "../modules/views";
import {
  invalidateLibraryMembership,
  type LiteratureCandidate,
  type LiteratureCollectionScope,
  type LiteratureRelationKind,
} from "../modules/literatureRelations";
import { getString } from "../utils/locale";
import { selectedLiteratureScope } from "../zotero/literatureCollectionAdapter";

const EXPLORER_URL = `chrome://${config.addonRef}/content/literature-explorer.xhtml`;
const EXPLORER_WINDOW_NAME = `${config.addonRef}-literature-explorer`;
const DEFAULT_TEMPLATE_ID = "paper-to-markdown";
const DEFAULT_TEMPLATE_NAME = "Generate paper Markdown";

interface ExplorerContext {
  mode: "collection" | "item";
  scope: LiteratureCollectionScope;
  itemKey?: string;
  kind?: LiteratureRelationKind;
}

let explorerWindow: Window | null = null;
let explorerOwner: Window | null = null;
let explorerContext: ExplorerContext | null = null;
let explorerViews: Views | null = null;

function contextItem(itemKey?: string): Zotero.Item {
  if (!explorerContext) { throw new Error("Literature Explorer has no item context"); }
  const key = itemKey || explorerContext.itemKey;
  if (!key) { throw new Error("Literature Explorer has no selected paper"); }
  const item = Zotero.Items.getByLibraryAndKey(
    explorerContext.scope.libraryID,
    key,
  ) as Zotero.Item | false;
  if (!item) { throw new Error("The source Zotero item no longer exists"); }
  return item;
}

function strings() {
  const read = (key: string, fallback: string) => getString(key) || fallback;
  return {
    title: read("literature-explorer-title", "Literature Explorer"),
    collectionOverview: read("literature-collection-overview-label", "Collection"),
    collectionSearch: read(
      "literature-collection-search-placeholder",
      "Search this Collection",
    ),
    backToCollection: read(
      "literature-back-to-collection-label",
      "Back to Collection",
    ),
    creatorColumn: read("literature-column-creator-label", "Creator"),
    dateAddedColumn: read("literature-column-date-added-label", "Date Added"),
    markdownColumn: read("literature-column-markdown-label", "Markdown"),
    collectionEmpty: read(
      "literature-collection-empty-label",
      "No regular items in this Collection",
    ),
    loaded: read("literature-loaded-label", "Loaded"),
    loadReferences: read(
      "literature-load-references-label",
      "Load references",
    ),
    loadCitations: read("literature-load-citations-label", "Load citations"),
    generateMarkdown: read(
      "literature-generate-markdown-label",
      "Generate Markdown",
    ),
    markdownReady: read("literature-markdown-ready-label", "Markdown ready"),
    noPdf: read("literature-no-pdf-label", "No PDF attachment"),
    openRelations: read(
      "literature-open-relations-label",
      "Open References and Citations",
    ),
    references: read("tab-references-label", "References"),
    citations: read("tab-citations-label", "Citations"),
    search: read("literature-search-placeholder", "Search title or author"),
    searchLabel: read("literature-filter-search-label", "Search"),
    libraryStatusLabel: read("literature-library-status-label", "Library Status"),
    allLibrary: read("literature-library-all-label", "All"),
    inLibrary: read("literature-in-library-label", "In"),
    notInLibrary: read("literature-not-in-library-label", "Not in"),
    influenceLabel: read("literature-influence-label", "Influence"),
    allInfluence: read("literature-influence-all-label", "All"),
    influentialOnly: read("literature-influential-only-label", "Influential"),
    yearLabel: read("literature-year-filter-label", "Year"),
    yearFrom: read("literature-year-from-placeholder", "From"),
    yearTo: read("literature-year-to-placeholder", "To"),
    publicationTypeLabel: read(
      "literature-publication-type-label",
      "Publication Type",
    ),
    allPublicationTypes: read("literature-publication-type-all-label", "All"),
    journalArticle: read("literature-publication-type-journal-label", "Journal article"),
    conferencePaper: read("literature-publication-type-conference-label", "Conference paper"),
    preprint: read("literature-publication-type-preprint-label", "Preprint"),
    book: read("literature-publication-type-book-label", "Book / chapter"),
    otherPublicationType: read("literature-publication-type-other-label", "Other"),
    publicationLevelLabel: read(
      "literature-publication-level-label",
      "Publication Level",
    ),
    allPublicationLevels: read("literature-publication-level-all-label", "All"),
    orderLabel: read("literature-order-label", "Order"),
    originalOrder: read("literature-sort-original-label", "Original order"),
    influentialFirst: read("literature-sort-influential-label", "Influential first"),
    mostCited: read("literature-sort-cited-label", "Most cited"),
    newest: read("literature-sort-newest-label", "Newest"),
    titleColumn: read("literature-column-title-label", "Title"),
    yearColumn: read("literature-column-year-label", "Year"),
    citationsColumn: read("literature-column-citations-label", "Citations"),
    influenceColumn: read("literature-column-influence-label", "Influence"),
    libraryColumn: read("literature-column-library-label", "Library"),
    sourceColumn: read("literature-column-source-label", "Source"),
    refresh: read("relatedbox-refresh-label", "Refresh"),
    loadMore: read("citationsbox-more-label", "Load more"),
    loading: read("literature-loading-label", "Loading…"),
    empty: read("literature-empty-label", "No papers found"),
    influential: read("literature-influential-label", "Influential"),
    add: read("literature-add-label", "Add to current Zotero library"),
    present: read("literature-present-label", "Already in current Zotero library"),
    open: read("literature-open-paper-label", "Open paper"),
    select: read("literature-select-paper-label", "Show in Zotero"),
    error: read("literature-error-label", "Could not load papers"),
  };
}

function explorerApi() {
  return {
    strings: strings(),
    getContext: () => explorerContext
      ? { ...explorerContext, scope: { ...explorerContext.scope } }
      : null,
    collectionSnapshot: async () => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      if (!explorerContext) { throw new Error("Literature Explorer has no scope"); }
      return explorerViews.getLiteratureCollectionSnapshot(explorerContext.scope);
    },
    snapshot: async (
      itemKey: string,
      kind: LiteratureRelationKind,
      refresh = false,
    ) => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      explorerContext!.itemKey = itemKey;
      explorerContext!.kind = kind;
      return explorerViews.getLiteratureSnapshot(contextItem(itemKey), kind, refresh);
    },
    loadMoreCitations: async (itemKey: string) => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      return explorerViews.loadMoreLiteratureCitations(contextItem(itemKey));
    },
    addToLibrary: async (itemKey: string, candidate: LiteratureCandidate) => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      return explorerViews.addLiteratureCandidateToLibrary(
        contextItem(itemKey),
        candidate,
      );
    },
    loadRelation: async (itemKey: string, kind: LiteratureRelationKind) => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      const item = contextItem(itemKey);
      await explorerViews.getLiteratureSnapshot(item, kind);
      return explorerViews.getLiteratureCollectionPaper(item);
    },
    convertItem: async (itemKey: string) => {
      if (!explorerOwner || !explorerViews) {
        throw new Error("Literature Explorer is unavailable");
      }
      const item = contextItem(itemKey);
      await convertItems(
        explorerOwner,
        [item],
        DEFAULT_TEMPLATE_ID,
        DEFAULT_TEMPLATE_NAME,
      );
      return explorerViews.getLiteratureCollectionPaper(item);
    },
    launchURL: (url: string) => {
      if (url) { Zotero.launchURL(url); }
    },
    selectItem: (itemID: number) => {
      if (!itemID || !explorerOwner) { return; }
      (explorerOwner as any).Zotero_Tabs?.select?.("zotero-pane");
      (explorerOwner as any).ZoteroPane?.selectItem?.(itemID);
      explorerOwner.focus();
    },
  };
}

export function openLiteratureExplorer(
  mainWindow: Window,
  item: Zotero.Item,
  kind: LiteratureRelationKind,
  views: Views,
): void {
  explorerContext = {
    mode: "item",
    scope: selectedLiteratureScope(mainWindow, item.libraryID),
    itemKey: item.key,
    kind,
  };
  openExplorerWindow(mainWindow, views);
}

export function openLiteratureExplorerForCollection(
  mainWindow: Window,
  views: Views,
): void {
  explorerContext = {
    mode: "collection",
    scope: selectedLiteratureScope(mainWindow),
  };
  openExplorerWindow(mainWindow, views);
}

function openExplorerWindow(mainWindow: Window, views: Views): void {
  explorerViews = views;
  explorerOwner = mainWindow;
  // A deliberate open is the natural moment to re-derive membership from Zotero,
  // rather than trusting whatever the short-lived index still holds.
  invalidateLibraryMembership();
  if (explorerWindow && !explorerWindow.closed) {
    (explorerWindow as any).LiteratureExplorer?.reloadContext?.();
    explorerWindow.focus();
    return;
  }
  explorerWindow = (mainWindow as any).openDialog(
    EXPLORER_URL,
    EXPLORER_WINDOW_NAME,
    "chrome,centerscreen,resizable=yes,dialog=no,width=1180,height=820",
    { api: explorerApi() },
  );
}

export function closeLiteratureExplorer(): void {
  if (explorerWindow && !explorerWindow.closed) {
    try { explorerWindow.close(); } catch { /* already closing */ }
  }
  explorerWindow = null;
  explorerOwner = null;
  explorerContext = null;
  explorerViews = null;
}

export function closeLiteratureExplorerForOwner(mainWindow: Window): void {
  if (explorerOwner === mainWindow) { closeLiteratureExplorer(); }
}
