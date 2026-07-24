import { config, version } from "../../package.json";
import { initLocale, getString } from "../utils/locale";
import TipUI from "./tip";
import Utils from "./utils";
import { localStorage } from "./localStorage";
import { readZoMinerReferences, findReferencesAttachment } from "./zomReferences";
import {
  fetchReferencesByIdentifiers,
  fetchReferenceSource,
  referencesDiagnostics,
} from "./referencesApi";
import {
  fetchCitationsByIdentifiers,
  fetchCitationsPage,
  fetchCitationSource,
  citationsDiagnostics,
} from "./citationsApi";
import {
  mergeRelationSources,
  type RelationSourceKey,
  type RelationSourceResult,
} from "./mergeRelations";
import { resolveMany } from "./resolve";
import { PanelStatus } from "./status";
import { readItemPaperIdentifiers } from "./itemIdentifiers";
import { forPersistence } from "./edgeIdentity";
import {
  CACHE_KEY_CITATIONS,
  CACHE_KEY_REFERENCES,
  cacheMatchesIdentifiers,
  makeReferencesCache,
  persistRelationSources,
  type CitationsCache,
  type ReferencesCache,
} from "./literatureCache";
import { uniConnection } from "./uniConnection";
import {
  invalidateLibraryMembership,
  previewEntries,
  resolveLibraryMembership,
  toLiteratureCandidate,
  type LiteratureCandidate,
  type LiteratureCollectionPaper,
  type LiteratureCollectionScope,
  type LiteratureCollectionSnapshot,
  type LiteratureGraphNode,
  type LiteratureGraphView,
  type LiteratureLoadStatus,
  type LiteratureRelationKind,
  type LiteratureSnapshot,
  type LiteratureSourceView,
} from "./literatureRelations";
import { createDiscoveredPaper } from "../zotero/literatureItemAdapter";
import {
  literatureCandidateFromItem,
  literatureItemsInScope,
  literaturePaperMetadata,
} from "../zotero/literatureCollectionAdapter";
const SECTION_PREVIEW_LIMIT = 5;
const EXPLORER_COUPLING_LIMIT = 50;

/**
 * Collapse a provider's free-text diagnostic ("ok count=12", "error: HTTP 429",
 * "skipped (no DOI)") into one of the fixed states the explorer's progress pills
 * render. Anything unrecognised — including the empty pre-fetch state — reads as
 * still pending.
 */
function normalizeProgress(status: string | undefined): string {
  const value = String(status || "").toLowerCase();
  if (!value || value === "pending") { return "pending"; }
  if (value.startsWith("ok")) { return "ok"; }
  if (value === "empty") { return "empty"; }
  if (value === "restricted" || value === "unavailable") { return "restricted"; }
  if (value.startsWith("error")) { return "error"; }
  if (value.startsWith("skipped")) { return "skipped"; }
  return "pending";
}

type ExplorerOpener = (
  mainWindow: Window,
  item: Zotero.Item,
  kind: LiteratureRelationKind,
) => void;

export default class Views {
  public utils!: Utils;
  private registeredPaneID?: string;
  private registeredCitationsPaneID?: string;
  /** Every section rebuild produces fresh DOM, so the selected tab has to live on
   *  the instance to survive one. */
  private lastActiveTab: "references" | "citations" = "references";
  /** Which route the last reference load took; read back by UniZeroDebug(). */
  private lastLoadDiagnostic: any = null;
  /** The same, for the Citations route. */
  private lastCitationsDiagnostic: any = null;
  private explorerOpener?: ExplorerOpener;
  private explorerReferences = new Map<string, ReferencesCache>();
  private explorerCitations = new Map<string, CitationsCache>();
  constructor() {
    initLocale();
    this.utils = new Utils()
  }

  public setExplorerOpener(opener: ExplorerOpener): void {
    this.explorerOpener = opener;
  }

  public onWindowLoad(win: Window): void {
    this.addStyle(win.document);
  }

  public onWindowUnload(win: Window): void {
    win.document.getElementById("reference-style")?.remove();
  }

  private addStyle(targetDocument: Document) {
    if (targetDocument.getElementById("reference-style")) { return; }
    const styles = ztoolkit.UI.createElement(targetDocument, "style", {
      id: "reference-style",
      namespace: "html",
      properties: {
        innerHTML: `
          .zoference-section {
            width: 100%;
            box-sizing: border-box;
            color: var(--fill-primary, inherit);
          }
          .zoference-section .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 4px 8px 8px;
          }
          .zoference-section .header button {
            min-height: 24px;
          }
          .zoference-section .reference-grid {
            display: grid;
            align-items: center;
            overflow: hidden;
          }
          .zoference-section .box[data-library-state="in"] {
            border-left: 3px solid var(--accent-green, #57ab5a);
            background: color-mix(in srgb, var(--accent-green, #57ab5a) 10%, transparent);
            opacity: 1 !important;
          }
          .zoference-section .box[data-library-state="out"] {
            border-left: 3px solid var(--accent-orange, #d29922);
            background: color-mix(in srgb, var(--accent-orange, #d29922) 7%, transparent);
          }
          .zoference-section .literature-open {
            display: block;
            margin: 8px;
            padding: 5px 10px;
            border-radius: 5px;
            cursor: pointer;
            text-align: center;
            font-weight: 600;
            color: var(--accent-blue, #2f6fca);
            background: var(--fill-quinary, rgb(128 128 128 / 10%));
          }
          .zoference-section .literature-open:hover {
            background: var(--fill-quarternary, rgb(128 128 128 / 20%));
          }
          .zoference-section .reference-tabs {
            display: flex;
            gap: 2px;
            padding: 2px 6px 6px;
            border-bottom: 1px solid var(--material-border, #d8d8d8);
            margin-bottom: 6px;
          }
          .zoference-section .reference-tab {
            flex: 1;
            min-height: 24px;
            background: transparent;
            border: none;
            border-radius: 4px;
            padding: 3px 8px;
            cursor: pointer;
            color: inherit;
            opacity: 0.65;
          }
          .zoference-section .reference-tab:hover {
            background: var(--fill-quinary, rgb(128 128 128 / 12%));
            opacity: 0.85;
          }
          .zoference-section .reference-tab.active {
            background: var(--fill-quarternary, rgb(128 128 128 / 20%));
            font-weight: 600;
            opacity: 1;
          }
          /* Do not rely on the UA stylesheet's handling of [hidden]: this section
             lives in Zotero's XHTML main window, so hiding has to be decided by
             our own rules or switching tabs looks like it did nothing. */
          .zoference-section .reference-tab-pane[hidden],
          .zoference-section .reference-tab-pane.is-hidden {
            display: none !important;
          }
          /* In-panel status bar: messages appear next to the action that caused
             them instead of flying to the bottom-right of the screen. */
          .zoference-section .reference-status {
            display: flex;
            align-items: center;
            gap: 6px;
            position: relative;
            margin: 0 6px 6px;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.9em;
            line-height: 1.4;
            background: var(--fill-quinary, rgb(128 128 128 / 12%));
            border-left: 3px solid var(--fill-tertiary, rgb(128 128 128 / 45%));
          }
          .zoference-section .reference-status[data-type="success"] {
            border-left-color: var(--accent-green, #57ab5a);
          }
          .zoference-section .reference-status[data-type="fail"] {
            border-left-color: var(--accent-red, #e5534b);
          }
          .zoference-section .reference-status-headline {
            flex: none;
            font-weight: 600;
            opacity: 0.75;
          }
          .zoference-section .reference-status-text {
            flex: 1;
            min-width: 0;
            /* The status bar is a fixture one line tall: long text is truncated
               and never pushes the list down. */
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            opacity: 0.9;
          }
          .zoference-section .reference-status-progress {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 2px;
            border-radius: 0 0 4px 4px;
            overflow: hidden;
          }
          .zoference-section .reference-status-progress-bar {
            height: 100%;
            width: 0;
            background: var(--accent-blue, #4a8fe0);
            transition: width 0.2s ease;
          }
          .zoference-section .citations-more {
            display: block;
            width: calc(100% - 16px);
            margin: 8px;
            min-height: 24px;
          }
          .reference-search-box .icon {
            display: flex;
            justify-content: center;
            align-items: center;
            opacity: 0.8;
          }
          .reference-search-box .icon:hover {
            opacity: 1
          }
        `
      },
    });
    targetDocument.documentElement.appendChild(styles);
  }
  /**
   * Register the reading sidebar section.
   */
  public async onInit(win: Window = window) {
    this.onWindowLoad(win);
    // Log the version: the most time-consuming part of this round of debugging was
    // telling "the feature is broken" apart from "an old build is still installed".
    ztoolkit.log(`${config.addonName} ${version} registering item pane section`);
    (Zotero as any)[`${config.addonInstance}Version`] = version;
    // A debugging hatch: whether the cache saved anything and what, is invisible
    // from the UI, and guessing round by round is slow. Calling
    // `await Zotero.UniZeroDebug()` from Run JavaScript shows all of it at once.
    // Async because the cache is now a directory of per-item shards, which has to
    // be read to be reported on.
    (Zotero as any)[`${config.addonInstance}Debug`] = async () => ({
      version,
      referencesCacheEnabled: this.isCacheEnabled("saveAPIReferences"),
      citationsCacheEnabled: this.isCacheEnabled("saveCitations"),
      rawPrefs: {
        saveAPIReferences: Zotero.Prefs.get(`${config.addonRef}.saveAPIReferences`),
        saveCitations: Zotero.Prefs.get(`${config.addonRef}.saveCitations`),
        semanticScholarKey: Boolean(Zotero.Prefs.get(`${config.addonRef}.semanticScholar.apiKey`)),
      },
      cache: await localStorage.summary(),
      lastReferenceLoad: this.lastLoadDiagnostic,
      lastCitationsLoad: this.lastCitationsDiagnostic,
      citationsEngines: citationsDiagnostics,
      referencesEngines: referencesDiagnostics,
      connectionSync: addon.api.uniConnectionSync?.diagnostics(),
    });
    addon.api.uniConnection = uniConnection;
    const itemPaneManager = (Zotero as any).ItemPaneManager;
    if (!itemPaneManager?.registerSection) {
      throw new Error("Zotero.ItemPaneManager.registerSection is unavailable");
    }

    this.registeredPaneID = itemPaneManager.registerSection({
      paneID: "Reference",
      pluginID: config.addonRef,
      bodyXHTML: `
        <linkset>
          <html:link rel="localization" href="${config.addonRef}-addon.ftl"></html:link>
        </linkset>`,
      header: {
        l10nID: `${config.addonRef}-itemPaneSection-header`,
        icon: `chrome://${config.addonRef}/content/icons/reference.svg`,
      },
      sidenav: {
        l10nID: `${config.addonRef}-itemPaneSection-sidenav`,
        icon: `chrome://${config.addonRef}/content/icons/reference-sidenav.svg`,
      },
      onItemChange: ({ item, tabType, setEnabled }: any) => {
        // The reader may not have been added to Zotero.Reader yet when this hook
        // runs. Hiding the section based on getReader() therefore makes it stay
        // invisible for the lifetime of the tab in Zotero 8/9.
        setEnabled(["library", "reader"].includes(tabType) && Boolean(item));
      },
      onRender: ({ body, item, tabType }: any) => {
        if (!["library", "reader"].includes(tabType)) {
          body.querySelectorAll(".zoference-section").forEach((element: Element) => element.remove());
          return;
        }
        if (tabType === "library") {
          // ZoMiner references live in an attachment and need no Reader, so the
          // library view can render them fully.
          this.renderReferenceSection(body, item, undefined, true);
          return;
        }
        const reader = this.getReaderForBody(body);
        const attachment = reader && Zotero.Items.get((reader as any).itemID || (reader as any)._itemID);
        const parentItem = attachment?.parentItem || (item?.isAttachment?.() ? item.parentItem : item);
        if (!parentItem) { return; }
        this.renderReferenceSection(body, parentItem, reader);
      },
      onAsyncRender: async ({ body, item, tabType, setSectionSummary }: any) => {
        if (!["library", "reader"].includes(tabType)) { return; }
        const panel = body.querySelector(".zoference-section") as HTMLDivElement;
        if (!panel) { return; }
        const reader = (panel as any)._referenceReader || this.getReaderForBody(body);
        const parentItem = (panel as any)._referenceItem || item;
        // Auto-loading applies to the Reference tab only; Citations waits until
        // the user actually switches to it.
        const referencesPane = this.getPane(panel, "references");
        setSectionSummary("");
        try {
          // Bring this item's cache shard into memory before anything reads it.
          // Everything downstream — including the synchronous render path — then
          // hits memory, so only this one place has to be aware that the cache
          // lives in per-item files.
          if (parentItem) { await localStorage.load(parentItem); }
          // selectTab() ran during the synchronous render, when the shard was not
          // loaded yet, so a Citations tab restored from cache comes up empty.
          // Re-running it now is the restore; the guard inside skips the work when
          // the tab already has state.
          if (panel.dataset.activeTab === "citations") {
            this.selectTab(panel, "citations", true);
          }
          // The direct-DOI route and the ZoMiner attachment both work in either
          // tab type without a Reader, so auto-loading runs first; only when
          // neither source exists does it fall back to the PDF parsing path that
          // does need a Reader.
          await this.autoLoadReferences(referencesPane, parentItem);
          if (tabType === "reader" && reader && referencesPane.getAttribute("isAutoLoaded") !== "true") {
            await this.maybeAutoRefresh(referencesPane, parentItem, reader);
          }
        } catch (error) {
          ztoolkit.log("Reference section async render failed", error);
        }
      },
    }) as string
  }

  public onDestroy() {
    if (this.registeredPaneID) {
      (Zotero as any).ItemPaneManager?.unregisterSection(this.registeredPaneID);
      this.registeredPaneID = undefined;
    }
    delete (Zotero as any)[`${config.addonInstance}Version`];
    delete (Zotero as any)[`${config.addonInstance}Debug`];
  }

