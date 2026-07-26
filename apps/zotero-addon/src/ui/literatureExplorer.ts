/**
 * Bridge for the independent References/Relation/Citations browser.
 *
 * The XHTML/JS window is intentionally a thin view. Provider calls, cache policy,
 * library scoping, and Zotero mutations stay in Views/application code and cross
 * the window boundary through this small API object.
 */

import { config } from "../../package.json";
import { convertItems } from "../features/conversion/commands";
import { getConversionPref } from "../features/conversion/settings";
import type Views from "../modules/views";
import {
  invalidateLibraryMembership,
  type LiteratureCandidate,
  type LiteratureCollectionScope,
  type LiteratureRelationKind,
} from "../modules/literatureRelations";
import type { RelationSourceKey } from "../modules/mergeRelations";
import { getString } from "../utils/locale";
import {
  markdownAttachment,
  pdfAttachment,
  relinkMarkdownAttachment,
  selectedLiteratureScope,
} from "../zotero/literatureCollectionAdapter";

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

/**
 * The note identity conversion writes into the Markdown frontmatter.
 *
 * Must stay identical to `_fm_uid` in the runtime's `pipeline/steps.py`; the two
 * sides never exchange this value, they each derive it, which is exactly what
 * makes it usable when the file itself cannot be found. A paper's own key is the
 * parent item key, and a standalone PDF's is the attachment key — `item.key` is
 * already whichever of those applies.
 */
function markdownUid(item: Zotero.Item): string {
  const key = String(item.key || "").trim();
  return key ? `unizero-${item.libraryID}-${key}` : "";
}

const FRONTMATTER_UID = /^uid:\s*["']?([^"'\r\n]+)["']?\s*$/m;

