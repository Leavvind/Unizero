/**
 * Bridge for Unizero Home and its References/Relation/Citations detail surface.
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
import {
  createDefaultBoardManualEdge,
  createDefaultBoardPaperNode,
  deleteDefaultBoardEdge,
  deleteDefaultBoardNode,
  ensureProjectForScope,
  listDefaultBoardEdges,
  listDefaultBoardNodes,
  moveDefaultBoardNode,
} from "../projects/projectRepository";
import {
  ensureCatalogPaper,
  readCatalogPaper,
} from "../projects/paperCatalog";
import type {
  BoardNodeGeometry,
  BoardManualEdgeDocument,
  BoardPaperNodeDocument,
  PaperDocument,
  ProjectBundle,
} from "../projects/types";
import { getString } from "../utils/locale";
import {
  markdownAttachment,
  pdfAttachment,
  selectedLiteratureScope,
} from "../zotero/literatureCollectionAdapter";
import {
  defaultMarkdownUrl,
  ensureMarkdownLink,
  recordMarkdownLink,
} from "../zotero/markdownLinkRegistry";

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

function contextItem(itemKey?: string, libraryID?: number): Zotero.Item {
  if (!explorerContext) { throw new Error("Unizero Home has no item context"); }
  const key = itemKey || explorerContext.itemKey;
  if (!key) { throw new Error("Unizero Home has no selected paper"); }
  const targetLibraryID = libraryID ?? explorerContext.scope.libraryID;
  const item = Zotero.Items.getByLibraryAndKey(
    targetLibraryID,
    key,
  ) as Zotero.Item | false;
  if (!item) { throw new Error("The source Zotero item no longer exists"); }
  return item;
}

function strings() {
  const read = (key: string, fallback: string) => getString(key) || fallback;
  return {
    title: read("literature-explorer-title", "Unizero Home"),
    collectionOverview: read("literature-collection-overview-label", "Project"),
    projectLibrary: read("literature-project-library-label", "Collection papers"),
    boardEmpty: read(
      "literature-board-empty-label",
      "Drag papers here to start the Board",
    ),
    boardHint: read(
      "literature-board-hint-label",
      "Drop the same paper more than once to create another card",
    ),
    collapseLibrary: read(
      "literature-collapse-library-label",
      "Collapse paper list",
    ),
    expandLibrary: read(
      "literature-expand-library-label",
      "Expand paper list",
    ),
    collapseDetail: read(
      "literature-collapse-detail-label",
      "Collapse Detail View",
    ),
    boardConnect: read("literature-board-connect-label", "Connect"),
    boardConnecting: read(
      "literature-board-connecting-label",
      "Select another card",
    ),
    boardDelete: read("literature-board-delete-label", "Delete"),
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
    markdownRelink: read("literature-markdown-relink-label", "Change Markdown link…"),
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

interface BoardNodeView {
  node: BoardPaperNodeDocument;
  paper: PaperDocument;
  itemKey?: string;
}

function boardNodeView(
  node: BoardPaperNodeDocument,
  paper: PaperDocument,
  libraryID: number,
): BoardNodeView {
  const binding = paper.bindings.find((entry) =>
    Boolean(Zotero.Items.getByLibraryAndKey(libraryID, entry.itemKey)));
  return { node, paper, itemKey: binding?.itemKey };
}

async function projectSnapshot(
  scope: LiteratureCollectionScope,
): Promise<ProjectBundle & {
  nodes: BoardNodeView[];
  edges: BoardManualEdgeDocument[];
}> {
  const bundle = await ensureProjectForScope(scope);
  const [nodes, edges] = await Promise.all([
    listDefaultBoardNodes(bundle),
    listDefaultBoardEdges(bundle),
  ]);
  return {
    ...bundle,
    edges,
    nodes: await Promise.all(nodes.map(async (node) =>
      boardNodeView(node, await readCatalogPaper(node.paperID), scope.libraryID))),
  };
}

function explorerApi() {
  return {
    strings: strings(),
    getContext: () => explorerContext
      ? { ...explorerContext, scope: { ...explorerContext.scope } }
      : null,
    project: async (scope?: LiteratureCollectionScope) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      return projectSnapshot(scope || explorerContext.scope);
    },
    addBoardNode: async (
      itemKey: string,
      geometry: Partial<BoardNodeGeometry>,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const targetScope = scope || explorerContext.scope;
      const bundle = await ensureProjectForScope(targetScope);
      const item = contextItem(itemKey, targetScope.libraryID);
      const paper = await ensureCatalogPaper(item);
      const node = await createDefaultBoardPaperNode(
        bundle,
        paper.id,
        geometry,
      );
      return boardNodeView(node, paper, targetScope.libraryID);
    },
    moveBoardNode: async (
      nodeID: string,
      geometry: Partial<BoardNodeGeometry>,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const targetScope = scope || explorerContext.scope;
      const bundle = await ensureProjectForScope(targetScope);
      const node = await moveDefaultBoardNode(bundle, nodeID, geometry);
      const paper = await readCatalogPaper(node.paperID);
      return boardNodeView(node, paper, targetScope.libraryID);
    },
    addBoardEdge: async (
      sourceNodeID: string,
      targetNodeID: string,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const bundle = await ensureProjectForScope(scope || explorerContext.scope);
      return createDefaultBoardManualEdge(
        bundle,
        sourceNodeID,
        targetNodeID,
      );
    },
    deleteBoardNode: async (
      nodeID: string,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const bundle = await ensureProjectForScope(scope || explorerContext.scope);
      const edges = await listDefaultBoardEdges(bundle);
      const incident = edges.filter((edge) =>
        edge.sourceNodeID === nodeID || edge.targetNodeID === nodeID);
      for (const edge of incident) {
        await deleteDefaultBoardEdge(bundle, edge.id);
      }
      await deleteDefaultBoardNode(bundle, nodeID);
      return { id: nodeID, deletedEdgeIDs: incident.map((edge) => edge.id) };
    },
    deleteBoardEdge: async (
      edgeID: string,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const bundle = await ensureProjectForScope(scope || explorerContext.scope);
      await deleteDefaultBoardEdge(bundle, edgeID);
      return { id: edgeID };
    },
    collectionSnapshot: async (scope?: LiteratureCollectionScope) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      return explorerViews.getLiteratureCollectionSnapshot(
        scope || explorerContext.scope,
      );
    },
    snapshot: async (
      itemKey: string,
      kind: LiteratureRelationKind,
      refresh = false,
      libraryID?: number,
    ) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
      explorerContext!.itemKey = itemKey;
      explorerContext!.kind = kind;
      return explorerViews.getLiteratureSnapshot(
        contextItem(itemKey, libraryID),
        kind,
        refresh,
      );
    },
    // Derived library graph for the overview. Read-only: it neither fetches from
    // providers nor writes cache records, so calling it is always cheap after the
    // first (index-building) call.
    graph: async (scope?: LiteratureCollectionScope) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      return explorerViews.getLiteratureGraph(scope || explorerContext.scope);
    },
    focusedGraph: async (
      itemKey: string,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
      // Same scope as the overview board, so both surfaces show one graph.
      return explorerViews.getLiteratureFocusedGraph(
        contextItem(itemKey, scope?.libraryID),
        scope || explorerContext?.scope,
      );
    },
    // Layout coordinates are a rendering convenience, so they are stored per
    // library and reused as the simulation's starting point across sessions.
    graphLayout: async (libraryID: number, signature?: string) => {
      if (!explorerViews) { return {}; }
      return explorerViews.getGraphLayout(libraryID, signature);
    },
    saveGraphLayout: async (
      libraryID: number,
      positions: Record<string, number[]>,
      signature?: string,
    ) => {
      if (!explorerViews) { return; }
      return explorerViews.saveGraphLayout(
        libraryID,
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
    loadMoreCitations: async (itemKey: string, libraryID?: number) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
      return explorerViews.loadMoreLiteratureCitations(
        contextItem(itemKey, libraryID),
      );
    },
    refreshSource: async (
      itemKey: string,
      kind: LiteratureRelationKind,
      sourceKey: RelationSourceKey,
      libraryID?: number,
    ) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
      explorerContext!.itemKey = itemKey;
      explorerContext!.kind = kind;
      return explorerViews.refreshLiteratureSource(
        contextItem(itemKey, libraryID),
        kind,
        sourceKey,
      );
    },
    addToLibrary: async (itemKey: string, candidate: LiteratureCandidate) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
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
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
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
    refreshCollectionStatuses: async (
      libraryID: number,
      itemKeys: string[],
    ) => {
      if (!explorerViews) { return {}; }
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
        throw new Error("Unizero Home is unavailable");
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
      if (!explorerOwner) { throw new Error("Unizero Home is unavailable"); }
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
    /** Open the note only through its stored Obsidian URL. */
    openMarkdown: async (itemKey: string) => {
      const item = contextItem(itemKey);
      const attachment = markdownAttachment(item);
      if (!attachment) { throw new Error("This paper has no Markdown yet"); }
      const link = await ensureMarkdownLink(
        item,
        defaultMarkdownUrl(item, getConversionPref("obsidianVault")),
      );
      Zotero.launchURL(link.url);
      return link.url;
    },
    /**
     * The user-editable Obsidian URL for a converted paper.
     */
    markdownLink: async (itemKey: string) => {
      const item = contextItem(itemKey);
      const attachment = markdownAttachment(item);
      if (!attachment) { return null; }
      return ensureMarkdownLink(
        item,
        defaultMarkdownUrl(item, getConversionPref("obsidianVault")),
      );
    },
    /**
     * Edit the URL used by Open in Obsidian.
     *
     * Returns null when the prompt is dismissed, so the caller can tell "changed
     * nothing" from "failed" — cancelling is neither an error nor a change.
     */
    editMarkdownLink: async (itemKey: string) => {
      if (!explorerOwner) { throw new Error("Unizero Home is unavailable"); }
      const item = contextItem(itemKey);
      const attachment = markdownAttachment(item);
      if (!attachment) { throw new Error("This paper has no Markdown attachment"); }
      const current = await ensureMarkdownLink(
        item,
        defaultMarkdownUrl(item, getConversionPref("obsidianVault")),
      );
      const promptWindow = explorerWindow || explorerOwner;
      const edited = promptWindow.prompt(
        getString("literature-markdown-relink-label") || "Change Markdown link",
        current.url,
      );
      if (edited === null) { return null; }
      return recordMarkdownLink(item, edited);
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