  // ------------------------------------------------------------- Local cache
  // Neither reference nor citation lists change from day to day, and the cost of
  // fetching again is very lopsided: the direct-DOI call is one or two requests,
  // while the expensive part is the hundreds of fuzzy-match requests that resolve
  // metadata afterwards. So the cache stores the results **after** resolution, and
  // a hit skips the network entirely.

  /**
   * The test is "not explicitly turned off" rather than "read back as true".
   *
   * The add-on's prefs.js only writes the default branch, so a version change, a
   * changed default, or unlucky install timing can all make `get` return
   * undefined. Treating that as "off" would silently disable the whole cache —
   * exactly the hardest kind of symptom to trace: the feature code is entirely
   * correct and simply was never allowed to run.
   */
  private isCacheEnabled(pref: "saveAPIReferences" | "saveCitations"): boolean {
    return Zotero.Prefs.get(`${config.addonRef}.${pref}`) !== false;
  }

  private readReferencesCache(item: Zotero.Item): ReferencesCache | undefined {
    if (!this.isCacheEnabled("saveAPIReferences")) { return; }
    const cached = localStorage.get(item, CACHE_KEY_REFERENCES) as ReferencesCache | undefined;
    if (!cached?.references?.length) { return; }
    const identifiers = readItemPaperIdentifiers(item);
    if (!cacheMatchesIdentifiers(cached, identifiers)) {
      return;
    }
    return cached;
  }

  private saveReferencesCache(
    item: Zotero.Item,
    source: string,
    references: ItemBaseInfo[],
    resolved: boolean,
    perSource?: RelationSourceResult[],
  ) {
    if (!references.length) { return; }
    const payload = makeReferencesCache(
      item,
      source,
      references,
      resolved,
      perSource,
    );
    this.explorerReferences.set(this.explorerKey(item), payload);
    if (!this.isCacheEnabled("saveAPIReferences")) { return; }
    localStorage.set(item, CACHE_KEY_REFERENCES, payload)
      // A cache write is not a Zotero item mutation and therefore emits no item
      // notification. Refresh a resident graph explicitly after the bytes land.
      .then(() => uniConnection.ingestItem(item, false))
      .catch((error) => ztoolkit.log("save references cache failed", error));
    if (this.lastLoadDiagnostic) {
      this.lastLoadDiagnostic.savedAt = new Date().toLocaleTimeString();
      this.lastLoadDiagnostic.savedResolved = resolved;
      this.lastLoadDiagnostic.savedCount = references.length;
    }
  }

  private readCitationsCache(item: Zotero.Item): CitationsCache | undefined {
    if (!this.isCacheEnabled("saveCitations")) { return; }
    const identifiers = readItemPaperIdentifiers(item);
    const cached = localStorage.get(item, CACHE_KEY_CITATIONS) as CitationsCache | undefined;
    if (!cached?.all?.length ||
        !cacheMatchesIdentifiers(cached, identifiers)) {
      return;
    }
    return cached;
  }

  private persistCitationsCache(item: Zotero.Item, state: CitationsCache): void {
    if (!state.all.length) { return; }
    this.explorerCitations.set(this.explorerKey(item), state);
    if (!this.isCacheEnabled("saveCitations")) { return; }
    localStorage.set(item, CACHE_KEY_CITATIONS, {
      ...state,
      savedAt: Date.now(),
      all: forPersistence(state.all, state.source),
      perSource: persistRelationSources(state.perSource),
    }).catch(
      (error) => ztoolkit.log("save citations cache failed", error),
    );
  }

  private saveCitationsCache(pane: HTMLDivElement) {
    const item = (pane as any)._referenceItem as Zotero.Item;
    const state = (pane as any)._citationsState as CitationsCache | undefined;
    if (!item || !state?.all?.length) { return; }
    this.persistCitationsCache(item, state);
  }

  /** Restore the whole Citations tab from cache, paging progress included. True on a hit. */
  private restoreCitationsFromCache(pane: HTMLDivElement): boolean {
    if (!this.isCacheEnabled("saveCitations")) { return false; }
    const item = (pane as any)._referenceItem as Zotero.Item;
    if (!item) { return false; }
    const cached = this.readCitationsCache(item);
    if (!cached) { return false; }
    (pane as any)._citationsState = { ...cached };
    pane.setAttribute("source", cached.source);
    const list = pane.querySelector(".reference-main-list .reference-grid") as HTMLDivElement;
    list.querySelectorAll("*").forEach((element) => element.remove());
    this.appendCitationRows(pane, cached.all);
    this.updateCitationsLabel(pane);
    const moreButton = pane.querySelector("#citations-more-button") as HTMLElement;
    if (moreButton) { this.setHidden(moreButton, cached.loaded >= cached.total); }
    return true;
  }

  private explorerKey(item: Zotero.Item): string {
    return `${item.libraryID}:${item.key}`;
  }

  private async candidatesWithMembership(
    libraryID: number,
    entries: ItemBaseInfo[],
  ): Promise<LiteratureCandidate[]> {
    // The library index is memoised, so resolving each source's list separately is
    // cheap CPU on one shared scan rather than one query per list.
    const memberships = await resolveLibraryMembership(libraryID, entries);
    return entries.map((entry) =>
      toLiteratureCandidate(entry, libraryID, memberships.get(entry)));
  }

  /**
   * Assemble the snapshot the explorer renders: the merged list plus each source's
   * own list and a summary row for the source picker. `perSource` is empty for
   * legacy shards written before the multi-source cache; the picker then offers
   * only the combined view until the next refresh repopulates it.
   */
  private async buildCombinedSnapshot(
    item: Zotero.Item,
    kind: LiteratureRelationKind,
    merged: ItemBaseInfo[],
    perSource: RelationSourceResult[],
    total: number,
    hasMore: boolean,
    source: string,
  ): Promise<LiteratureSnapshot> {
    const bySource: Partial<Record<RelationSourceKey, LiteratureCandidate[]>> = {};
    const sources: LiteratureSourceView[] = [];
    for (const entry of perSource) {
      if (entry.entries.length) {
        bySource[entry.key] = await this.candidatesWithMembership(
          item.libraryID,
          entry.entries,
        );
      }
      sources.push({
        key: entry.key,
        name: entry.name,
        status: entry.status,
        count: entry.entries.length,
        total: entry.total,
        hasMore: Boolean(entry.hasMore),
      });
    }
    return {
      kind,
      seed: {
        libraryID: item.libraryID,
        itemKey: item.key,
        title: String(item.getField("title") || ""),
      },
      source,
      total,
      loaded: merged.length,
      hasMore,
      items: await this.candidatesWithMembership(item.libraryID, merged),
      sources,
      bySource,
    };
  }

  private relationLoadStatus(
    item: Zotero.Item,
    kind: LiteratureRelationKind,
  ): LiteratureLoadStatus {
    const key = this.explorerKey(item);
    if (kind === "references") {
      const state = this.readReferencesCache(item) || this.explorerReferences.get(key);
      return {
        loaded: Boolean(state),
        count: state?.references.length || 0,
        total: state?.references.length || 0,
        savedAt: state?.savedAt,
      };
    }
    const state = this.readCitationsCache(item) || this.explorerCitations.get(key);
    return {
      loaded: Boolean(state),
      count: state?.loaded || state?.all.length || 0,
      total: state?.total || 0,
      savedAt: state?.savedAt,
    };
  }

  public async getLiteratureCollectionPaper(
    item: Zotero.Item,
  ): Promise<LiteratureCollectionPaper> {
    await localStorage.load(item);
    return {
      ...literaturePaperMetadata(item),
      references: this.relationLoadStatus(item, "references"),
      citations: this.relationLoadStatus(item, "citations"),
    };
  }

  /**
   * Cache-only re-read of both relations' loaded state, for the explorer to refresh
   * a collection row without re-probing metadata/PDF/Markdown. Catches loads made
   * elsewhere (the item pane, an earlier session) that the overview snapshot missed.
   */
  public async relationStatuses(
    item: Zotero.Item,
  ): Promise<{ references: LiteratureLoadStatus; citations: LiteratureLoadStatus }> {
    await localStorage.load(item);
    return {
      references: this.relationLoadStatus(item, "references"),
      citations: this.relationLoadStatus(item, "citations"),
    };
  }

  /**
   * A live snapshot of how each source is faring in the most recent fetch, read
   * straight from the diagnostics the providers update as they resolve. The explorer
   * polls this while a load is in flight to show per-source progress. Statuses are
   * normalised to a small vocabulary the view can render without parsing free text.
   */
  public relationProgress(
    kind: LiteratureRelationKind,
  ): { key: RelationSourceKey; status: string }[] {
    if (kind === "relation") { return []; }
    const diagnostics: Partial<Record<RelationSourceKey, string | undefined>> =
      kind === "references"
        ? {
          openAlex: referencesDiagnostics.openAlex,
          crossref: referencesDiagnostics.crossref,
          semanticScholar: referencesDiagnostics.semanticScholar,
        }
        : {
          openAlex: citationsDiagnostics.openAlex,
          semanticScholar: citationsDiagnostics.semanticScholar,
        };
    const order: RelationSourceKey[] = kind === "references"
      ? ["openAlex", "crossref", "semanticScholar"]
      : ["openAlex", "semanticScholar"];
    return order.map((key) => ({ key, status: normalizeProgress(diagnostics[key]) }));
  }

  /**
   * Collection overview for the independent explorer. This is deliberately a
   * status-only read: opening the workbench does not fetch scholarly-provider
   * data or start conversions for every paper in a Collection.
   */
  public async getLiteratureCollectionSnapshot(
    scope: LiteratureCollectionScope,
  ): Promise<LiteratureCollectionSnapshot> {
    const items = await literatureItemsInScope(scope);
    const papers: LiteratureCollectionPaper[] = [];
    // Loading in small batches avoids opening hundreds of cache files at once for
    // a large library while still keeping the initial overview responsive.
    for (let offset = 0; offset < items.length; offset += 16) {
      papers.push(...await Promise.all(
        items.slice(offset, offset + 16)
          .map((item) => this.getLiteratureCollectionPaper(item)),
      ));
    }
    return { scope, items: papers };
  }

  /**
   * Whole-library graph for the explorer's overview.
   *
   * UniConnection supplies topology for the entire library; a Collection scope
   * then narrows it to that Collection's papers, dropping edges whose other end
   * falls outside. Metadata comes from literaturePaperMetadata, the same helper
   * behind the collection table, so a node and its row always agree.
   */
  public async getLiteratureGraph(
    scope: LiteratureCollectionScope,
  ): Promise<LiteratureGraphView> {
    const graph = await uniConnection.libraryGraph(scope.libraryID);
    const items = await literatureItemsInScope(scope);
    const byScopedKey = new Map<string, Zotero.Item>();
    for (const item of items) {
      byScopedKey.set(`${item.libraryID}:${item.key}`, item);
    }
    const nodes = graph.nodes
      .filter((node) => byScopedKey.has(node.id))
      .map((node) => this.graphNode(node, byScopedKey.get(node.id)!));
    const present = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter(
      (edge) => present.has(edge.source) && present.has(edge.target),
    );
    return { scope: { libraryID: scope.libraryID }, nodes, edges };
  }

  /** One paper's in-library neighbourhood, enriched the same way. */
  public async getLiteratureEgoGraph(
    item: Zotero.Item,
  ): Promise<LiteratureGraphView> {
    const graph = await uniConnection.egoGraph(item, {
      couplingLimit: EXPLORER_COUPLING_LIMIT,
    });
    const nodes: LiteratureGraphNode[] = [];
    for (const node of graph.nodes) {
      const resolved = Zotero.Items.getByLibraryAndKey(
        item.libraryID,
        node.itemKey,
      ) as Zotero.Item | false;
      // A node whose item vanished between index and render is dropped rather
      // than drawn as an unopenable ghost.
      if (!resolved || resolved.deleted) { continue; }
      nodes.push(this.graphNode(node, resolved));
    }
    const present = new Set(nodes.map((entry) => entry.id));
    return {
      scope: { libraryID: item.libraryID },
      nodes,
      edges: graph.edges.filter(
        (edge) => present.has(edge.source) && present.has(edge.target),
      ),
      center: graph.center,
    };
  }

  /**
   * Saved force-layout coordinates for a library's graph.
   *
   * Purely a starting position for the simulation: a stale or partial layout
   * settles into the right shape anyway, so this is never validated against the
   * current graph.
   */
  public async getGraphLayout(libraryID: number): Promise<Record<string, number[]>> {
    const payload = await localStorage.readGraphLayout(libraryID);
    const positions = payload?.positions;
    return positions && typeof positions === "object" ? positions : {};
  }

  public async saveGraphLayout(
    libraryID: number,
    positions: Record<string, number[]>,
  ): Promise<void> {
    await localStorage.writeGraphLayout(libraryID, {
      savedAt: Date.now(),
      positions,
    });
  }

  private graphNode(
    node: { id: string; itemKey: string; degree: number; isCenter?: boolean },
    item: Zotero.Item,
  ): LiteratureGraphNode {
    const metadata = literaturePaperMetadata(item);
    return {
      id: node.id,
      itemKey: node.itemKey,
      itemID: metadata.itemID,
      degree: node.degree,
      isCenter: node.isCenter,
      title: metadata.title,
      creators: metadata.creators,
      year: metadata.year,
      publicationTitle: metadata.publicationTitle,
      hasPDF: metadata.hasPDF,
      hasMarkdown: metadata.hasMarkdown,
    };
  }

