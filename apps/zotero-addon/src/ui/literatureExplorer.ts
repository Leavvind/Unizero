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
import { edgeIdentity } from "../modules/edgeIdentity";
import type Views from "../modules/views";
import {
  externalPaperIDFromKey,
  invalidateLibraryMembership,
  type LiteratureCandidate,
  type LiteratureCollectionScope,
  type LiteratureRelationKind,
} from "../modules/literatureRelations";
import type { RelationSourceKey } from "../modules/mergeRelations";
import {
  BOARD_GEOMETRY_BOUNDS,
  addDefaultBoardPaperBlock,
  createDefaultBoardManualEdge,
  createDefaultBoardPaperNode,
  createDefaultBoardTextNode,
  deleteDefaultBoardContentBlock,
  deleteDefaultBoardEdge,
  deleteDefaultBoardNode,
  ensureProjectForScope,
  listDefaultBoardEdges,
  listDefaultBoardNodes,
  moveDefaultBoardNode,
  updateDefaultBoardTextBlock,
} from "../projects/projectRepository";
import {
  ensureCatalogExternalPaper,
  ensureCatalogPaper,
  listCatalogCitationObservationsForPapers,
  pinCatalogPaper,
  readCatalogPaper,
} from "../projects/paperCatalog";
import type {
  BoardNodeGeometry,
  BoardContentBlock,
  BoardManualEdgeDocument,
  BoardNodeDocument,
  BoardPaperNodeDocument,
  BoardTextNodeDocument,
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
  paperDestinationFromItem,
  paperDestinationFromScope,
} from "../zotero/literatureItemAdapter";
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

/**
 * The catalog Paper an external key names, or undefined for a Zotero key.
 *
 * Unizero Home identifies every open paper by one string, so each relation call
 * that arrives here decides which of the two seeds it has by asking this. A
 * Board card pinned from a reference list is the only producer of external keys.
 */
async function contextPaper(
  itemKey?: string,
): Promise<PaperDocument | undefined> {
  const key = itemKey || explorerContext?.itemKey;
  const paperID = key ? externalPaperIDFromKey(key) : undefined;
  return paperID ? readCatalogPaper(paperID) : undefined;
}

