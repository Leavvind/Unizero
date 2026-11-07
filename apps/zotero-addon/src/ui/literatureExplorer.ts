/**
 * Bridge for Unizero Home: per-paper References / Relation / Citations tabs.
 *
 * The XHTML/JS window is intentionally a thin view. Provider calls, cache policy,
 * library scoping, and Zotero mutations stay in Views/application code and cross
 * the window boundary through this small API object.
 */

import { config } from "../../package.json";
import type Views from "../modules/views";
import {
  invalidateLibraryMembership,
  type LiteratureCandidate,
  type LiteratureRelationKind,
} from "../modules/literatureRelations";
import type { RelationSourceKey } from "../modules/mergeRelations";
import { getString } from "../utils/locale";
import { paperDestinationFromItem } from "../zotero/literatureItemAdapter";

const EXPLORER_URL = `chrome://${config.addonRef}/content/literature-explorer.xhtml`;
const EXPLORER_WINDOW_NAME = `${config.addonRef}-literature-explorer`;

/** The paper the window was last opened on; tabs it already holds stay open. */
interface ExplorerContext {
  libraryID: number;
  itemKey: string;
  kind: LiteratureRelationKind;
}

let explorerWindow: Window | null = null;
let explorerOwner: Window | null = null;
let explorerContext: ExplorerContext | null = null;
let explorerViews: Views | null = null;

/**
 * Resolve a tab's paper. The window passes the library its tab belongs to, so a
 * request still in flight after the window moved to another library resolves
 * against its own library, never the new one.
 */
function contextItem(itemKey: string, libraryID?: number): Zotero.Item {
  if (!explorerContext) { throw new Error("Unizero Home has no paper"); }
  const targetLibraryID = libraryID ?? explorerContext.libraryID;
  const item = Zotero.Items.getByLibraryAndKey(
    targetLibraryID,
    itemKey,
  ) as Zotero.Item | false;
  if (!item) { throw new Error("The source Zotero item no longer exists"); }
  return item;
}

function activeViews(): Views {
  if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
  return explorerViews;
}

function strings() {
  const read = (key: string, fallback: string) => getString(key) || fallback;
  return {
    title: read("literature-explorer-title", "Unizero Home"),
    closeTab: read("literature-close-tab-label", "Close tab"),
    references: read("tab-references-label", "References"),
    relation: read("tab-relation-label", "Relation"),
    citations: read("tab-citations-label", "Citations"),
    search: read("literature-search-placeholder", "Search title or author"),
    searchLabel: read("literature-filter-search-label", "Search"),
    sourceFilterLabel: read("literature-source-filter-label", "Source"),
    combinedSource: read("literature-source-combined-label", "Combined"),
    refreshSource: read("literature-refresh-source-label", "Refresh this source"),
    restricted: read("literature-source-restricted-label", "Restricted"),
    noAbstract: read("literature-no-abstract-label", "No abstract available"),
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
    mostShared: read(
      "literature-sort-shared-label",
      "Most shared references",
    ),
    newest: read("literature-sort-newest-label", "Newest"),
    titleColumn: read("literature-column-title-label", "Title"),
    yearColumn: read("literature-column-year-label", "Year"),
    citationsColumn: read("literature-column-citations-label", "Citations"),
    influenceColumn: read("literature-column-influence-label", "Influence"),
    libraryColumn: read("literature-column-library-label", "Library"),
    sourceColumn: read("literature-column-source-label", "Source"),
    relationColumn: read("literature-column-relation-label", "Relationship"),
    sharedColumn: read(
      "literature-column-shared-label",
      "Shared references",
    ),
    relationCites: read(
      "literature-relation-cites-label",
      "Cites this paper",
    ),
    relationCoupled: read(
      "literature-relation-coupled-label",
      "Bibliographic coupling",
    ),
    relationBoth: read(
      "literature-relation-both-label",
      "Cites + coupled",
    ),
    relationSource: read(
      "literature-relation-source-label",
      "Library graph",
    ),
    relationEmpty: read(
      "literature-relation-empty-label",
      "No library citations or bibliographic coupling found",
    ),
    refresh: read("relatedbox-refresh-label", "Refresh"),
    loadMore: read("citationsbox-more-label", "Load more"),
    loading: read("literature-loading-label", "Loading…"),
    readingCache: read(
      "literature-reading-cache-label",
      "Reading saved data…",
    ),
    empty: read("literature-empty-label", "No papers found"),
    notCached: read(
      "literature-not-cached-label",
      "Nothing saved for this paper yet",
    ),
    fetchNow: read("literature-fetch-now-label", "Fetch from providers"),
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
    getContext: () => explorerContext ? { ...explorerContext } : null,
    snapshot: async (
      itemKey: string,
      kind: LiteratureRelationKind,
      refresh = false,
      libraryID?: number,
    ) => activeViews().getLiteratureSnapshot(
      contextItem(itemKey, libraryID),
      kind,
      refresh,
    ),
    snapshotStatus: async (
      itemKey: string,
      kind: LiteratureRelationKind,
      libraryID?: number,
    ) => {
      if (kind === "relation") { return { loaded: true }; }
      const statuses = await activeViews().relationStatuses(
        contextItem(itemKey, libraryID),
      );
      return statuses[kind];
    },
    loadMoreCitations: async (itemKey: string, libraryID?: number) =>
      activeViews().loadMoreLiteratureCitations(contextItem(itemKey, libraryID)),
    refreshSource: async (
      itemKey: string,
      kind: LiteratureRelationKind,
      sourceKey: RelationSourceKey,
      libraryID?: number,
    ) => activeViews().refreshLiteratureSource(
      contextItem(itemKey, libraryID),
      kind,
      sourceKey,
    ),
    // A discovery is filed alongside the paper it was found from.
    addToLibrary: async (itemKey: string, candidate: LiteratureCandidate) =>
      activeViews().addLiteratureCandidateToLibrary(
        paperDestinationFromItem(contextItem(itemKey)),
        candidate,
      ),
    // Live per-source progress for the in-window indicator; a plain synchronous read
    // of the providers' diagnostics, safe to poll while a load is in flight.
    relationProgress: (kind: LiteratureRelationKind) =>
      explorerViews ? explorerViews.relationProgress(kind) : [],
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
  explorerContext = { libraryID: item.libraryID, itemKey: item.key, kind };
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