  /**
   * Shared data entry point for the item-pane preview and the independent
   * Literature Explorer. It reads the same per-item shards as the section; when a
   * shard is missing it fetches through the established providers and writes the
   * normal cache shape, so opening the large view never creates a parallel source
   * of truth.
   */
  public async getLiteratureSnapshot(
    item: Zotero.Item,
    kind: LiteratureRelationKind,
    refresh = false,
  ): Promise<LiteratureSnapshot> {
    if (kind === "relation") {
      return this.getUniConnectionSnapshot(item, refresh);
    }
    await localStorage.load(item);
    const key = this.explorerKey(item);
    const identifiers = readItemPaperIdentifiers(item);

    if (kind === "references") {
      let state = refresh
        ? undefined
        : (this.readReferencesCache(item) || this.explorerReferences.get(key));
      if (!state) {
        const result = await fetchReferencesByIdentifiers(
          identifiers.doi,
          identifiers.semanticScholarPaperId,
        );
        let references = result?.references || [];
        let source = result?.source || "none";
        if (!references.length) {
          const extracted = await readZoMinerReferences(item);
          if (extracted?.length) {
            references = extracted.map((reference) => {
              const parsed = this.utils.refText2Info(reference.text || "");
              return {
                ...parsed,
                ...reference,
                title: reference.title || parsed.title,
                authors: reference.authors?.length ? reference.authors : parsed.authors,
                year: reference.year || parsed.year,
                identifiers: {
                  ...this.utils.getIdentifiers(reference.text || ""),
                  ...reference.identifiers,
                },
              };
            });
            source = "ZoMiner";
          }
        }
        state = {
          savedAt: Date.now(),
          source,
          doi: identifiers.doi || "",
          semanticScholarPaperId: identifiers.semanticScholarPaperId,
          resolved: true,
          references,
          perSource: result?.perSource,
        };
        this.explorerReferences.set(key, state);
        if (state.references.length) {
          this.saveReferencesCache(
            item,
            state.source,
            state.references,
            state.resolved,
            state.perSource,
          );
        }
      }
      // Upgrade Crossref "DOI-only" rows to real bibliographic data. The item-pane
      // box does this through resolveReferences; the explorer path returns records
      // instead of mutating rows, so without this those entries display a bare DOI
      // forever. No-op once the placeholders are filled, so reopening is cheap.
      await this.fillReferencePlaceholders(item, state);
      return this.buildCombinedSnapshot(
        item,
        kind,
        state.references,
        state.perSource || [],
        state.references.length,
        false,
        state.source,
      );
    }

    let state = refresh
      ? undefined
      : (this.readCitationsCache(item) || this.explorerCitations.get(key));
    if (!state) {
      const result = await fetchCitationsByIdentifiers(
        identifiers.doi,
        identifiers.semanticScholarPaperId,
      );
      state = {
        savedAt: Date.now(),
        doi: identifiers.doi || "",
        semanticScholarPaperId: identifiers.semanticScholarPaperId,
        source: result?.source || "OpenAlex",
        openAlexFilter: result?.openAlexFilter,
        page: result ? 1 : 0,
        loaded: result?.citations.length || 0,
        total: result?.total || 0,
        all: result?.citations || [],
        perSource: result?.perSource,
      };
      this.explorerCitations.set(key, state);
      if (state.all.length) { this.persistCitationsCache(item, state); }
    }
    return this.buildCombinedSnapshot(
      item,
      kind,
      state.all,
      state.perSource || [],
      state.total,
      this.citationsHasMore(state),
      state.source,
    );
  }

  /**
   * Read-only projection of the derived library graph.
   *
   * The normal path reuses the lazily built in-memory index. Refresh explicitly
   * rebuilds that index from existing References-Resolved-v4 shards, and neither
   * path fetches providers or writes cache records.
   */
  private async getUniConnectionSnapshot(
    item: Zotero.Item,
    rebuild: boolean,
  ): Promise<LiteratureSnapshot> {
    if (rebuild) { await uniConnection.build(item.libraryID); }
    const [relations, coupling] = await Promise.all([
      uniConnection.relationsOf(item),
      uniConnection.coupledWith(item, EXPLORER_COUPLING_LIMIT),
    ]);
    const prefix = `${item.libraryID}:`;
    const matches = new Map<
      string,
      { zoteroItem: Zotero.Item; cites: boolean; shared: number }
    >();
    const resolveItem = (scopedKey: string): Zotero.Item | undefined => {
      if (!scopedKey.startsWith(prefix)) { return; }
      const itemKey = scopedKey.slice(prefix.length);
      if (!itemKey) { return; }
      const candidate = Zotero.Items.getByLibraryAndKey(
        item.libraryID,
        itemKey,
      ) as Zotero.Item | false;
      if (!candidate || candidate.deleted || !candidate.isRegularItem?.()) {
        return;
      }
      return candidate;
    };

    for (const relation of relations) {
      const zoteroItem = resolveItem(relation.scopedKey);
      if (zoteroItem) {
        matches.set(relation.scopedKey, { zoteroItem, cites: true, shared: 0 });
      }
    }
    for (const hit of coupling) {
      const zoteroItem = resolveItem(hit.scopedKey);
      if (!zoteroItem) { continue; }
      const existing = matches.get(hit.scopedKey);
      if (existing) {
        existing.shared = hit.shared;
      } else {
        matches.set(hit.scopedKey, {
          zoteroItem,
          cites: false,
          shared: hit.shared,
        });
      }
    }

    const items = [...matches.values()]
      .sort((left, right) =>
        Number(right.cites) - Number(left.cites) ||
        right.shared - left.shared ||
        String(left.zoteroItem.getField("title") || "").localeCompare(
          String(right.zoteroItem.getField("title") || ""),
        ))
      .map((match, sourceOrder) => ({
        ...literatureCandidateFromItem(match.zoteroItem),
        sourceOrder,
        relationTypes: [
          ...(match.cites ? ["cites" as const] : []),
          ...(match.shared > 0 ? ["coupled" as const] : []),
        ],
        sharedReferences: match.shared,
      }));

    return {
      kind: "relation",
      seed: {
        libraryID: item.libraryID,
        itemKey: item.key,
        title: String(item.getField("title") || ""),
      },
      source: "UniConnection",
      total: items.length,
      loaded: items.length,
      hasMore: false,
      items,
      sources: [],
      bySource: {},
    };
  }

  /** Combined "load more" is exhausted only when no source has another page. */
  private citationsHasMore(state: CitationsCache): boolean {
    if (state.perSource?.length) { return state.perSource.some((entry) => entry.hasMore); }
    return state.loaded < state.total;
  }

  public async loadMoreLiteratureCitations(item: Zotero.Item): Promise<LiteratureSnapshot> {
    await localStorage.load(item);
    const key = this.explorerKey(item);
    let state = this.readCitationsCache(item) || this.explorerCitations.get(key);
    if (!state) {
      return this.getLiteratureSnapshot(item, "citations");
    }
    if (state.perSource?.length) {
      // Advance every source that still has pages, then re-merge so the combined
      // order and dedup stay consistent as new pages arrive.
      const captured = state;
      const advanced = await Promise.all(state.perSource.map(async (entry) => {
        if (!entry.hasMore) { return entry; }
        const next = await fetchCitationSource(
          entry.key,
          captured.doi,
          captured.semanticScholarPaperId,
          (entry.page || 1) + 1,
          entry.openAlexFilter,
        );
        if (!next.entries.length) { return { ...entry, hasMore: false }; }
        return {
          ...entry,
          entries: [...entry.entries, ...next.entries],
          page: next.page ?? (entry.page || 1) + 1,
          total: next.total || entry.total,
          hasMore: Boolean(next.hasMore),
          openAlexFilter: next.openAlexFilter || entry.openAlexFilter,
        };
      }));
      const merged = mergeRelationSources(advanced, ["openAlex", "semanticScholar"]);
      state = {
        ...state,
        perSource: advanced,
        all: merged,
        loaded: merged.length,
        total: Math.max(state.total, ...advanced.map((entry) => entry.total)),
        page: Math.max(0, ...advanced.map((entry) => entry.page || 0)),
      };
      this.explorerCitations.set(key, state);
      this.persistCitationsCache(item, state);
    } else if (state.loaded < state.total) {
      // Legacy single-source shard without per-source paging.
      const result = await fetchCitationsPage(
        state.doi,
        state.page + 1,
        state.source,
        state.openAlexFilter,
        state.semanticScholarPaperId,
      );
      if (result?.citations.length) {
        state = {
          ...state,
          page: state.page + 1,
          loaded: state.loaded + result.citations.length,
          all: [...state.all, ...result.citations],
        };
        this.explorerCitations.set(key, state);
        this.persistCitationsCache(item, state);
      }
    }
    return this.buildCombinedSnapshot(
      item,
      "citations",
      state.all,
      state.perSource || [],
      state.total,
      this.citationsHasMore(state),
      state.source,
    );
  }

  /**
   * Re-query one provider and fold the fresh list back into the combined view,
   * leaving the other sources untouched. This is the per-source Refresh in the
   * explorer: a flaky Crossref response can be retried without paying for OpenAlex
   * and Semantic Scholar again.
   */
  public async refreshLiteratureSource(
    item: Zotero.Item,
    kind: LiteratureRelationKind,
    sourceKey: RelationSourceKey,
  ): Promise<LiteratureSnapshot> {
    if (kind === "relation") {
      throw new Error("Relation is a local derived view and has no provider source");
    }
    await localStorage.load(item);
    const key = this.explorerKey(item);
    const identifiers = readItemPaperIdentifiers(item);

    if (kind === "references") {
      const previous = this.readReferencesCache(item) || this.explorerReferences.get(key);
      const fresh = await fetchReferenceSource(
        sourceKey,
        identifiers.doi,
        identifiers.semanticScholarPaperId,
      );
      const perSource = this.replaceSource(previous?.perSource, fresh);
      const references = mergeRelationSources(perSource, [
        "crossref",
        "openAlex",
        "semanticScholar",
      ]);
      const next: ReferencesCache = {
        savedAt: Date.now(),
        source: this.combinedSourceName(perSource),
        doi: identifiers.doi || "",
        semanticScholarPaperId: identifiers.semanticScholarPaperId,
        resolved: true,
        references,
        perSource,
      };
      this.explorerReferences.set(key, next);
      if (references.length) {
        this.saveReferencesCache(item, next.source, references, true, perSource);
      }
      return this.buildCombinedSnapshot(
        item,
        kind,
        references,
        perSource,
        references.length,
        false,
        next.source,
      );
    }

    const previous = this.readCitationsCache(item) || this.explorerCitations.get(key);
    const fresh = await fetchCitationSource(
      sourceKey,
      identifiers.doi,
      identifiers.semanticScholarPaperId,
    );
    const perSource = this.replaceSource(previous?.perSource, fresh);
    const all = mergeRelationSources(perSource, ["openAlex", "semanticScholar"]);
    const next: CitationsCache = {
      savedAt: Date.now(),
      doi: identifiers.doi || "",
      semanticScholarPaperId: identifiers.semanticScholarPaperId,
      source: this.combinedSourceName(perSource),
      openAlexFilter: perSource.find((entry) => entry.key === "openAlex")?.openAlexFilter,
      page: Math.max(0, ...perSource.map((entry) => entry.page || 0)),
      loaded: all.length,
      total: Math.max(0, ...perSource.map((entry) => entry.total)),
      all,
      perSource,
    };
    this.explorerCitations.set(key, next);
    if (all.length) { this.persistCitationsCache(item, next); }
    return this.buildCombinedSnapshot(
      item,
      "citations",
      all,
      perSource,
      next.total,
      this.citationsHasMore(next),
      next.source,
    );
  }

  /** Swap one source's result into a per-source list, keeping a stable order. */
  private replaceSource(
    existing: RelationSourceResult[] | undefined,
    fresh: RelationSourceResult,
  ): RelationSourceResult[] {
    const order: RelationSourceKey[] = ["openAlex", "crossref", "semanticScholar"];
    const list = (existing || []).filter((entry) => entry.key !== fresh.key);
    list.push(fresh);
    return list.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }

  private combinedSourceName(perSource: RelationSourceResult[]): string {
    const contributing = perSource.filter((entry) => entry.entries.length);
    return contributing.length > 1 ? "Combined" : (contributing[0]?.name || "none");
  }

  public async addLiteratureCandidateToLibrary(
    seed: Zotero.Item,
    candidate: LiteratureCandidate,
  ): Promise<LiteratureCandidate["membership"]> {
    const entry: ItemBaseInfo = {
      identifiers: { ...(candidate.identifiers || {}) },
      title: candidate.title,
      authors: [...(candidate.authors || [])],
      year: candidate.year,
      type: candidate.type || "journalArticle",
      text: candidate.text || candidate.title,
      url: candidate.url,
      primaryVenue: candidate.primaryVenue,
      abstract: candidate.abstract,
      citations: candidate.citationCount,
    };
    const existing = (await resolveLibraryMembership(seed.libraryID, [entry])).get(entry);
    if (existing) {
      return { inLibrary: true, libraryID: seed.libraryID, itemID: existing.id };
    }

    const created = await createDiscoveredPaper(seed, {
      identifiers: {
        DOI: entry.identifiers.DOI,
        arXiv: entry.identifiers.arXiv,
      },
      title: entry.title || entry.text || "Untitled",
      authors: entry.authors,
      year: entry.year,
      type: entry.type,
      url: entry.url,
      abstract: entry.abstract,
    });
    // The memoised membership index would otherwise keep reporting this paper as
    // absent until its TTL lapses; drop it so the next resolve sees the new item.
    invalidateLibraryMembership(seed.libraryID);
    return { inLibrary: true, libraryID: seed.libraryID, itemID: created.id };
  }