function scopeLibraryID(libraryID?: number): number {
  if (libraryID != null) { return libraryID; }
  if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
  return explorerContext.scope.libraryID;
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
    expandDetail: read(
      "literature-expand-detail-label",
      "Expand Detail View",
    ),
    boardConnect: read("literature-board-connect-label", "Connect"),
    boardConnecting: read(
      "literature-board-connecting-label",
      "Select another card",
    ),
    boardDelete: read("literature-board-delete-label", "Delete"),
    boardAddText: read("literature-board-add-text-label", "Text"),
    boardTextNode: read("literature-board-text-node-label", "Text note"),
    boardTextPlaceholder: read(
      "literature-board-text-placeholder",
      "Write a note…",
    ),
    boardEmbedPaper: read(
      "literature-board-embed-paper-label",
      "Drop a paper here",
    ),
    boardRemoveBlock: read(
      "literature-board-remove-block-label",
      "Remove block",
    ),
    boardFit: read("literature-board-fit-label", "Fit Board"),
    boardZoomIn: read("literature-board-zoom-in-label", "Zoom in"),
    boardZoomOut: read("literature-board-zoom-out-label", "Zoom out"),
    boardConnectHandle: read(
      "literature-board-connect-handle-label",
      "Drag to connect",
    ),
    boardResize: read("literature-board-resize-label", "Resize card"),
    collectionSearch: read(
      "literature-collection-search-placeholder",
      "Search this Collection",
    ),
    closeTab: read("literature-close-tab-label", "Close tab"),
    collectionEmpty: read(
      "literature-collection-empty-label",
      "No regular items in this Collection",
    ),
    loadReferences: read(
      "literature-load-references-label",
      "Load references",
    ),
    loadCitations: read("literature-load-citations-label", "Load citations"),
    generateMarkdown: read(
      "literature-generate-markdown-label",
      "Generate Markdown",
    ),
    markdownRelink: read("literature-markdown-relink-label", "Change Markdown link…"),
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

interface BoardPaperNodeView {
  node: BoardPaperNodeDocument;
  paper: PaperDocument;
  itemKey?: string;
}

interface BoardContentBlockView {
  block: BoardContentBlock;
  paper?: PaperDocument;
  itemKey?: string;
}

interface BoardTextNodeView {
  node: BoardTextNodeDocument;
  blocks: BoardContentBlockView[];
}

type BoardNodeView = BoardPaperNodeView | BoardTextNodeView;

interface BoardRelationHintView {
  sourcePaperID: string;
  targetPaperID: string;
  type: "cites" | "coupled";
}

async function boardRelationHints(
  scope: LiteratureCollectionScope,
  nodes?: BoardNodeView[],
): Promise<BoardRelationHintView[]> {
  const views = explorerViews;
  if (!views) { return []; }
  try {
    let nodeViews = nodes;
    if (!nodeViews) {
      const bundle = await ensureProjectForScope(scope);
      const documents = await listDefaultBoardNodes(bundle);
      nodeViews = await Promise.all(documents.map((node) =>
        boardNodeView(node, scope.libraryID)));
    }
    const members = nodeViews.flatMap((view) => {
      if (!("paper" in view)) { return []; }
      return [{
        paperID: view.paper.id,
        scopedKey: view.itemKey
          ? `${scope.libraryID}:${view.itemKey}`
          : undefined,
        edge: edgeIdentity({
          identifiers: {
            DOI: view.paper.identifiers.doi,
            arXiv: view.paper.identifiers.arxiv,
            paperID: view.paper.identifiers.semanticScholarPaperId,
          },
          title: "",
          authors: [],
        }),
      }];
    });
    const paperIDs = new Set(members.map((member) => member.paperID));
    const [derived, observations] = await Promise.all([
      views.getLiteratureBoardConnections(
        scope.libraryID,
        members,
      ),
      listCatalogCitationObservationsForPapers(paperIDs),
    ]);
    const output: BoardRelationHintView[] = [];
    const seen = new Set<string>();
    const add = (hint: BoardRelationHintView) => {
      const endpoints = hint.type === "coupled"
        ? [hint.sourcePaperID, hint.targetPaperID].sort()
        : [hint.sourcePaperID, hint.targetPaperID];
      const key = `${hint.type}:${endpoints[0]}\u0000${endpoints[1]}`;
      if (seen.has(key)) { return; }
      seen.add(key);
      output.push({
        sourcePaperID: endpoints[0],
        targetPaperID: endpoints[1],
        type: hint.type,
      });
    };
    derived.forEach(add);
    observations.forEach((observation) => {
      if (
        paperIDs.has(observation.citingPaperID) &&
        paperIDs.has(observation.citedPaperID)
      ) {
        add({
          sourcePaperID: observation.citingPaperID,
          targetPaperID: observation.citedPaperID,
          type: "cites",
        });
      }
    });
    return output;
  } catch (error) {
    ztoolkit.log("Board relation hints unavailable", error);
    return [];
  }
}

function paperNodeView(
  node: BoardPaperNodeDocument,
  paper: PaperDocument,
  libraryID: number,
): BoardPaperNodeView {
  const binding = paper.bindings.find((entry) =>
    Boolean(Zotero.Items.getByLibraryAndKey(libraryID, entry.itemKey)));
  return { node, paper, itemKey: binding?.itemKey };
}

async function boardNodeView(
  node: BoardNodeDocument,
  libraryID: number,
): Promise<BoardNodeView> {
  if (node.kind === "paper") {
    return paperNodeView(
      node,
      await readCatalogPaper(node.paperID),
      libraryID,
    );
  }
  return {
    node,
    blocks: await Promise.all(node.blocks.map(async (block) => {
      if (block.kind === "text") { return { block }; }
      const paper = await readCatalogPaper(block.paperID);
      const binding = paper.bindings.find((entry) =>
        Boolean(Zotero.Items.getByLibraryAndKey(libraryID, entry.itemKey)));
      return { block, paper, itemKey: binding?.itemKey };
    })),
  };
}

async function projectSnapshot(
  scope: LiteratureCollectionScope,
): Promise<ProjectBundle & {
  nodes: BoardNodeView[];
  edges: BoardManualEdgeDocument[];
  relationHints: BoardRelationHintView[];
}> {
  const bundle = await ensureProjectForScope(scope);
  const [nodes, edges] = await Promise.all([
    listDefaultBoardNodes(bundle),
    listDefaultBoardEdges(bundle),
  ]);
  const nodeViews = await Promise.all(nodes.map((node) =>
    boardNodeView(node, scope.libraryID)));
  return {
    ...bundle,
    edges,
    nodes: nodeViews,
    relationHints: await boardRelationHints(scope, nodeViews),
  };
}

function explorerApi() {
  return {
    strings: strings(),
    // The dialog clamps a resize to these instead of restating the numbers, so
    // a card cannot be dragged past a size the repository would clamp on save.
    boardGeometryBounds: { ...BOARD_GEOMETRY_BOUNDS },
    getContext: () => explorerContext
      ? { ...explorerContext, scope: { ...explorerContext.scope } }
      : null,
    project: async (scope?: LiteratureCollectionScope) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      return projectSnapshot(scope || explorerContext.scope);
    },
    boardRelationHints: async (scope?: LiteratureCollectionScope) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      return boardRelationHints(scope || explorerContext.scope);
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
      return paperNodeView(node, paper, targetScope.libraryID);
    },
    addBoardCandidate: async (
      candidate: LiteratureCandidate,
      geometry: Partial<BoardNodeGeometry>,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const targetScope = scope || explorerContext.scope;
      const bundle = await ensureProjectForScope(targetScope);
      const localItem = candidate.membership.inLibrary &&
        candidate.membership.itemID
        ? Zotero.Items.get(candidate.membership.itemID) as Zotero.Item | false
        : false;
      const paper = localItem && localItem.libraryID === targetScope.libraryID
        ? await ensureCatalogPaper(localItem)
        : candidate.paperID
          ? await pinCatalogPaper(candidate.paperID)
          : await ensureCatalogExternalPaper({
            identifiers: {
              doi: candidate.identifiers.DOI,
              arxiv: candidate.identifiers.arXiv,
              semanticScholarPaperId: candidate.identifiers.paperID,
              openAlexId: candidate.identifiers.openAlex,
            },
            title: candidate.title || candidate.text || "Untitled",
            authors: [...(candidate.authors || [])],
            year: candidate.year,
            type: candidate.type,
            primaryVenue: candidate.primaryVenue,
            abstract: candidate.abstract,
          });
      const node = await createDefaultBoardPaperNode(
        bundle,
        paper.id,
        geometry,
      );
      return paperNodeView(node, paper, targetScope.libraryID);
    },
    addBoardTextNode: async (
      geometry: Partial<BoardNodeGeometry>,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const targetScope = scope || explorerContext.scope;
      const bundle = await ensureProjectForScope(targetScope);
      return boardNodeView(
        await createDefaultBoardTextNode(bundle, geometry),
        targetScope.libraryID,
      );
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
      return boardNodeView(node, targetScope.libraryID);
    },
    updateBoardTextBlock: async (
      nodeID: string,
      blockID: string,
      text: string,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const targetScope = scope || explorerContext.scope;
      const bundle = await ensureProjectForScope(targetScope);
      return boardNodeView(
        await updateDefaultBoardTextBlock(
          bundle,
          nodeID,
          blockID,
          text,
        ),
        targetScope.libraryID,
      );
    },
    embedBoardPaper: async (
      nodeID: string,
      itemKey: string,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const targetScope = scope || explorerContext.scope;
      const bundle = await ensureProjectForScope(targetScope);
      const paper = await ensureCatalogPaper(
        contextItem(itemKey, targetScope.libraryID),
      );
      return boardNodeView(
        await addDefaultBoardPaperBlock(bundle, nodeID, paper.id),
        targetScope.libraryID,
      );
    },
    deleteBoardBlock: async (
      nodeID: string,
      blockID: string,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      const targetScope = scope || explorerContext.scope;
      const bundle = await ensureProjectForScope(targetScope);
      return boardNodeView(
        await deleteDefaultBoardContentBlock(bundle, nodeID, blockID),
        targetScope.libraryID,
      );
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
      if (!explorerContext) { throw new Error("Unizero Home has no scope"); }
      explorerContext.itemKey = itemKey;
      explorerContext.kind = kind;
      const paper = await contextPaper(itemKey);
      if (paper) {
        return explorerViews.getExternalLiteratureSnapshot(
          paper,
          kind,
          scopeLibraryID(libraryID),
          refresh,
        );
      }
      return explorerViews.getLiteratureSnapshot(
        contextItem(itemKey, libraryID),
        kind,
        refresh,
      );
    },
    snapshotStatus: async (
      itemKey: string,
      kind: LiteratureRelationKind,
      libraryID?: number,
    ) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
      if (kind === "relation") { return { loaded: true }; }
      const paper = await contextPaper(itemKey);
      const statuses = paper
        ? await explorerViews.externalRelationStatuses(paper)
        : await explorerViews.relationStatuses(
          contextItem(itemKey, libraryID),
        );
      return statuses[kind];
    },
    // Derived library graph centred on one paper. Read-only: it neither fetches
    // from providers nor writes cache records, so calling it is always cheap after
    // the first (index-building) call.
    focusedGraph: async (
      itemKey: string,
      scope?: LiteratureCollectionScope,
    ) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
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
      const paper = await contextPaper(itemKey);
      if (paper) {
        return explorerViews.loadMoreExternalLiteratureCitations(
          paper,
          scopeLibraryID(libraryID),
        );
      }
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
      const paper = await contextPaper(itemKey);
      if (paper) {
        return explorerViews.refreshExternalLiteratureSource(
          paper,
          kind,
          sourceKey,
          scopeLibraryID(libraryID),
        );
      }
      return explorerViews.refreshLiteratureSource(
        contextItem(itemKey, libraryID),
        kind,
        sourceKey,
      );
    },
    addToLibrary: async (itemKey: string, candidate: LiteratureCandidate) => {
      if (!explorerViews) { throw new Error("Unizero Home is unavailable"); }
      // A Zotero seed files its discoveries alongside itself. An external seed
      // has no library or collections of its own to inherit, so the window's
      // current scope decides where the new item lands.
      const external = Boolean(await contextPaper(itemKey));
      const destination = external
        ? paperDestinationFromScope(
          scopeLibraryID(),
          explorerContext?.scope.collectionID,
        )
        : paperDestinationFromItem(contextItem(itemKey));
      return explorerViews.addLiteratureCandidateToLibrary(
        destination,
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