/** Whether a reachable note actually declares the uid we would jump to. */
async function fileCarriesUid(path: string, uid: string): Promise<boolean> {
  try {
    const head = await Zotero.File.getContentsAsync(path, "utf-8", 4000);
    return FRONTMATTER_UID.exec(String(head))?.[1]?.trim() === uid;
  } catch (error) {
    // Unreadable is not "wrong uid": fall back to the path, which is the route
    // that does not need to read anything.
    ztoolkit.log("openMarkdown: could not read frontmatter", error);
    return false;
  }
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
    closeTab: read("literature-close-tab-label", "Close tab"),
    creatorColumn: read("literature-column-creator-label", "Creator"),
    dateAddedColumn: read("literature-column-date-added-label", "Date Added"),
    markdownColumn: read("literature-column-markdown-label", "Markdown"),
    collectionEmpty: read(
      "literature-collection-empty-label",
      "No regular items in this Collection",
    ),
    loaded: read("literature-loaded-label", "Loaded"),
    refreshHint: read("literature-loaded-refresh-hint", "Right-click to refresh"),
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
    markdownMissing: read(
      "literature-markdown-missing-label",
      "The linked file is missing",
    ),
    markdownRelink: read("literature-markdown-relink-label", "Change linked file…"),
    markdownRegenerate: read(
      "literature-markdown-regenerate-label",
      "Convert again",
    ),
    noPdf: read("literature-no-pdf-label", "No PDF attachment"),
    openRelations: read(
      "literature-open-relations-label",
      "Open References and Citations",
    ),
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
    graphTab: read("literature-graph-tab-label", "Graph"),
    graphView: read("literature-graph-view-label", "Graph"),
    tableView: read("literature-table-view-label", "Table"),
    graphEmpty: read(
      "literature-graph-empty-label",
      "No connections yet — load References for more papers to grow the graph",
    ),
    graphLegendCites: read("literature-graph-legend-cites-label", "Cites"),
    graphLegendCoupled: read(
      "literature-graph-legend-coupled-label",
      "Shared references",
    ),
    graphNodes: read("literature-graph-nodes-label", "papers"),
    graphEdges: read("literature-graph-edges-label", "connections"),
    graphOpenHint: read(
      "literature-graph-open-hint-label",
      "Double-click a paper to open it",
    ),
    graphLinksLabel: read("literature-graph-links-label", "Links"),
    graphLinksAll: read("literature-graph-links-all-label", "All"),
    graphLinksCites: read("literature-graph-links-cites-label", "Citations only"),
    graphLinksCoupled: read(
      "literature-graph-links-coupled-label",
      "Shared refs only",
    ),
    graphMinShared: read("literature-graph-min-shared-label", "Min shared"),
    graphHidden: read("literature-graph-hidden-label", "hidden"),
    graphSettings: read("literature-graph-settings-label", "Graph settings"),
    graphDisplayGroup: read("literature-graph-display-group-label", "Display"),
    graphForcesGroup: read("literature-graph-forces-group-label", "Forces"),
    graphArrows: read("literature-graph-arrows-label", "Arrows"),
    graphTextFade: read("literature-graph-text-fade-label", "Text fade threshold"),
    graphNodeSize: read("literature-graph-node-size-label", "Node size"),
    graphLinkThickness: read("literature-graph-link-thickness-label", "Link thickness"),
    graphColour: read("literature-graph-colour-label", "Colour by"),
    graphColourNone: read("literature-graph-colour-none-label", "Uniform"),
    graphColourYear: read("literature-graph-colour-year-label", "Year"),
    graphCenterForce: read("literature-graph-center-force-label", "Center force"),
    graphRepelForce: read("literature-graph-repel-force-label", "Repel force"),
    graphLinkForce: read("literature-graph-link-force-label", "Link force"),
    graphLinkDistance: read("literature-graph-link-distance-label", "Link distance"),
    graphReset: read("literature-graph-reset-label", "Reset to defaults"),
    graphOpenPdf: read("literature-graph-open-pdf-label", "Open PDF"),
    graphOpenObsidian: read("literature-graph-open-obsidian-label", "Open in Obsidian"),
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
    // Derived library graph for the overview. Read-only: it neither fetches from
    // providers nor writes cache records, so calling it is always cheap after the
    // first (index-building) call.
    graph: async () => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      if (!explorerContext) { throw new Error("Literature Explorer has no scope"); }
      return explorerViews.getLiteratureGraph(explorerContext.scope);
    },
    egoGraph: async (itemKey: string) => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      // Same scope as the overview board, so both surfaces show one graph.
      return explorerViews.getLiteratureEgoGraph(
        contextItem(itemKey),
        explorerContext?.scope,
      );
    },
    // Layout coordinates are a rendering convenience, so they are stored per
    // library and reused as the simulation's starting point across sessions.
    graphLayout: async (signature?: string) => {
      if (!explorerViews || !explorerContext) { return {}; }
      return explorerViews.getGraphLayout(explorerContext.scope.libraryID, signature);
    },
    saveGraphLayout: async (
      positions: Record<string, number[]>,
      signature?: string,
    ) => {
      if (!explorerViews || !explorerContext) { return; }
      return explorerViews.saveGraphLayout(
        explorerContext.scope.libraryID,
        positions,
        signature,
      );
    },
    // Display and force settings apply to every library, so unlike the layout they
    // are not scoped. The window owns their meaning and clamps them; this only
    // carries them to and from disk.
    graphSettings: async () => {
      if (!explorerViews) { return {}; }
      return explorerViews.getGraphSettings();
    },
    saveGraphSettings: async (settings: Record<string, unknown>) => {
      if (!explorerViews) { return; }
      return explorerViews.saveGraphSettings(settings);
    },
    loadMoreCitations: async (itemKey: string) => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      return explorerViews.loadMoreLiteratureCitations(contextItem(itemKey));
    },
    refreshSource: async (
      itemKey: string,
      kind: LiteratureRelationKind,
      sourceKey: RelationSourceKey,
    ) => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      explorerContext!.itemKey = itemKey;
      explorerContext!.kind = kind;
      return explorerViews.refreshLiteratureSource(contextItem(itemKey), kind, sourceKey);
    },
    addToLibrary: async (itemKey: string, candidate: LiteratureCandidate) => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      return explorerViews.addLiteratureCandidateToLibrary(
        contextItem(itemKey),
        candidate,
      );
    },
    loadRelation: async (
      itemKey: string,
      kind: LiteratureRelationKind,
      refresh = false,
    ) => {
      if (!explorerViews) { throw new Error("Literature Explorer is unavailable"); }
      const item = contextItem(itemKey);
      await explorerViews.getLiteratureSnapshot(item, kind, refresh);
      return explorerViews.getLiteratureCollectionPaper(item);
    },
    // Live per-source progress for the in-window indicator; a plain synchronous read
    // of the providers' diagnostics, safe to poll while a load is in flight.
    relationProgress: (kind: LiteratureRelationKind) =>
      explorerViews ? explorerViews.relationProgress(kind) : [],
    // Cache-only re-probe of the given papers' loaded state, so returning to the
    // collection view reflects anything loaded meanwhile (item pane, prior session).
    refreshCollectionStatuses: async (itemKeys: string[]) => {
      if (!explorerViews || !explorerContext) { return {}; }
      const libraryID = explorerContext.scope.libraryID;
      const out: Record<
        string,
        Awaited<ReturnType<Views["relationStatuses"]>>
      > = {};
      for (const key of itemKeys) {
        const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
          | Zotero.Item
          | false;
        if (item) { out[key] = await explorerViews.relationStatuses(item); }
      }
      return out;
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
    // Zotero's own viewer path: it honours the reader preference, opens in the main
    // window, and handles a missing file with its own dialog.
    openPdf: async (itemKey: string) => {
      if (!explorerOwner) { throw new Error("Literature Explorer is unavailable"); }
      const item = contextItem(itemKey);
      let attachment = pdfAttachment(item);
      if (!attachment) {
        const best = await (item as any).getBestAttachment?.();
        if (best) { attachment = best as Zotero.Item; }
      }
      if (!attachment) { throw new Error("This paper has no PDF attachment"); }
      await (explorerOwner as any).ZoteroPane?.viewAttachment?.(attachment.id);
      explorerOwner.focus();
    },
    /**
     * Open a converted paper's Markdown in Obsidian.
     *
     * Two routes, and the choice matters because the Markdown is attached as a
     * *link*: Zotero stores a path and nothing else, so renaming or moving the
     * note inside the vault leaves a record that still says "converted" pointing
     * at a file that is no longer there.
     *
     * - By `uid`, through the Advanced URI plugin. The uid is derived from the
     *   Zotero item, so it can be recomputed here without opening anything, and
     *   it is the same value conversion wrote into the frontmatter. This is the
     *   route that still works once the path is stale.
     * - By absolute path, which is all that is possible without a vault name.
     *
     * Notes converted before the uid existed carry none, so a reachable file is
     * checked for one first: sending Obsidian after a uid that is not in the
     * vault would fail where the path would have worked.
     */
    openMarkdown: async (itemKey: string) => {
      const item = contextItem(itemKey);
      const attachment = markdownAttachment(item);
      if (!attachment) { throw new Error("This paper has no Markdown yet"); }
      const vault = String(getConversionPref("obsidianVault") || "").trim();
      // `false` here means the record exists but the file does not.
      const path = await attachment.getFilePathAsync();
      const uid = markdownUid(item);

      if (vault && uid && (!path || await fileCarriesUid(String(path), uid))) {
        Zotero.launchURL(
          `obsidian://adv-uri?vault=${encodeURIComponent(vault)}` +
          `&uid=${encodeURIComponent(uid)}`,
        );
        return uid;
      }
      if (!path) {
        throw new Error(
          vault
            ? "The Markdown file has moved, and the note carries no uid to find " +
              "it by. Re-convert the paper to add one."
            : "The Markdown file has moved. Set an Obsidian vault in the UniZero " +
              "settings to open notes by uid instead of by path, or re-convert.",
        );
      }
      Zotero.launchURL(`obsidian://open?path=${encodeURIComponent(String(path))}`);
      return String(path);
    },
    /**
     * Where a paper's Markdown link points, and whether anything is still there.
     *
     * `exists` is the whole reason this exists: the attachment record says
     * "converted" whether or not the file survived, and nothing in the table can
     * tell the two apart without asking the filesystem.
     */
    markdownLink: async (itemKey: string) => {
      const item = contextItem(itemKey);
      const attachment = markdownAttachment(item);
      if (!attachment) { return null; }
      const existing = await attachment.getFilePathAsync();
      return {
        // getFilePath resolves a base-directory-relative path without checking
        // for the file, so a broken link still has something to show.
        path: String(existing || attachment.getFilePath() || ""),
        exists: Boolean(existing),
        linked: Boolean(attachment.isLinkedFileAttachment?.()),
        uid: markdownUid(item),
      };
    },
    /**
     * Re-point the Markdown link at a file the user chooses.
     *
     * Returns null when the picker is dismissed, so the caller can tell "changed
     * nothing" from "failed" — cancelling is neither an error nor a change.
     */
    relinkMarkdown: async (itemKey: string) => {
      if (!explorerOwner) { throw new Error("Literature Explorer is unavailable"); }
      const item = contextItem(itemKey);
      const picker = new (Zotero as any).FilePicker();
      picker.init(
        explorerWindow || explorerOwner,
        getString("literature-markdown-relink-label") || "Change linked file",
        picker.modeOpen,
      );
      picker.appendFilter("Markdown", "*.md");
      picker.appendFilters(picker.filterAll);
      if (await picker.show() !== picker.returnOK) { return null; }
      const path = String(picker.file || "");
      if (!path) { return null; }
      await relinkMarkdownAttachment(item, path);
      return { path, exists: true, linked: true, uid: markdownUid(item) };
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