  /**
   * Fetch and render the papers citing this one.
   *
   * @param pane   The Citations tab's container, not the whole section: both tabs
   *               contain `#reference-num` and `.reference-grid`, so the scope has
   *               to be narrowed to this tab or the Reference tab's count and list
   *               get modified instead.
   * @param silent Auto-rendering shows no message and only a manual refresh gives
   *               feedback; otherwise expanding the section pops one up every time.
   */
  public async refreshCitations(
    pane: HTMLDivElement,
    silent: boolean = false,
    useCache: boolean = true,
  ) {
    const item = (pane as any)._referenceItem as Zotero.Item;
    if (!item) { return; }
    await localStorage.load(item);
    // A manual refresh passes useCache=false: that click means "give me the latest".
    if (useCache && this.restoreCitationsFromCache(pane)) { return; }
    const label = pane.querySelector("#reference-num") as HTMLSpanElement;
    const list = pane.querySelector(".reference-main-list .reference-grid") as HTMLDivElement;
    list.querySelectorAll("*").forEach((element) => element.remove());
    const moreButton = pane.querySelector("#citations-more-button") as HTMLElement;
    if (moreButton) { this.setHidden(moreButton, true); }

    const identifiers = readItemPaperIdentifiers(item);
    const doi = identifiers.doi || "";
    const semanticScholarPaperId = identifiers.semanticScholarPaperId || "";
    this.lastCitationsDiagnostic = {
      at: new Date().toLocaleTimeString(),
      itemKey: item.key,
      doi,
      semanticScholarPaperId,
      useCache,
      cacheEnabled: this.isCacheEnabled("saveCitations"),
      stage: "start",
    };
    if (!doi && !semanticScholarPaperId) {
      label.innerText = getString("citationsbox-no-identifier-label");
      this.lastCitationsDiagnostic.stage = "no-identifier";
      return;
    }

    label.innerText = getString("citationsbox-loading-label");
    let result;
    try {
      result = await fetchCitationsByIdentifiers(doi, semanticScholarPaperId);
    } catch (error) {
      // There used to be no catch here: on a throw the count froze forever at
      // "loading citations…", which looked like a hang while not a word of the
      // actual reason ever surfaced.
      this.lastCitationsDiagnostic.stage = "threw";
      this.lastCitationsDiagnostic.error = String(error);
      label.innerText = `${getString("citationsbox-number-label")} — ${String(error).slice(0, 80)}`;
      ztoolkit.log("refreshCitations failed", error);
      return;
    }
    this.lastCitationsDiagnostic.stage = result ? "fetched" : "empty";
    this.lastCitationsDiagnostic.total = result?.total;
    this.lastCitationsDiagnostic.source = result?.source;
    this.lastCitationsDiagnostic.pageSize = result?.citations.length;
    const citationFailures = [
      ["OpenAlex", citationsDiagnostics.openAlex],
      ["Semantic Scholar", citationsDiagnostics.semanticScholar],
    ].filter(([, status]) => String(status || "").startsWith("error:"));
    label.title = `OpenAlex: ${citationsDiagnostics.openAlex}
Semantic Scholar (${citationsDiagnostics.semanticScholarLookup || "no identifier"}): ${citationsDiagnostics.semanticScholar}`;
    this.lastCitationsDiagnostic.engines = { ...citationsDiagnostics };
    if (!result) {
      label.innerText = `0 ${getString("citationsbox-number-label")}`;
      if (!silent) {
        new PanelStatus("Citations")
          .createLine({
            text: citationFailures.length
              ? `Citation lookup incomplete: ${citationFailures.map(([source]) => source).join(", ")} failed`
              : "No citations found",
            type: citationFailures.length ? "fail" : "default",
          })
          .show();
      }
      return;
    }

    // Paging state hangs on the pane: a later "Load more" must reuse the engine
    // and filter chosen for the first page, since switching engines duplicates or
    // skips entries because the two order results differently.
    (pane as any)._citationsState = {
      doi,
      semanticScholarPaperId,
      source: result.source,
      openAlexFilter: result.openAlexFilter,
      page: 1,
      loaded: result.citations.length,
      total: result.total,
      all: [...result.citations],
      perSource: result.perSource,
    };
    pane.setAttribute("source", result.source);
    try {
      this.appendCitationRows(pane, result.citations);
      this.updateCitationsLabel(pane);
    } catch (error) {
      // Fetched but unrenderable is a different problem from never fetched, and
      // the two have to be distinguishable.
      this.lastCitationsDiagnostic.stage = "render-failed";
      this.lastCitationsDiagnostic.error = String(error);
      label.innerText = `${result.total} ${getString("citationsbox-number-label")} (render failed)`;
      ztoolkit.log("appendCitationRows failed", error);
      return;
    }
    this.lastCitationsDiagnostic.stage = "rendered";
    if (moreButton) { this.setHidden(moreButton, !result.hasMore); }
    this.saveCitationsCache(pane);

    if (!silent) {
      new PanelStatus(`[${result.source}]`)
        .createLine({
          text: citationFailures.length
            ? `${result.total} citations; ${citationFailures.map(([source]) => source).join(", ")} failed`
            : `${result.total} citations`,
          type: citationFailures.length ? "fail" : "success",
        })
        .show();
    }
  }

  /** "Load more": continue paging by descending citation count, appending to the list. */
  private async loadMoreCitations(pane: HTMLDivElement) {
    const state = (pane as any)._citationsState;
    if (!state) { return; }
    const moreButton = pane.querySelector("#citations-more-button") as HTMLElement;
    if (moreButton) {
      moreButton.style.pointerEvents = "none";
      moreButton.style.opacity = "0.5";
    }
    try {
      const result = await fetchCitationsPage(
        state.doi,
        state.page + 1,
        state.source,
        state.openAlexFilter,
        state.semanticScholarPaperId,
      );
      if (!result?.citations.length) {
        if (moreButton) { this.setHidden(moreButton, true); }
        return;
      }
      state.page += 1;
      state.loaded += result.citations.length;
      state.all.push(...result.citations);
      this.appendCitationRows(pane, result.citations);
      this.updateCitationsLabel(pane);
      if (moreButton) { this.setHidden(moreButton, !result.hasMore); }
      // Persist after every page: reopening the section on page 5 should not send
      // the user back to page 1.
      this.saveCitationsCache(pane);
    } finally {
      if (moreButton) {
        moreButton.style.pointerEvents = "";
        moreButton.style.opacity = "";
      }
    }
  }

  /**
   * Render one page of citations as rows.
   *
   * addRow reads `references[refIndex]`, so the whole accumulated array must be
   * passed in together with a global index rather than just this page — otherwise
   * in-row interactions read someone else's data.
   */
  private appendCitationRows(pane: HTMLDivElement, page: ItemBaseInfo[]) {
    const state = (pane as any)._citationsState;
    const container = pane.querySelector(".reference-main-list") as HTMLDivElement;
    const grid = container.querySelector(".reference-grid") as HTMLDivElement;
    grid.replaceChildren();
    const preview = previewEntries(state.all, SECTION_PREVIEW_LIMIT);
    preview.forEach((citation, index) => {
      const row = this.addRow(container, preview, index, true, false, false);
      if (row) {
        // @ts-ignore addRow binds this when it builds the row; rebind explicitly in
        // case addRow took its deduplication branch.
        row.box.reference = citation;
      }
    });
    const item = (pane as any)._referenceItem as Zotero.Item | undefined;
    if (item) { void this.markSectionLibraryState(container, preview, item); }
  }

  /** Show the count as "loaded/total", so it is clear this is the top pages, not everything. */
  private updateCitationsLabel(pane: HTMLDivElement) {
    const state = (pane as any)._citationsState;
    const label = pane.querySelector("#reference-num") as HTMLSpanElement;
    const suffix = getString("citationsbox-number-label");
    label.innerText = state.loaded < state.total
      ? `${state.loaded}/${state.total} ${suffix}`
      : `${state.total} ${suffix}`;
  }

  /** Resolve the reader that owns this item-pane section, not whichever tab is
   * globally selected at the instant a lifecycle hook happens to run. */
  private getReaderForBody(body?: Element): _ZoteroTypes.ReaderInstance | undefined {
    const itemDetails = body?.closest("item-details") as any;
    const tabID = itemDetails?.tabID || itemDetails?.dataset?.tabId;
    if (tabID) {
      const reader = Zotero.Reader.getByTabID(tabID);
      if (reader) { return reader; }
    }
    return this.utils.getReader();
  }

  private renderReferenceSection(
    body: HTMLDivElement,
    item: Zotero.Item,
    reader?: _ZoteroTypes.ReaderInstance,
    showReaderControls: boolean = true,
  ) {
    // Zotero calls onRender repeatedly — scrolling, pane resizing, and item
    // refreshes can all trigger it — while onAsyncRender is not guaranteed to run
    // again alongside it. Rebuilding unconditionally produces this: the list has
    // just loaded, a spare onRender wipes and rebuilds the DOM, auto-loading never
    // fires again, and the section sits empty from then on. That is exactly the
    // cause of "switch away and back in the library view, and Reference disappears
    // and never loads".
    const existing = body.querySelector(".zoference-section") as HTMLDivElement | null;
    if (existing && (existing as any)._referenceItem?.id === item.id) {
      if (reader) { (existing as any)._referenceReader = reader; }
      for (const name of ["references", "citations"] as const) {
        const pane = this.getPane(existing, name);
        (pane as any)._referenceItem = item;
        if (reader) { (pane as any)._referenceReader = reader; }
      }
      // onAsyncRender may not come round again, so trigger auto-loading here too.
      // It has its own isAutoLoaded gate, so an already-loaded pane makes no
      // duplicate requests.
      void this.autoLoadReferences(this.getPane(existing, "references"), item).catch(
        (error) => ztoolkit.log("auto load on re-render failed", error),
      );
      return;
    }
    body.querySelectorAll(".zoference-section").forEach((element) => element.remove());
    // Zotero's main window is an XHTML (XML) document: createElement produces XUL
    // elements and innerHTML goes through the XML parser. Elements must be created
    // in the XHTML namespace explicitly.
    const panel = body.ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    panel.className = "zoference-section";
    (panel as any)._referenceItem = item;
    if (reader) {
      (panel as any)._referenceReader = reader;
    }
    // Reference and Citations are two tabs of one section: the sidebar offers a
    // single icon, both sets of data always concern the same paper, and splitting
    // them into two sections would fragment the sidebar and the scroll position.
    panel.innerHTML = showReaderControls ? `
      <div class="reference-tab-pane" data-tab="references">
        <div class="reference-main-list">
          <div class="header">
            <span id="reference-num">0 ${getString("relatedbox-number-label")}</span>
            <div id="refresh-button" class="reference-button">${getString("relatedbox-refresh-label")}</div>
          </div>
          <div class="grid reference-grid"></div>
          <div class="literature-open" data-kind="references" role="button" tabindex="0">${getString("literature-open-references-label") || "View all references ⤢"}</div>
        </div>
      </div>
      <div class="reference-tab-pane is-hidden" data-tab="citations" hidden="hidden">
        <div class="reference-main-list">
          <div class="header">
            <span id="reference-num">0 ${getString("citationsbox-number-label")}</span>
            <div id="citations-refresh-button" class="reference-button">${getString("relatedbox-refresh-label")}</div>
          </div>
          <div class="grid reference-grid"></div>
          <div class="literature-open" data-kind="citations" role="button" tabindex="0">${getString("literature-open-citations-label") || "View all citations ⤢"}</div>
        </div>
      </div>` : `<div class="reference-empty-state"></div>`;
    body.append(panel);

    if (!showReaderControls) { return; }

    this.buildTabBar(panel);
    panel.querySelectorAll(".reference-button").forEach(
      (element) => this.styleAsButton(element as HTMLElement),
    );
    const referencesPane = this.getPane(panel, "references");
    const citationsPane = this.getPane(panel, "citations");
    // Each tab holds its own item context: the refresh* methods only look at their
    // own pane and never search the whole section.
    for (const pane of [referencesPane, citationsPane]) {
      (pane as any)._referenceItem = item;
      if (reader) { (pane as any)._referenceReader = reader; }
    }

    // Tab switching uses delegation plus mousedown in the capture phase: with a
    // click handler on each button, the tab simply stops responding whenever
    // Zotero's item pane swallows the click somewhere along the bubble path, or a
    // section rebuild loses the listener.
    const tabs = panel.querySelector(".reference-tabs") as HTMLDivElement;
    tabs.addEventListener("mousedown", (event: Event) => {
      const button = (event.target as HTMLElement)?.closest(".reference-tab") as HTMLElement | null;
      if (!button) { return; }
      event.preventDefault();
      this.selectTab(panel, button.dataset.tab as "references" | "citations");
    }, true);
    this.selectTab(panel, this.lastActiveTab, true);

    const countLabel = referencesPane.querySelector("#reference-num") as HTMLSpanElement;
    countLabel.addEventListener("dblclick", () => {
      const text = [...referencesPane.querySelectorAll(".reference-main-list .box #reference-label")]
        .map((element) => element.textContent || "")
        .filter(Boolean)
        .join("\n");
      if (!text) { return; }
      this.utils.copyText(text, false);
      new PanelStatus("Reference")
        .createLine({ text: "Copy all references", type: "success" })
        .show();
    });

    let timer: number | undefined;
    const refreshButton = referencesPane.querySelector("#refresh-button") as HTMLElement;
    refreshButton.addEventListener("mousedown", (event: MouseEvent) => {
      timer = window.setTimeout(async () => {
        timer = undefined;
        await this.refreshReferences(referencesPane, false);
      }, 1000);
    });
    refreshButton.addEventListener("mouseup", async (event: MouseEvent) => {
      if (!timer) { return; }
      window.clearTimeout(timer);
      timer = undefined;
      // Clicking refresh means wanting the latest: local=false bypasses the cache,
      // re-runs the direct-DOI route, and overwrites what was stored.
      await this.refreshReferences(referencesPane, false);
    });
    refreshButton.addEventListener("mouseleave", () => {
      if (timer) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    });

    const citationsRefresh = citationsPane.querySelector("#citations-refresh-button") as HTMLElement;
    citationsRefresh.addEventListener("click", async () => {
      await this.refreshCitations(citationsPane, false, false);
    });
    panel.querySelectorAll(".literature-open").forEach((element) => {
      const open = () => {
        const kind = (element as HTMLElement).dataset.kind as LiteratureRelationKind;
        const mainWindow = panel.ownerDocument.defaultView as Window | null;
        if (mainWindow && this.explorerOpener) {
          this.explorerOpener(mainWindow, item, kind);
        }
      };
      element.addEventListener("click", open);
      element.addEventListener("keydown", (event: Event) => {
        const keyboard = event as KeyboardEvent;
        if (keyboard.key === "Enter" || keyboard.key === " ") {
          keyboard.preventDefault();
          open();
        }
      });
    });
  }

  /**
   * Hide or show an element.
   *
   * Sets both the attribute and inline display: this section lives in Zotero's
   * XHTML main window, where whether the `hidden` attribute alone takes effect
   * depends on the host stylesheet, which is not worth betting on.
   */
  private setHidden(element: HTMLElement, hidden: boolean) {
    element.hidden = hidden;
    element.style.display = hidden ? "none" : "";
  }

  /**
   * Dress a div up as a button.
   *
   * Every button in this section is a div: `<button>` simply does not render in
   * Zotero 9's item pane — switching the tab bar from `<button>` to `<div>` made it
   * visible immediately, which is how this was found. The same cause kept
   * Citations' "Refresh" and "Load more" invisible.
   */
  private styleAsButton(element: HTMLElement) {
    element.style.cssText = [
      "display: inline-block", "padding: 3px 10px", "border-radius: 4px",
      "cursor: pointer", "user-select: none", "text-align: center",
      "font-size: inherit", "color: inherit", "white-space: nowrap",
      "border: 1px solid rgb(128 128 128 / 40%)", "background: rgb(128 128 128 / 10%)",
    ].join(";");
    element.addEventListener("mouseenter", () => {
      element.style.background = "rgb(128 128 128 / 22%)";
    });
    element.addEventListener("mouseleave", () => {
      element.style.background = "rgb(128 128 128 / 10%)";
    });
  }

  /**
   * Build the tab bar.
   *
   * Deliberately avoids innerHTML, `<button>`, and any reliance on the injected
   * stylesheet — each of the three could on its own explain a tab bar that does not
   * appear (XML fragment parsing, the host's button styling, a stylesheet that
   * never reached the item pane), and ruling them out one at a time takes several
   * rounds. Building divs through the DOM API with inline styles eliminates all
   * three at once.
   */
  private buildTabBar(panel: HTMLDivElement) {
    const doc = panel.ownerDocument;
    const create = (tag: string) =>
      doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;

    const bar = create("div");
    bar.className = "reference-tabs";
    bar.style.cssText = [
      "display: flex", "gap: 2px", "padding: 2px 6px 6px",
      "margin-bottom: 6px", "border-bottom: 1px solid rgb(128 128 128 / 30%)",
    ].join(";");

    for (const name of ["references", "citations"] as const) {
      const tab = create("div");
      tab.className = "reference-tab";
      tab.dataset.tab = name;
      tab.textContent = getString(name === "references" ? "tab-references-label" : "tab-citations-label")
        // When Fluent has no match, show a recognisable word rather than a blank
        // that looks like the tab bar failed to render.
        || (name === "references" ? "References" : "Citations");
      tab.style.cssText = [
        "flex: 1", "text-align: center", "padding: 4px 8px",
        "min-height: 20px", "border-radius: 4px", "cursor: pointer",
        "user-select: none", "font-size: inherit", "color: inherit",
      ].join(";");
      bar.append(tab);
    }

    panel.prepend(bar);
    ztoolkit.log("reference tab bar built", bar.childElementCount);
  }

  /**
   * Switch tabs.
   *
   * Hiding sets all three of the `hidden` attribute, the `is-hidden` class, and
   * inline display: this section lives in Zotero's XHTML main window, where any one
   * of them alone can be overridden by the host stylesheet, which looks like a
   * click that did nothing. The selection is recorded on
   * `panel.dataset.activeTab` so a section rebuild returns to the tab the user was
   * last on.
   */
  private selectTab(
    panel: HTMLDivElement,
    name: "references" | "citations",
    restoring: boolean = false,
  ) {
    panel.dataset.activeTab = name;
    panel.querySelectorAll(".reference-tab").forEach((element) => {
      const tab = element as HTMLElement;
      const active = tab.dataset.tab === name;
      tab.classList.toggle("active", active);
      // The active state is inline too: if the injected stylesheet never reached
      // the item pane, both tabs would look identical.
      tab.style.background = active ? "rgb(128 128 128 / 22%)" : "transparent";
      tab.style.fontWeight = active ? "600" : "normal";
      tab.style.opacity = active ? "1" : "0.7";
    });
    panel.querySelectorAll(".reference-tab-pane").forEach((element) => {
      const pane = element as HTMLElement;
      const hidden = pane.dataset.tab !== name;
      pane.hidden = hidden;
      pane.classList.toggle("is-hidden", hidden);
      pane.style.display = hidden ? "none" : "";
    });
    this.lastActiveTab = name;
    if (name !== "citations") { return; }
    const citationsPane = this.getPane(panel, "citations");
    if ((citationsPane as any)._citationsState) { return; }
    // Restoring the Citations tab after a section rebuild reads the cache only and
    // never the network: restoration happens passively, the user did not ask for a
    // refresh, and firing two API calls on every item change burns quota for
    // nothing.
    if (restoring) {
      if (!this.restoreCitationsFromCache(citationsPane)) {
        const label = citationsPane.querySelector("#reference-num") as HTMLSpanElement;
        label.innerText = getString("citationsbox-idle-label");
      }
      return;
    }
    // Data is fetched only when the user switches here deliberately: most of the
    // time only references are wanted, and two extra API calls on every expansion
    // are waste.
    void this.refreshCitations(citationsPane, true).catch(
      (error) => ztoolkit.log("citations lazy load failed", error),
    );
  }

  /** Get a tab's container; falls back to the section itself so older call sites do not throw. */
  private getPane(panel: HTMLDivElement, name: "references" | "citations"): HTMLDivElement {
    return (panel.querySelector(`.reference-tab-pane[data-tab="${name}"]`) as HTMLDivElement) || panel;
  }

  /**
   * Auto-load references when the section is expanded.
   *
   * The test is whether a usable data source exists, not whether a ZoMiner
   * attachment does: with the direct-DOI route in place, an item with a DOI needs
   * no attachment at all, and the old attachment test would shut all of them out.
   */
  private async autoLoadReferences(panel: HTMLDivElement, item: Zotero.Item) {
    if (!item) { return; }
    if (panel.getAttribute("isAutoLoaded") === "true") { return; }
    const hasSource = Boolean(item.getField("DOI")) || Boolean(findReferencesAttachment(item));
    if (!hasSource) { return; }
    panel.setAttribute("isAutoLoaded", "true");
    await this.refreshReferences(panel, true, true);
  }

  private async maybeAutoRefresh(
    panel: HTMLDivElement,
    item: Zotero.Item,
    reader: _ZoteroTypes.ReaderInstance,
  ) {
    if (!Zotero.Prefs.get(`${config.addonRef}.autoRefresh`)) { return; }
    if (panel.getAttribute("isAutoRefresh") === "true") { return; }
    const excludeItemTypes = String(
      Zotero.Prefs.get(`${config.addonRef}.notAutoRefreshItemTypes`) || "",
    ).split(/,\s*/);
    const itemType = item.itemType;
    if (!excludeItemTypes.includes(itemType)) {
      (panel as any)._referenceReader = reader;
      await this.refreshReferences(panel);
      panel.setAttribute("isAutoRefresh", "true");
    }
  }

  private async registerSplitButtons(reader: _ZoteroTypes.ReaderInstance) {
    let _window: any
    // @ts-ignore
    while (!(_window = reader?._iframeWindow?.wrappedJSObject)) {
      ztoolkit.log("wait...")
      await Zotero.Promise.delay(10)
    }
    const parent = _window.document.querySelector("#toolbarViewerLeft")!
    const ref = parent.querySelector("#pageNumber") as HTMLDivElement
    const styles = {
      backgroundSize: "16px 16px",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      width: "16px"
    }
    
    ztoolkit.UI.insertElementBefore({
      tag: "div",
      classList: ["splitToolbarButton"],
      children: [
        {
          tag: "button",
          namespace: "html",
          id: "split-horizontally",
          classList: ["toolbarButton"],
          styles: {
            backgroundImage: `url(chrome://${config.addonRef}/content/icons/horizontally.png)`,
            // backgroundImage: await Zotero.File.generateDataURI(
            //   `chrome://${config.addonRef}/content/icons/horizontally.png`, 'image/png'
            // ),
            marginRight: "1px",
            ...styles
          },
          attributes: {
            title: "Split Horizontally",
            tabindex: "-1",
          },
          listeners: [
            {
              type: "click",
              listener: () => {
                reader.menuCmd("splitHorizontally")
              }
            }
          ]
        },
        {
          tag: "button",
          namespace: "html",
          id: "split-vertically",
          classList: ["toolbarButton"],
          styles: {
            backgroundImage: `url(chrome://${config.addonRef}/content/icons/split.png)`,
            // backgroundImage: await Zotero.File.generateDataURI(
            //   `chrome://${config.addonRef}/content/icons/vertically.png`, 'image/png'
            // ),
            marginLeft: "0",
            ...styles
          },
          attributes: {
            title: "Split Vertically",
            tabindex: "-1",
          },
          listeners: [
            {
              type: "click",
              listener: () => {
                reader.menuCmd("splitVertically")
              }
            }
          ]
        }
      ]
    }, ref)

    // ztoolkit.UI.appendElement({
    //   tag: "style",
    //   id: "reference-style",
    //   properties: {
    //     innerHTML: `
    //       #split-horizontally.toolbarButton::before {
    //         background-image: url("chrome://${config.addonRef}/content/icons/horizontally.png");
    //       }
    //       #split-vertically.toolbarButton::before {
    //         background-image: url("chrome://${config.addonRef}/content/icons/vertically.png");
    //       }
    //     `
    //   },
    // }, ((_window.document as Document).documentElement));
  }

  /**
   * Refresh the recommended-related list.
   * @param array
   * @param node
   * @returns
   */
  public refreshRelated(array: ItemBaseInfo[], node: HTMLDivElement) {
    let totalNum = 0
    // @ts-ignore
    array.forEach((info: ItemBaseInfo, i: number) => {
      let {box, label} = this.addRow(node, array, i, false, false) as any
      if (!box) { return }
      box.classList.add("only-title")
      totalNum += 1;
      // let box = row.querySelector("box") as XUL.Box
    })
    return totalNum
  }

  /**
 * Only item with DOI is supported
 * @returns 
 */
  async loadingRelated(panel?: HTMLDivElement, currentItem?: Zotero.Item) {
    if (!Zotero.Prefs.get(`${config.addonRef}.loadingRelated`)) { return }
    ztoolkit.log("loadingRelated");
    let item = currentItem || this.utils.getItem() as Zotero.Item
    if (!item) { return }
    let itemDOI = item.getField("DOI") as string
    if (!itemDOI || !this.utils.isDOI(itemDOI)) {
      ztoolkit.log("Not DOI", itemDOI);
      return
    }
    ztoolkit.log("getDOIRelatedArray")
    let _relatedArray = (await this.utils.API.getDOIRelatedArray(itemDOI)) as ItemBaseInfo[] || []
    if (!panel) { return }
    const node = panel.querySelector(".reference-recommendations") as HTMLDivElement
    if (!node) { return }
    const grid = node.querySelector(".reference-grid") as HTMLDivElement
    grid.replaceChildren()
    const relatedArray = (item.relatedItems.map((key: string) => {
      try {
        return Zotero.Items.getByLibraryAndKey(item.libraryID, key) as Zotero.Item
      } catch { }
    })
      .filter(i => i) as Zotero.Item[])
      .map((relatedItem: Zotero.Item) => {
        return {
          identifiers: { DOI: relatedItem.getField("DOI") },
          authors: [],
          title: relatedItem.getField("title"),
          text: relatedItem.getField("title"),
          url: relatedItem.getField("url"),
          type: relatedItem.itemType,
          year: relatedItem.getField("year"),
          _item: relatedItem
        } as ItemBaseInfo
      }).concat(_relatedArray)
    node.hidden = relatedArray.length === 0
    if (relatedArray.length) {
      this.refreshRelated(relatedArray, node)
    }
  }

  public async pdfLinks(reader: _ZoteroTypes.ReaderInstance, panel: XUL.TabPanel) {
    let _pdfDocument: any, _window: any
    // @ts-ignore
    while (!((_window = reader?._iframeWindow?.wrappedJSObject) && (_pdfDocument = _window.PDFViewerApplication?.pdfDocument))) {
      await Zotero.Promise.delay(10)
    }
    // let refKeys: any = []
    const dests = await _pdfDocument._transport.getDestinations()
    // window.setTimeout(async () => {
    //   dests = await _pdfDocument._transport.getDestinations()
    //   // Work out which href corresponds to which reference.
    //   // Count the citation groups whose size matches the reference count.
    //   const statistics: any = {}
    //   Object.keys(dests).forEach(key => {
    //     let _key = key.replace(/\d/g, "")
    //     statistics[_key] ??= 0
    //     statistics[_key] += 1
    //   })
    //   // const totalNum = 36
    //   // let refKey = Object.keys(statistics).find(k => statistics[k] == totalNum)
    //   // The largest group is the most likely, though not without risk.
    //   let refKey = Object.keys(statistics).sort((k1, k2) => statistics[k2]- statistics[k1])[0]
    //   Object.keys(dests).forEach(key => {
    //     if (key.replace(/\d/g, "") == refKey) {
    //       refKeys.push(key)
    //     }
    //   })
    //   // Sort by the matched number.
    //   refKeys = refKeys.sort((k1: string, k2: string) => {
    //     let n1 = Number(k1.match(/\d+/)![0])
    //     let n2 = Number(k2.match(/\d+/)![0])
    //     return n1 - n2
    //   })
    // })
    let id = window.setInterval(async () => {
      try {
        _window.document
      } catch (e) {
        ztoolkit.log(e)
        window.clearInterval(id)
        return await this.pdfLinks(reader, panel)
      }
      
      _window.document
        .querySelectorAll(`section.linkAnnotation a[href^='#']:not([${config.addonRef}])`).forEach(async (a: any) => {
          const isClickLink = Zotero.Prefs.get(`${config.addonRef}.clickLink`) as boolean
          const isHoverLink = Zotero.Prefs.get(`${config.addonRef}.hoverLink`) as boolean
          let _a: any, href = a.getAttribute("href")
          if (href.indexOf("fig") >=0) {return }
          if (isClickLink) {
            _a = ztoolkit.UI.appendElement({
              tag: "a",
              namespace: "html"
            }, a.parentNode) as HTMLDivElement
            _a.setAttribute(config.addonRef, href);
            _a.setAttribute("style", "cursor: pointer;")
            a.remove()
            _a.addEventListener("click", async (event: MouseEvent) => {
              event.stopPropagation();
              event.preventDefault();
              if (_window.secondViewIframeWindow == null) {
                await reader.menuCmd(
                  Zotero.Prefs.get(`${config.addonRef}.clickLink.cmd`) as any
                )
                while (
                  !(
                    _window?.secondViewIframeWindow?.PDFViewerApplication?.pdfDocument
                  )
                ) {
                  await Zotero.Promise.delay(100)
                }
                await Zotero.Promise.delay(1000)
              }
              // let dest = unescape()
              // Throws an error; see #39
              _window.secondViewIframeWindow.eval(`PDFViewerApplication
                .pdfViewer.linkService.goToDestination("${href.slice(1) }")`)

            })
          }
          
          let timer: undefined | number
          _a = _a || a
          if (isHoverLink) {
            let tipUI: TipUI
            _a.addEventListener("mouseenter", async (event: MouseEvent) => {
              // @ts-ignore
              const references = panel.references
              if (!references) { return }
              const [x, y] = dests[href.slice(1)].slice(2, 4)
              // Determine refIndex
              const distances = references.map((ref: { x: number; y: number }) => (x - ref.x) ** 2 + (y - ref.y) ** 2)
              const minDistance = [...distances].sort((a: number, b: number) => a-b)[0]
              const refIndex = distances.indexOf(minDistance)
              let reference = references[refIndex]
              if (reference) {
                timer = window.setTimeout(() => {
                  timer = undefined
                  let rect = _a.getBoundingClientRect()
                  rect.y = rect.y + 40;
                  tipUI = this.showTipUI(
                    rect,
                    reference,
                    "top center"
                  )
                }, 233)
              }
            })
            _a.addEventListener("mouseleave", async () => {
              window.clearTimeout(timer)
              if (tipUI) {
                const timeout = tipUI.removeTipAfterMillisecond
                tipUI.tipTimer = window.setTimeout(async () => {
                  tipUI && tipUI.container.remove()
                }, timeout)
              }
            })
          }
        })
    }, 100)
  }

  /**
   * Triggered by the refresh button.
   * @param local whether reading from the local cache is allowed
   * @returns
   */
  public async refreshReferences(panel: HTMLDivElement, local: boolean = true, silent: boolean = false) {
    Zotero.ProgressWindowSet.closeAll();
    let label = panel.querySelector("#reference-num") as HTMLSpanElement;
    label.innerText = `${0} ${getString("relatedbox-number-label")}`;
    // clear
    panel.querySelectorAll(".reference-main-list .reference-grid > *").forEach(e => e.remove());
    panel.querySelectorAll("#zoference-search").forEach(e => e.remove());

    let references: ItemBaseInfo[] | undefined
    // Captured from the multi-source fetch so the section's cache write keeps the
    // per-source breakdown, letting the explorer open with its source picker ready.
    let sectionPerSource: RelationSourceResult[] | undefined
    let item = (panel as any)._referenceItem || this.utils.getItem() as Zotero.Item
    if (!item) {
      throw new Error("Reference panel has no item context");
    }
    // A resident shard makes this a no-op; it matters for the paths that reach a
    // refresh without going through the section's async render, and after the
    // resident set has evicted this item.
    await localStorage.load(item);

    // Highest priority: the local cache. A reference list does not change once
    // settled, and the cost of redoing it is not in the direct-DOI call but in the
    // hundreds of per-entry metadata requests that follow. Only local=false, i.e. a
    // manual refresh, bypasses it.
    let fromCache = false
    const cached = local ? this.readReferencesCache(item) : undefined
    this.lastLoadDiagnostic = {
      at: new Date().toLocaleTimeString(),
      itemKey: item.key,
      itemTitle: String(item.getField("title") || "").slice(0, 60),
      // The library view and the reader both go through this same
      // refreshReferences yet behave differently, so record the context too — the
      // difference can only come from these few arguments.
      context: (panel as any)._referenceReader ? "reader" : "library",
      local, silent,
      cacheEnabled: this.isCacheEnabled("saveAPIReferences"),
      cacheHit: Boolean(cached),
      cachedResolved: cached?.resolved,
      cachedCount: cached?.references?.length,
    }
    if (cached) {
      references = cached.references
      fromCache = true
      panel.setAttribute("source", cached.source)
      label.title = `${cached.source} · ${new Date(cached.savedAt).toLocaleString()}`
      if (!silent) {
        (new PanelStatus(`[Saved] ${cached.source}`))
          .createLine({ text: `${cached.references.length} references`, type: "success" })
          .show()
      }
    }

    // A DOI can query OpenAlex, Crossref, and S2; without one, a freshly enriched
    // S2 Paper ID can still query Semantic Scholar directly. When both exist, the
    // Paper ID is S2's exact entry point and avoids a DOI mapping to another
    // version of the paper.
    const identifiers = readItemPaperIdentifiers(item)
    const itemDOI = identifiers.doi || ""
    const semanticScholarPaperId = identifiers.semanticScholarPaperId || ""
    this.lastLoadDiagnostic.doi = itemDOI
    this.lastLoadDiagnostic.semanticScholarPaperId = semanticScholarPaperId
    if (!references && (itemDOI || semanticScholarPaperId)) {
      const popupWin = silent ? null : new PanelStatus("[Pending] API", { closeTime: -1 })
      const lookupLabel = itemDOI && semanticScholarPaperId
        ? "DOI + Semantic Scholar Paper ID"
        : itemDOI ? "DOI" : "Semantic Scholar Paper ID"
      popupWin?.createLine({ text: `Request references by ${lookupLabel}...`, type: "default" }).show()
      const result = await fetchReferencesByIdentifiers(itemDOI, semanticScholarPaperId)
      // Hovering the count shows how many each of the three returned — which is
      // what distinguishes "this paper simply cites little" from "the source with
      // the best coverage failed" when the list looks short.
      this.lastLoadDiagnostic.engines = { ...referencesDiagnostics }
      label.title = [
        `OpenAlex: ${referencesDiagnostics.openAlex}`,
        `Crossref: ${referencesDiagnostics.crossref}`,
        `Semantic Scholar (${referencesDiagnostics.semanticScholarLookup || "no identifier"}): ` +
          `${referencesDiagnostics.semanticScholar}`,
      ].join("\n")
      const referenceFailures = [
        ["OpenAlex", referencesDiagnostics.openAlex],
        ["Crossref", referencesDiagnostics.crossref],
        ["Semantic Scholar", referencesDiagnostics.semanticScholar],
      ].filter(([, status]) => String(status || "").startsWith("error:"))
      if (result) {
        references = result.references
        sectionPerSource = result.perSource
        panel.setAttribute("source", result.source)
        popupWin?.changeHeadline(`[${result.source}]`)
        popupWin?.changeLine({
          text: referenceFailures.length
            ? `${result.references.length} references; ` +
              `${referenceFailures.map(([source]) => source).join(", ")} failed`
            : `${result.references.length} references`,
          type: referenceFailures.length ? "fail" : "success",
        })
      } else {
        popupWin?.changeHeadline("[API]")
        popupWin?.changeLine({
          text: referenceFailures.length
            ? `Reference lookup incomplete: ` +
              `${referenceFailures.map(([source]) => source).join(", ")} failed`
            : "No references found for these identifiers",
          type: referenceFailures.length ? "fail" : "default",
        })
      }
      popupWin?.startCloseTimer(3000)
    }

    // Fallback source: references extracted by ZoMiner into a JSON attachment. A
    // pure extraction artifact, so title and authors come from local parsing.
    const zomRefs = references ? null : await readZoMinerReferences(item)
    if (zomRefs) {
      references = zomRefs.map((ref) => {
        // ZoMiner supplies only the raw citation; title, authors, and year come
        // from local parsing first and are overwritten later by Crossref or
        // OpenAlex. Note that ref carries empty title/authors placeholders, which
        // must not overwrite what was just parsed.
        const parsed = this.utils.refText2Info(ref.text!)
        return {
          ...parsed,
          ...ref,
          title: ref.title || parsed.title,
          authors: ref.authors?.length ? ref.authors : parsed.authors,
          year: ref.year || parsed.year,
          identifiers: { ...this.utils.getIdentifiers(ref.text!), ...ref.identifiers },
        }
      })
      panel.setAttribute("source", "ZoMiner");
      // Auto-loading fires on every section expansion and shows no message, since
      // one popup per click would be noisy; only a manual refresh gives feedback.
      if (!silent) {
        (new PanelStatus("[ZoMiner]"))
          .createLine({ text: `${references.length} references`, type: "success" })
          .show()
      }
    }

    const finalReferences: ItemBaseInfo[] = references || []
    const referenceNum = finalReferences.length
    // @ts-ignore
    panel.references = finalReferences
    const preview = previewEntries(finalReferences, SECTION_PREVIEW_LIMIT);
    preview.forEach((reference: ItemBaseInfo, refIndex: number) => {
      let { box } = this.addRow(
        panel.querySelector(".reference-main-list") as HTMLDivElement,
        preview,
        refIndex,
        true,
        false,
        false,
      )!;
      // @ts-ignore
      box.reference = reference
      label.innerText = `${refIndex + 1}/${referenceNum} ${getString("relatedbox-number-label")}`;
    })

    label.innerText = `${referenceNum} ${getString("relatedbox-number-label")}`;
    void this.markSectionLibraryState(panel, preview, item);

    const source = panel.getAttribute("source") || "API";
    // Save an unresolved copy first. Resolving a batch of hundreds takes tens of
    // seconds, while clicking through items one at a time in the library view is
    // normal — writing the cache only after resolution completes would mean it is
    // never written on the most common path, which looks like "the cache does
    // nothing".
    if (!fromCache) {
      this.saveReferencesCache(item, source, finalReferences, false, sectionPerSource);
    }
    // A cache entry that is already resolved is the end of it; a half-finished one
    // continues with the remainder and then overwrites.
    if (fromCache && cached?.resolved) { return; }
    // Not awaited: blocking would leave the section empty; each entry updates in
    // place as it resolves.
    this.resolveReferences(panel, finalReferences)
      // Marked resolved only when the whole batch really reached the API. If some
      // entries failed to throttling or a dropped connection, it stays
      // half-finished and the next expansion completes the rest — otherwise a
      // single 429 would be frozen in permanently.
      .then((complete) =>
        this.saveReferencesCache(item, source, finalReferences, complete, sectionPerSource))
      .catch((error) => ztoolkit.log("resolve references failed", error));
  }

  /**
   * Fill Crossref "DOI-only" reference rows for the independent Explorer.
   *
   * Some publishers hand Crossref a reference carrying a DOI but no title, so
   * fromCrossrefReference builds the row with a `DOI: …` placeholder. The item-pane
   * box upgrades these through {@link resolveReferences}; the Explorer takes the
   * getLiteratureSnapshot data path, which returns records rather than mutating live
   * rows, so without this the row shows a bare DOI forever.
   *
   * Scope is deliberately narrow — only entries that already carry a DOI but no
   * title. Given a DOI, resolveOne takes the authoritative lookup, not fuzzy
   * matching, so this is a couple of requests per entry with no request storm and no
   * risk of matching the wrong paper. Raw text-only entries (e.g. ZoMiner) are left
   * alone; they already carry a parsed label. Note the merged list's placeholder
   * entries lose the `_placeholderText` flag in composeGroup, so detection is by the
   * shape (no title, has DOI) rather than the flag.
   */
  private async fillReferencePlaceholders(
    item: Zotero.Item,
    state: ReferencesCache,
  ): Promise<void> {
    const pending = state.references
      .map((reference, index) => ({ reference, index }))
      .filter(({ reference }) => !reference.title && reference.identifiers?.DOI);
    if (!pending.length) { return; }
    let changed = false;
    await resolveMany(
      pending.map(({ reference }) => ({
        raw: reference.text || "",
        identifiers: reference.identifiers,
      })),
      (position, info) => {
        // A low-confidence guess or a titleless result leaves the placeholder as it
        // was; only a confident, titled match is worth writing over the DOI row.
        if (!info || info.lowConfidence || !info.title) { return; }
        const { reference } = pending[position];
        if (info.identifiers.DOI) {
          reference.identifiers = { ...reference.identifiers, DOI: info.identifiers.DOI };
        }
        reference.title = info.title;
        reference.authors = info.authors?.length ? info.authors : reference.authors;
        reference.year = info.year || reference.year;
        reference.primaryVenue = info.primaryVenue || reference.primaryVenue;
        reference.abstract = info.abstract || reference.abstract;
        reference.citations = info.citations ?? reference.citations;
        reference.url = info.url || reference.url;
        reference.source = info.source || reference.source;
        // The row still holds the "DOI: …" placeholder text; rebuild it from the
        // resolved fields so any label reading `text` no longer shows a bare DOI.
        if (reference._placeholderText || /^DOI:\s/i.test(reference.text || "")) {
          reference.text = [
            reference.authors?.length ? reference.authors.slice(0, 3).join(", ") : undefined,
            reference.year,
            reference.title,
            reference.primaryVenue,
          ].filter(Boolean).join(". ");
          delete reference._placeholderText;
        }
        changed = true;
      },
    );
    // Persist so the enrichment survives the session; unchanged runs (nothing
    // resolved) skip the write to avoid needless cache churn and a bumped savedAt.
    if (changed) {
      this.saveReferencesCache(
        item,
        state.source,
        state.references,
        state.resolved,
        state.perSource,
      );
    }
  }

  /**
   * Use Crossref and OpenAlex to turn raw citations into structured metadata:
   * DOI, title, authors, venue, year, abstract, and citation count.
   *
   * The reference objects are rewritten in place: `box.reference` in addRow points
   * at the same object, and both the tooltip and the "+" import read it only when
   * the interaction happens, so a completed lookup takes effect without rebuilding
   * the row. That is also what makes "+" usable at all — it requires
   * identifiers.DOI, and a raw citation usually has no DOI.
   */
  private async resolveReferences(panel: HTMLDivElement, references: ItemBaseInfo[]): Promise<boolean> {
    const pending = references
      .map((reference, index) => ({ reference, index }))
      // The test is whether a title exists, not whether a DOI does:
      //   - entries that already have one (returned directly by OpenAlex or S2) are
      //     structured already, so another fuzzy-match round wastes requests and
      //     could overwrite something correct with something wrong;
      //   - Crossref references often contain entries with a DOI and no text at
      //     all, which must be resolved or the list shows a blank line. Given a
      //     DOI, resolveOne takes the authoritative lookup, not fuzzy matching.
      .filter(({ reference }) => !reference.title && (reference.text || reference.identifiers?.DOI));
    if (!pending.length) { return true; }
    const label = panel.querySelector("#reference-num") as HTMLSpanElement | null;
    const total = references.length;
    const suffix = getString("relatedbox-number-label");
    let done = 0;

    const { failed } = await resolveMany(
      pending.map(({ reference }) => ({
        raw: reference.text || "",
        identifiers: reference.identifiers,
      })),
      (position, info) => {
        done += 1;
        const { reference } = pending[position];
        if (info) {
          // A low-confidence result is a guess and may only be displayed. Writing
          // identifiers would feed it into the "+" import path, which creates an
          // item straight from the DOI — a wrong guess imports the wrong paper.
          // The title must not be stored either: without a DOI, import looks one
          // up from the title, with the same result.
          if (info.lowConfidence) {
            reference.lowConfidence = true;
            reference.abstract = info.abstract || reference.abstract;
            reference.source = info.source || reference.source;
            if (!label) { return; }
            label.innerText = done < pending.length
              ? `${total} ${suffix} · ${done}/${pending.length}`
              : `${total} ${suffix}`;
            return;
          }
          if (info.identifiers.DOI) {
            reference.identifiers = { ...reference.identifiers, DOI: info.identifiers.DOI };
          }
          reference.title = info.title || reference.title;
          reference.authors = info.authors?.length ? info.authors : reference.authors;
          reference.year = info.year || reference.year;
          reference.primaryVenue = info.primaryVenue || reference.primaryVenue;
          reference.abstract = info.abstract || reference.abstract;
          reference.citations = info.citations ?? reference.citations;
          reference.url = info.url || reference.url;
          reference.source = info.source || reference.source;
          // Crossref often returns reference entries with a DOI and no text, so
          // the row is built with a placeholder. Once the real bibliographic data
          // resolves, that row has to be replaced in place, or the list shows the
          // DOI forever.
          if (reference._placeholderText && info.title) {
            reference.text = [
              reference.authors?.length ? reference.authors.slice(0, 3).join(", ") : undefined,
              reference.year,
              reference.title,
              reference.primaryVenue,
            ].filter(Boolean).join(". ");
            delete reference._placeholderText;
            this.updateRowLabel(panel, reference);
          }
        }
        if (!label) { return; }
        label.innerText = done < pending.length
          ? `${total} ${suffix} · ${done}/${pending.length}`
          : `${total} ${suffix}`;
      },
    );
    return failed === 0;
  }

  /** Replace a reference's row text with its current text; rows link to objects via box.reference. */
  private updateRowLabel(panel: HTMLDivElement, reference: ItemBaseInfo) {
    const boxes = [...panel.querySelectorAll(".reference-main-list .box")] as any[];
    const box = boxes.find((node) => node.reference === reference);
    const label = box?.querySelector("#reference-label") as HTMLLabelElement | undefined;
    if (label) {
      label.innerText = `[${reference.number ?? ""}] ${reference.text}`.replace(/^\[\]\s*/, "");
    }
  }

  public showTipUI(refRect: Rect, reference: ItemInfo, position: string, idText?: string) {
    let toTimeInfo = (t: string) => {
      if (!t) { return undefined }
      let info = (new Date(t)).toString().split(" ")
      return `${info[1]} ${info[3]}`
    }
    let tipUI = new TipUI()
    tipUI.onInit(refRect, position)
    const refText = reference.text!;
    let getDefalutInfoByReference = async () => {
      const localItem = reference._item
      let info: ItemInfo
      if (localItem) {
        info = {
          identifiers: {},
          authors: localItem.getCreators().map((i: any) => i.firstName + " " + i.lastName),
          tags: localItem.getTags().map((i: any) => {
            let ctag: any = localItem.getColoredTags().find((ci: any) => ci.tag == i.tag)
            if (ctag) {
              return {text: i.tag, color: ctag.color}
            } else {
              return i.tag
            }
          }),
          abstract: localItem.getField("abstractNote") as string,
          title: localItem.getField("title") as string,
          year: localItem.getField("year") as string,
          primaryVenue: localItem.getField("publicationTitle") as string,
          type: "",
          source: reference.source || undefined
        }
      } else {
        info = {
          identifiers: reference.identifiers || {},
          authors: reference.authors || [],
          type: "",
          year: reference.year || undefined,
          title: reference.title || idText || "Reference",
          tags: reference.tags || [],
          text: reference.text || refText,
          abstract: reference.abstract || refText,
          primaryVenue: reference.primaryVenue || undefined
          
        }
        let url = this.utils.identifiers2URL(info.identifiers)
        if (url) {
          info.url = url
        }
      }
      return info
    }
    let coroutines: Promise<ItemInfo | undefined>[], prefIndex: number, according: string
    if (reference?.identifiers.arXiv) {
      according = "arXiv"
      coroutines = [
        getDefalutInfoByReference(),
        this.utils.API.getArXivInfo(reference.identifiers.arXiv)
      ]
      prefIndex = parseInt(Zotero.Prefs.get(`${config.addonRef}.${according}InfoIndex`) as string)
    } else if (reference?.identifiers.DOI) {
      according = "DOI"
      coroutines = [
        getDefalutInfoByReference(),
        this.utils.API.getDOIInfoBySemanticscholar(reference.identifiers.DOI),
        this.utils.API.getTitleInfoByReadpaper(refText, {}, reference.identifiers.DOI),
        this.utils.API.getTitleInfoByConnectedpapers(reference.identifiers.DOI),
        this.utils.API.getDOIInfoByCrossref(reference.identifiers.DOI)
      ]
      prefIndex = parseInt(Zotero.Prefs.get(`${config.addonRef}.${according}InfoIndex`) as string)
    } else {
      according = "Title"
      coroutines = [
        getDefalutInfoByReference(),
        this.utils.API.getTitleInfoByReadpaper(reference.title),
        this.utils.API.getTitleInfoByCrossref(reference.title),
        this.utils.API.getTitleInfoByConnectedpapers(reference.title)
      ]
      prefIndex = parseInt(Zotero.Prefs.get(`${config.addonRef}.${according}InfoIndex`) as string)
    }
    const sourceConfig = {
      arXiv: { color: "#b31b1b", tip: "arXiv is a free distribution service and an open-access archive for 2,186,475 scholarly articles in the fields of physics, mathematics, computer science, quantitative biology, quantitative finance, statistics, electrical engineering and systems science, and economics. Materials on this site are not peer-reviewed by arXiv." },
      readpaper: { color: "#1f71e0", tip: "ReadPaper is a paper-reading platform indexing close to 200 million papers, 270 million authors, and nearly 30,000 universities and research institutions, covering virtually every academic discipline. Its stated mission is to make no paper hard to read." },
      semanticscholar: { color: "#1857b6", tip: "Semantic Scholar is an artificial intelligence–powered research tool for scientific literature developed at the Allen Institute for AI and publicly released in November 2015. It uses advances in natural language processing to provide summaries for scholarly papers. The Semantic Scholar team is actively researching the use of artificial-intelligence in natural language processing, machine learning, Human-Computer interaction, and information retrieval." },
      crossref: { color: "#89bf04", tip: "Crossref is a nonprofit association of approximately 2,000 voting member publishers who represent 4,300 societies and publishers, including both commercial and nonprofit organizations. Crossref includes publishers with varied business models, including those with both open access and subscription policies." },
      connectedpapers: { color: "#35999a", tip: "Connected Papers is a visual tool to help researchers and applied scientists find academic papers relevant to their field of work."},
      DOI: { color: "#fcb426" },
      Zotero: { color: "#d63b3b", tip: "Zotero is a free, easy-to-use tool to help you collect, organize, cite, and share your research sources." }
    }
    for (let i = 0; i < coroutines.length; i++) {
      // Non-blocking
      window.setTimeout(async () => {
        let info = await coroutines[i]
        if (!info) { return }
        const tagDefaultColor = "#59C1BD"
        let tags = info.tags!.map((tag: object | string) => {
          if (typeof tag == "object") {
            return { color: tagDefaultColor, ...(tag as object) }
          } else {
            return { color: tagDefaultColor, text: tag }
          }
        }) as any || []
        // Show a tag for the current data source
        if (info.source) { tags.push({ text: info.source, ...sourceConfig[info.source as keyof typeof sourceConfig], source: info.source }) }
        // Show clickable link tags
        if (info.identifiers.DOI) {
          let DOI = info.identifiers.DOI
          tags.push({ text: "DOI", color: sourceConfig.DOI.color, tip: DOI, url: info.url })
        }
        if (info.identifiers.arXiv) {
          let arXiv = info.identifiers.arXiv
          tags.push({ text: "arXiv", color: sourceConfig.arXiv.color, tip: arXiv, url: info.url })
        }
        if (reference._item) {
          // Update from the local item
          tags.push({ text: "Zotero", color: sourceConfig.Zotero.color, tip: sourceConfig.Zotero.tip, item: reference._item })
        }
        // Add
        tipUI.addTip(
          this.utils.Html2Text(info.title!)!,
          tags,
          [
            info.authors?.slice(0, 3).join(" / "),
            [info?.primaryVenue, toTimeInfo(info.publishDate as string) || info.year]
              .filter(e => e).join(" \u00b7 "),
            reference.description
          ].filter(s => s && s != ""),
          this.utils.Html2Text(info.abstract!)!,
          according,
          i,
          prefIndex,
          // The title is the link: the DOI wins, since it lands on the publisher's
          // official page; otherwise use whatever url the source supplied.
          info.identifiers.DOI
            ? `https://doi.org/${info.identifiers.DOI}`
            : (info.url || this.utils.identifiers2URL(info.identifiers) || undefined)
        )
      })
    }
    return tipUI
  }

  private async markSectionLibraryState(
    node: HTMLDivElement,
    entries: ItemBaseInfo[],
    item: Zotero.Item,
  ): Promise<void> {
    const memberships = await resolveLibraryMembership(item.libraryID, entries);
    const boxes = [...node.querySelectorAll(".reference-grid .box")] as HTMLElement[];
    boxes.forEach((box, index) => {
      const localItem = memberships.get(entries[index]);
      box.dataset.libraryState = localItem ? "in" : "out";
      box.title = localItem
        ? getString("literature-in-library-label") || "In Library"
        : getString("literature-not-in-library-label") || "Not in Library";
    });
  }

  public addRow(
    node: HTMLDivElement,
    references: ItemBaseInfo[],
    refIndex: number,
    addPrefix: boolean = true,
    addSearch: boolean = true,
    showRelationAction: boolean = true,
  ) {
    let notInLibarayOpacity: string|number = Zotero.Prefs.get(`${config.addonRef}.notInLibarayOpacity`) as string
    if (/[\d\.]+/.test(notInLibarayOpacity)) {
      notInLibarayOpacity = Number(notInLibarayOpacity);
    } else {
      notInLibarayOpacity = 1
    }
    let reference = references[refIndex]
    // Non-blocking search
    let refText: string
    if (addPrefix) {
      refText = `[${reference?.number || (refIndex + 1)}] ${reference.text}`
    } else {
      refText = reference.text!
    }
    // Avoid adding a duplicate row
    let toText = (s: string) => s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "") 
    if (
      [...node.querySelectorAll(".box label")].find((e: any) => toText(e.innerText) == toText(refText))
    ) {
      return
    }
    // Identifier description
    let idText = (
      reference.identifiers
      && Object.values(reference.identifiers).length > 0
      && Object.keys(reference.identifiers)[0] + ": " + Object.values(reference.identifiers)[0]
    ) || "Reference"
    // Current item
    const contextPanel = node.closest(".zoference-section") as any
    let item = contextPanel?._referenceItem || this.utils.getItem()!
    const box = ztoolkit.UI.createElement(
      document,
      "div",
      {
        namespace: "html",
        classList: ["box", "zotero-clicky"],
        listeners: [
          {
            type: "click",
            listener: (event: any) => {
              event.preventDefault()
              event.stopPropagation()
            }
          },
          {
            type: "mouseup",
            listener: async (event: any) => {
              event.preventDefault()
              event.stopPropagation()
              // ctrl-click jumps to the local item or the url
              if (event.ctrlKey || event.metaKey) {
                if (reference._item) {
                  return this.utils.selectItemInLibrary(reference._item)
                } else {
                  const localItem = await this.utils.searchLibraryItem(reference, item.libraryID)
                  if (localItem) {
                    return this.utils.selectItemInLibrary(localItem)
                  }
                }
                let URL = reference.url
                if (!URL) {
                  const refText = reference.text!
                  let info: ItemBaseInfo = this.utils.refText2Info(refText);
                  const popupWin = (new PanelStatus("Searching URL", { closeTime: -1 }))
                    .createLine({ text: `Title: ${reference.title}`, type: "default" })
                    .show()
                  let DOI = (await this.utils.API.getTitleInfoByConnectedpapers(reference.title as string))?.identifiers.DOI
                  URL = this.utils.identifiers2URL({ DOI })
                  popupWin.close()
                }
                if (URL) {
                  (new PanelStatus("Launching URL", { closeOtherProgressWindows: true }))
                    .createLine({ text: URL, type: "default" })
                    .show()
                  Zotero.launchURL(URL);
                }
              } else {
                Zotero.ProgressWindowSet.closeAll()
                this.utils.copyText((idText ? idText + "\n" : "") + refText, false);
                (new PanelStatus("Reference"))
                  .createLine({ text: refText, type: "success" })
                  .show()
              }
            }
          },
        ],
        styles: {
          alignItems: "center",
          opacity: String(notInLibarayOpacity),
          paddingTop: "1px",
          paddingBottom: "1px"
        },
        children: [
          {
            tag: "img",
            attributes: {
              src: Zotero.ItemTypes.getImageSrc(reference.type as any) as string
            }
          },
          {
            tag: "label",
            id: "reference-label",
            properties: {
              innerText: refText
            },
            styles: {
              width: "100%"
            }
          }
        ]
      }
    ) as XUL.Element
    const label = ztoolkit.UI.createElement(
      document, 
      "label",
      {
        id: "add-remove",
        namespace: "xul",
        attributes: {
          value: "+"
        },
        classList: [
          "zotero-clicky",
          "zotero-clicky-plus"
        ]
      }
    )

    // Long-pressing a row used to turn it into a textarea for correcting the raw
    // citation text. It was removed rather than repaired: the save wrote to a
    // `References-<source>` key that nothing ever read back, so an edit survived
    // until the next render and then silently reverted to the fetched text — and
    // repairing it would have meant a second, user-authored tier of cache with its
    // own overwrite and lifetime rules, for a correction the reference list is not
    // the right place to make. Linking a reference to a real library item (the
    // +/- control below) is unaffected: that writes Zotero relations, not cache.

    let setState = (state: string = "") => {
      switch (state) {
        case "+":
          label.setAttribute("class", "zotero-clicky zotero-clicky-plus");
          label.setAttribute("value", "+");
          label.style.opacity = "1";
          break;
        case "-":
          label.setAttribute("class", "zotero-clicky zotero-clicky-minus");
          label.setAttribute("value", "-");
          label.style.opacity = "1";
          break
        case "":
          label.setAttribute("value", "");
          label.style.opacity = ".23";
          break
      }
    }

    let remove = async () => {
      ztoolkit.log("removeRelatedItem");
      const popunWin = new PanelStatus("Removing Item", {closeTime: -1})
        .createLine({ text: refText, type: "default" })
        .show()
      setState()

      let relatedItem = this.utils.searchRelatedItem(item, reference._item) as Zotero.Item
      if (!relatedItem) {
        popunWin.changeHeadline("Removed");
        (node.querySelector("#refresh-button") as XUL.Button).click()
        popunWin.startCloseTimer(3000)
        return
      }
      relatedItem.removeRelatedItem(item)
      item.removeRelatedItem(relatedItem)
      await item.saveTx()
      await relatedItem.saveTx()
      setState("+")
      popunWin.changeLine({ type: "success" })
      popunWin.startCloseTimer(3000)
    }

    let add = async (collections: undefined | number[] = undefined) => {
      let collapseText = (text: string) => {
        let n
        if (this.utils.isChinese(text)) {
          n = 15
        } else {
          n = 35
        }
        return text.length > n ? (text.slice(0, n) + "...") : text
      }
      let popupWin = (new PanelStatus("Searching Item",
        { closeTime: -1, closeOtherProgressWindows: true}))
        .createLine({ text: collapseText(reference.text!), type: "default" })
        .show()
      // Check the local library
      let refItem = reference._item || await this.utils.searchLibraryItem(reference, item.libraryID)
      // Disable the button
      setState()
      if (refItem) {
        popupWin.changeHeadline("Existing Item")
        popupWin.changeLine({ text: collapseText(refItem.getField("title"))})
      } else {
        let info: ItemBaseInfo = this.utils.refText2Info(reference.text!);
        // DOI or arXiv
        {
          // Fill in DOI information
          if (Object.keys(reference.identifiers).length == 0) {
            // The resolution layer could not identify this citation reliably (it
            // scored below MIN_SCORE). Looking a DOI up from that guessed title
            // would only amplify the error into a wrong library item.
            if (reference.lowConfidence) {
              setState("+");
              popupWin.changeHeadline("Uncertain match")
              popupWin.changeLine({ text: "Could not identify this reference reliably", type: "fail" })
              popupWin.startCloseTimer(3000)
              return
            }
            popupWin.changeHeadline("Searching DOI")
            popupWin.changeLine({ text: collapseText(`Title: ${info.title!}`) })
            let DOI = (await this.utils.API.getTitleInfoByConnectedpapers(info.title))?.identifiers.DOI as string
            if (!this.utils.isDOI(DOI)) {
              setState("+");
              popupWin.changeLine({ type: "fail" })
              popupWin.startCloseTimer(3000)
              return
            }
            reference.identifiers = { DOI }
          }
          popupWin.changeHeadline("Creating Item")
          popupWin.changeLine({ text: collapseText(`${Object.keys(reference.identifiers)}: ${Object.values(reference.identifiers)[0]}`) })
          // done
          if (await this.utils.searchRelatedItem(item, refItem)) {
            popupWin.changeHeadline("Added Item")
            popupWin.changeLine({ type: "success" });
            popupWin.startCloseTimer(3000);
            (node.querySelector("#refresh-button") as XUL.Button).click();
            return
          }
          // search DOI in local
          try {
            // The target library follows the paper being read, not whichever
            // library is selected in the left pane.
            refItem = await this.utils.createItemByZotero(
              reference.identifiers,
              (collections || item.getCollections()),
              item.libraryID,
            )
          } catch (e: any) {
            popupWin.changeLine({ type: "fail" })
            popupWin.startCloseTimer(3000)
            setState("+")
            ztoolkit.log(e)
            return
          }
        }
        for (let collectionID of (collections || item.getCollections())) {
          refItem.addToCollection(collectionID)
          await refItem.saveTx()
        }
      }
      popupWin.changeHeadline("Adding Item")
      popupWin.changeLine({ text: collapseText(refItem.getField("title")) })
      // addRelatedItem
      reference._item = refItem
      item.addRelatedItem(refItem)
      refItem.addRelatedItem(item)
      await item.saveTx()
      await refItem.saveTx()
      // button
      setState("-")
      popupWin.changeLine({ type: "success" })
      popupWin.startCloseTimer(3000)
      updateRowByItem(refItem)
    }

    let updateRowByItem = (refItem: Zotero.Item) => {
      box.style.opacity = "1";
      box.querySelector("img")?.setAttribute("src", refItem.getImageSrc())
      let alreadyRelated = this.utils.searchRelatedItem(item, refItem)
      if (alreadyRelated) {
        setState("-")
      }
    }

    let timer: undefined | number, tipUI: TipUI;
    if (notInLibarayOpacity < 1) {
      window.setTimeout(async () => {
        const refItem = reference._item ||
          await this.utils.searchLibraryItem(reference, item.libraryID) as Zotero.Item
        if (refItem) {
          updateRowByItem(refItem)
        }
      }, refIndex * 0)
    }
    // Show the tooltip when the mouse enters
    box.addEventListener("mouseenter", () => {
      if (!Zotero.Prefs.get(`${config.addonRef}.isShowTip`)) { return }
      box.classList.add("active")
      let timeout = parseInt(Zotero.Prefs.get(`${config.addonRef}.showTipAfterMillisecond`) as string)
      const position = Zotero.Prefs.get("extensions.zotero.layout", true) == "stacked" ? "top center" : "left"
      timer = window.setTimeout(async () => {
        const winRect: Rect = document.documentElement.getBoundingClientRect()
        const rect = box.getBoundingClientRect()
        rect.x -= 5
        tipUI = this.showTipUI(rect, reference, position, idText)
        if (!box.classList.contains("active")) {
          tipUI.container.style.display = "none"
        }
      }, timeout);
    })

    box.addEventListener("mouseleave", () => {
      box.classList.remove("active")
      window.clearTimeout(timer);
      if (!tipUI) { return }
      const timeout = tipUI.removeTipAfterMillisecond
      tipUI.tipTimer = window.setTimeout(async () => {
        // Watch for a continuous stretch with nothing active
        for (let i = 0; i < timeout / 2; i++) {
          if (rows.querySelector(".active")) { return }
          await Zotero.Promise.delay(1 / 1000)
        }
        tipUI && tipUI.clear()
      }, timeout / 2)
    })

    label.addEventListener("click", async (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const value = label.getAttribute("value")
      if (value == "+") {
        if (event.ctrlKey || event.metaKey) {
          let rect = box.getBoundingClientRect()
          // Build the collection picker
          let menuPopup = document.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", 'menupopup') as XUL.MenuPopup;
          document.querySelector("#browser")!.append(menuPopup);
          // List only collections from the current paper's library: picking one
          // from another library could not be saved anyway.
          let collections = Zotero.Collections.getByLibrary(item.libraryID);
          for (let col of collections) {
            let menuItem = Zotero.Utilities.Internal.createMenuForTarget(
              col,
              menuPopup,
              null as any,
              async (event: any, collection: any) => {
                if (event.target.tagName == 'menuitem') {
                  ztoolkit.log(collection)
                  menuPopup.remove()
                  await add([collection.id])
                  event.stopPropagation();
                }
              }
            );
            menuPopup.append(menuItem);
          }
          // @ts-ignore
          menuPopup.openPopupAtScreen(rect.left, rect.top + rect.height, true);
        } else {
          await add()
        }
      } else if (value == "-") {
        await remove()
      }
    })

    const rows = node.querySelector(".reference-grid")!

    if (showRelationAction) {
      rows.append(box, label);
    } else {
      rows.append(box);
    }
    let referenceNum = rows.childNodes.length
    if (addSearch && referenceNum && !node.querySelector("#zoference-search")) { this.addSearch(node) }
    // Height
    const relatedGrid = node.querySelector(".reference-grid") as HTMLDivElement
    relatedGrid.style.maxHeight = "60vh"
    return {box, label}
  }

  public addSearch(node: HTMLDivElement) {
    const searchBoxHeight = 10
    const searchBox = ztoolkit.UI.insertElementBefore({
      tag: "div",
      id: "zoference-search",
      classList: ["reference-search-box"],
      styles: {
        // width: "calc(100% - 35px)",
        height: `${searchBoxHeight}px`,
        padding: "5px",
        borderRadius: "5px",
        border: "1px solid #e0e0e0",
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        margin: ".5em 1em",
        opacity: "0.8"
      },
      children: [
        {
          tag: "div",
          styles: {
            width: `${searchBoxHeight}px`,
            height: `${searchBoxHeight}px`,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          },
          properties: {
            innerHTML: `<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="${searchBoxHeight}" height="${searchBoxHeight}"><path d="M1005.312 914.752l-198.528-198.464A448 448 0 1 0 0 448a448 448 0 0 0 716.288 358.784l198.4 198.4a64 64 0 1 0 90.624-90.432zM448 767.936A320 320 0 1 1 448 128a320 320 0 0 1 0 640z" fill="#5a5a5a"></path></svg>`
          }
        },
        {
          tag: "input",
          styles: {
            outline: "none",
            border: "none",
            width: "100%",
            margin: "0 5px"
          },
          listeners: [
            {
              type: "focus",
              listener: () => {
                searchBox.style.opacity = "1"
                searchBox.style.boxShadow = `0 0 0 1px rgba(0,0,0,0.5)`
              }
            },
            {
              type: "blur",
              listener: () => {
                searchBox.style.opacity = "0.8"
                searchBox.style.boxShadow = ``
              }
            },
            {
              type: "keyup",
              listener: async () => {
                const keyword = inputNode.value as string
                if (keyword.length > 0) {
                  clearNode.style.display = ""
                } else {
                  clearNode.style.display = "none"
                }
                //   let text = (event.target as any).value
                let keywords = keyword.split(/[ ,，]/).filter((e: any) => e)
                ztoolkit.log(keywords)
                node.querySelectorAll(".reference-grid *").forEach((e: any) => e.style.display = "")
                if (keywords.length == 0) {
                  return
                }
                node.querySelectorAll(".reference-grid .box").forEach((box: any) => {
                  let content = (box.querySelector("#reference-label") as any).textContent
                  let isAllMatched = true;
                  for (let i = 0; i < keywords.length; i++) {
                    isAllMatched = isAllMatched && content.toLowerCase().indexOf(keywords[i].toLowerCase()) >= 0
                  }
                  if (isAllMatched) {
                    ztoolkit.log(content)
                    box.style.display = ""
                    box.nextElementSibling.style.display = ""
                  } else {
                    box.style.display = "none"
                    box.nextElementSibling.style.display = "none"
                  }
                })
              }
            }
          ]
        },
        {
          tag: "div",
          classList: ["icon", "clear"],
          styles: {
            width: `${searchBoxHeight}px`,
            height: `${searchBoxHeight}px`,
            display: "none"
          },
          properties: {
            innerHTML: `<svg class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="${searchBoxHeight}" height="${searchBoxHeight}"><path d="M512.288 1009.984c-274.912 0-497.76-222.848-497.76-497.76s222.848-497.76 497.76-497.76c274.912 0 497.76 222.848 497.76 497.76s-222.848 497.76-497.76 497.76zM700.288 368.768c12.16-12.16 12.16-31.872 0-44s-31.872-12.16-44.032 0l-154.08 154.08-154.08-154.08c-12.16-12.16-31.872-12.16-44.032 0s-12.16 31.84 0 44l154.08 154.08-154.08 154.08c-12.16 12.16-12.16 31.84 0 44s31.872 12.16 44.032 0l154.08-154.08 154.08 154.08c12.16 12.16 31.872 12.16 44.032 0s12.16-31.872 0-44l-154.08-154.08 154.08-154.08z" fill="#5a5a5a" p-id="5698"></path></svg>`
          },
          listeners: [
            {
              type: "click",
              listener: async () => {
                inputNode.value = ""
                clearNode.style.display = "none"
                node.querySelectorAll(".reference-grid *").forEach((e: any) => e.style.display = "")
              }
            }
          ]
        },
      ]
    }, node.querySelector(".grid")!) as HTMLDivElement;
    const inputNode = searchBox.querySelector("input") as HTMLInputElement
    const clearNode = searchBox.querySelector(".clear") as HTMLInputElement
  }
}
