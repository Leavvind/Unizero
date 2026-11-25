import { config, version } from "../../package.json";
import { initLocale } from "../utils/locale";
import TipUI, { TIP_SHOW_DELAY_MS } from "./tip";
import Utils from "./utils";
import { localStorage } from "./localStorage";
import { readZoMinerReferences, findReferencesAttachment } from "./zomReferences";
import { SessionCache } from "./sessionCache";
import {
  fetchReferencesByIdentifiers,
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
import {
  readItemPaperIdentifiers,
  type ItemPaperIdentifiers,
} from "./itemIdentifiers";
import { forPersistence } from "./edgeIdentity";
import {
  CACHE_KEY_CITATIONS,
  CACHE_KEY_REFERENCES,
  citationsCacheIsUsable,
  completedEmptyCitations,
  makeReferencesCache,
  persistRelationSources,
  referencesCacheIsUsable,
  type CitationsCache,
  type ReferencesCache,
} from "./literatureCache";
import { uniConnection } from "./uniConnection";
import {
  invalidateLibraryMembership,
  resolveLibraryMembership,
  toLiteratureCandidate,
  type LiteratureCandidate,
  type LiteratureRelationKind,
  type LiteratureSnapshot,
  type LiteratureSourceView,
} from "./literatureRelations";
import {
  createDiscoveredPaper,
  type PaperDestination,
} from "../zotero/literatureItemAdapter";
import { literatureCandidateFromItem } from "../zotero/literatureCollectionAdapter";
import { paperDestinationFromItem } from "../zotero/literatureItemAdapter";
import { LiteratureSidebar, type LiteratureSidebarPort } from "../ui/literatureSidebar";
import { UniConnectionFull } from "../ui/uniConnectionFull";
import {
  recordCatalogDiscoverySnapshot,
  type PaperCatalogDiscoveryResult,
  type PaperCatalogDiscoverySnapshot,
  type PaperCatalogSeed,
} from "../projects/paperCatalog";
const EXPLORER_COUPLING_LIMIT = 50;

function catalogSeedFromEntry(candidate: {
  identifiers: ItemBaseInfo["identifiers"];
  title: string;
  authors: string[];
  year?: string;
  type?: string;
  text?: string;
  primaryVenue?: string;
  abstract?: string;
  sourceOrder?: number;
  number?: number;
}): PaperCatalogSeed {
  return {
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
    sourceOrder: candidate.sourceOrder ?? candidate.number,
  };
}

function catalogSeed(candidate: LiteratureCandidate): PaperCatalogSeed {
  return catalogSeedFromEntry(candidate);
}

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

function sourceSnapshotIsComplete(source: RelationSourceResult): boolean {
  const status = normalizeProgress(source.status);
  return !source.hasMore &&
    (status === "ok" || status === "empty" || status === "restricted");
}

/** The paper an item stands for: itself, or the parent of an attachment or note. */
function paperOf(item: Zotero.Item | false | undefined): Zotero.Item | undefined {
  if (!item || item.deleted) { return; }
  return item.isRegularItem() ? item : item.parentItem || undefined;
}

/**
 * The paper a relation snapshot is centred on, with the facts everything
 * downstream of the fetch — merging, library membership, catalog ingestion, the
 * rendered header — needs from it.
 */
interface LiteratureSeed {
  libraryID: number;
  itemKey: string;
  title: string;
  identifiers: ItemPaperIdentifiers;
  item: Zotero.Item;
}

function zoteroSeed(item: Zotero.Item): LiteratureSeed {
  return {
    libraryID: item.libraryID,
    itemKey: item.key,
    title: String(item.getField("title") || ""),
    identifiers: readItemPaperIdentifiers(item),
    item,
  };
}

export default class Views {
  public utils!: Utils;
  private registeredPaneID?: string;
  /** The item-pane References / Citations section. */
  private readonly sidebar = new LiteratureSidebar(this.sidebarPort());
  /** The same lists in their own window (UniConnection full). */
  private readonly full = new UniConnectionFull(
    this.sidebar,
    (doc) => this.addStyle(doc),
    (owner) => this.currentPaper(owner),
  );
  /** Follows tab switches for the full window, which the item pane misses while collapsed. */
  private tabObserverID?: string;
  /**
   * References cache writes per paper (explorerKey). A background resolve that
   * started before a newer write must not save its older list over it.
   */
  private readonly referencesWrites = new Map<string, number>();
  // Each relation kind retains only the 32 most recently used payloads. Disk
  // shards remain reloadable after eviction; session-only entries become misses.
  private explorerReferences = new SessionCache<ReferencesCache>();
  private explorerCitations = new SessionCache<CitationsCache>();
  private catalogIngestions = new Map<
    string,
    Promise<PaperCatalogDiscoveryResult | undefined>
  >();
  constructor() {
    initLocale();
    this.utils = new Utils()
  }

  public onWindowLoad(win: Window): void {
    this.addStyle(win.document);
  }

  public onWindowUnload(win: Window): void {
    this.full.closeForOwner(win);
    win.document.getElementById("reference-style")?.remove();
  }

  /** Open UniConnection full on `item` (the ⤢ button and the item context menu). */
  public openFull(win: Window, item: Zotero.Item): void {
    const paper = paperOf(item);
    if (paper) { this.full.open(win, paper); }
  }

  /** The paper of a main window's current tab: the reader's parent item, or the one selected item. */
  private currentPaper(win: Window): Zotero.Item | undefined {
    const tabs = (win as any).Zotero_Tabs;
    const tabID = tabs?.selectedID;
    let info = tabID ? tabs.getTabInfo?.(tabID) : undefined;
    if (typeof info?.type !== "string") { info = tabID ? tabs._getTab?.(tabID)?.tab : undefined; }
    if (typeof info?.type === "string" && info.type.startsWith("reader")) {
      return paperOf(Zotero.Items.get(info.data?.itemID) as Zotero.Item | false);
    }
    const selected = (win as any).ZoteroPane?.getSelectedItems?.() as Zotero.Item[] | undefined;
    return selected?.length === 1 ? paperOf(selected[0]) : undefined;
  }

  private addStyle(targetDocument: Document) {
    if (targetDocument.getElementById("reference-style")) { return; }
    const styles = ztoolkit.UI.createElement(targetDocument, "style", {
      id: "reference-style",
      namespace: "html",
      properties: {
        innerHTML: `
          /* contain: inline-size keeps long rows from widening the whole pane
             (and pushing the tabs and search box out of view). */
          .unizero-sidebar {
            width: 100%;
            min-width: 0;
            max-width: 100%;
            box-sizing: border-box;
            overflow: hidden;
            contain: inline-size;
            color: var(--fill-primary, inherit);
          }
          .unizero-sidebar__tabs {
            display: flex;
            gap: 2px;
            padding: 2px 6px 6px;
            margin-bottom: 6px;
            border-bottom: 1px solid var(--material-border, rgb(128 128 128 / 30%));
          }
          .unizero-sidebar__tab {
            flex: 1;
            min-height: 20px;
            padding: 4px 8px;
            border-radius: 4px;
            text-align: center;
            cursor: pointer;
            user-select: none;
            opacity: 0.65;
          }
          .unizero-sidebar__tab:hover {
            background: var(--fill-quinary, rgb(128 128 128 / 12%));
            opacity: 0.85;
          }
          .unizero-sidebar__tab.is-active {
            background: var(--fill-quarternary, rgb(128 128 128 / 20%));
            font-weight: 600;
            opacity: 1;
          }
          .unizero-sidebar__toolbar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 0 6px 6px;
          }
          .unizero-sidebar__search {
            flex: 1;
            min-width: 0;
            padding: 3px 6px;
            border-radius: 4px;
            border: 1px solid var(--material-border, rgb(128 128 128 / 35%));
            background: var(--material-background, transparent);
            color: inherit;
          }
          .unizero-sidebar__action {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            border: 1px solid rgb(128 128 128 / 35%);
            background: rgb(128 128 128 / 10%);
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            text-align: center;
          }
          .unizero-sidebar__action:hover {
            background: rgb(128 128 128 / 22%);
          }
          .unizero-sidebar__status {
            margin: 0 6px 6px;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.9em;
            background: var(--fill-quinary, rgb(128 128 128 / 12%));
            border-left: 3px solid var(--fill-tertiary, rgb(128 128 128 / 45%));
          }
          .unizero-sidebar__status[data-type="success"] {
            border-left-color: var(--accent-green, #57ab5a);
          }
          .unizero-sidebar__status[data-type="fail"] {
            border-left-color: var(--accent-red, #e5534b);
          }
          .unizero-sidebar__status[hidden] {
            display: none !important;
          }
          .unizero-sidebar__list {
            max-height: 60vh;
            overflow-x: hidden;
            overflow-y: auto;
            padding: 0 2px;
          }
          .unizero-sidebar__group {
            margin: 8px 6px 2px;
            font-size: 0.85em;
            font-weight: 600;
            opacity: 0.6;
            text-transform: uppercase;
            letter-spacing: 0.03em;
          }
          .unizero-sidebar__hint,
          .unizero-sidebar__empty {
            margin: 6px;
            padding: 6px 8px;
            font-size: 0.9em;
            opacity: 0.7;
            overflow-wrap: anywhere;
          }
          .unizero-sidebar__empty .unizero-sidebar__action {
            display: block;
            margin-top: 6px;
          }
          /* Library state is a thin marker, not a fill: the text stays the focus. */
          .unizero-sidebar__row {
            border-radius: 3px;
            border-left: 2px solid transparent;
          }
          .unizero-sidebar__row:hover {
            background: var(--fill-quinary, rgb(128 128 128 / 10%));
          }
          .unizero-sidebar__row[data-library-state="in"] {
            border-left-color: color-mix(in srgb, var(--accent-green, #57ab5a) 70%, transparent);
          }
          .unizero-sidebar__row[data-library-state="out"] {
            border-left-color: color-mix(in srgb, var(--accent-orange, #d29922) 55%, transparent);
          }
          .unizero-sidebar__row[data-library-state="out"] .unizero-sidebar__text {
            opacity: 0.7;
          }
          .unizero-sidebar__row[data-library-state="missing"] {
            border-left-color: var(--fill-tertiary, rgb(128 128 128 / 45%));
            opacity: 0.6;
          }
          .unizero-sidebar__row.is-expanded {
            background: var(--fill-quinary, rgb(128 128 128 / 8%));
          }
          .unizero-sidebar__row.is-drop-target {
            outline: 2px dashed var(--accent-blue, #4a8fe0);
            outline-offset: -2px;
          }
          .unizero-sidebar__head {
            display: flex;
            align-items: flex-start;
            gap: 4px;
            padding: 2px 4px;
            min-height: 20px;
            cursor: default;
          }
          .unizero-sidebar__chevron {
            flex: none;
            width: 10px;
            opacity: 0.6;
          }
          .unizero-sidebar__icon {
            flex: none;
            width: 14px;
            height: 14px;
            margin-top: 2px;
          }
          .unizero-sidebar__text {
            flex: 1;
            min-width: 0;
            line-height: 1.35;
            overflow-wrap: anywhere;
            /* At most two lines; an expanded row shows the whole title. */
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
            overflow: hidden;
          }
          .unizero-sidebar__row.is-expanded .unizero-sidebar__text {
            display: block;
            -webkit-line-clamp: unset;
          }
          .unizero-sidebar__number {
            opacity: 0.5;
          }
          .unizero-sidebar__credit {
            font-weight: 600;
          }
          .unizero-sidebar__title {
            opacity: 0.85;
          }
          .unizero-sidebar__badge {
            flex: none;
            padding: 0 5px;
            border-radius: 8px;
            font-size: 0.85em;
            background: var(--fill-quarternary, rgb(128 128 128 / 20%));
          }
          .unizero-sidebar__add {
            flex: none;
            padding: 0 5px;
            line-height: 1.2;
            font-weight: 600;
          }
          .unizero-sidebar__excerpts {
            padding: 2px 6px 6px 22px;
          }
          .unizero-sidebar__excerpt {
            display: flex;
            gap: 6px;
            align-items: flex-start;
            margin: 3px 0;
            padding: 3px 6px;
            border-left: 2px solid var(--accent-yellow, #ffd400);
            background: var(--fill-quinary, rgb(128 128 128 / 8%));
          }
          .unizero-sidebar__quote {
            flex: 1;
            min-width: 0;
            overflow-wrap: anywhere;
            cursor: pointer;
            font-style: italic;
          }
          .unizero-sidebar__quote:hover {
            text-decoration: underline;
          }
          .unizero-sidebar__excerpt-meta {
            flex: none;
            display: flex;
            gap: 4px;
            align-items: center;
            font-size: 0.85em;
            opacity: 0.75;
          }
          .unizero-sidebar__remove {
            padding: 0 5px;
          }
          .unizero-sidebar__drop-hint {
            margin-top: 4px;
            padding: 4px 6px;
            border: 1px dashed rgb(128 128 128 / 40%);
            border-radius: 4px;
            font-size: 0.85em;
            text-align: center;
            opacity: 0.6;
          }
          .unizero-sidebar__more {
            display: block;
            margin: 8px 6px;
          }
          /* PanelStatus (modules/status.ts) inserts this bar under the tabs. */
          .unizero-sidebar .reference-status {
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
          .unizero-sidebar .reference-status[data-type="success"] {
            border-left-color: var(--accent-green, #57ab5a);
          }
          .unizero-sidebar .reference-status[data-type="fail"] {
            border-left-color: var(--accent-red, #e5534b);
          }
          .unizero-sidebar .reference-status-headline {
            flex: none;
            font-weight: 600;
            opacity: 0.75;
          }
          .unizero-sidebar .reference-status-text {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            opacity: 0.9;
          }
          .unizero-sidebar .reference-status-progress {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 2px;
            border-radius: 0 0 4px 4px;
            overflow: hidden;
          }
          .unizero-sidebar .reference-status-progress-bar {
            height: 100%;
            width: 0;
            background: var(--accent-blue, #4a8fe0);
            transition: width 0.2s ease;
          }
          /* UniConnection full (ui/uniConnectionFull.ts): the same lists, two columns. */
          .unizero-full {
            box-sizing: border-box;
            padding: 8px 10px 10px;
            gap: 8px;
            font: message-box;
            color: var(--fill-primary, CanvasText);
            background: var(--material-background, Canvas);
          }
          .unizero-full__header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 0 6px 6px;
            border-bottom: 1px solid var(--material-border, rgb(128 128 128 / 30%));
          }
          .unizero-full__paper {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .unizero-full__credit {
            font-weight: 600;
          }
          .unizero-full__pin.is-active {
            background: var(--fill-quarternary, rgb(128 128 128 / 25%));
            font-weight: 600;
          }
          .unizero-full__body {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
          }
          .unizero-sidebar.is-full {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
            contain: none;
          }
          .unizero-sidebar__columns {
            flex: 1;
            min-height: 0;
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: 12px;
          }
          .unizero-sidebar__column {
            display: flex;
            flex-direction: column;
            min-width: 0;
            min-height: 0;
            border: 1px solid var(--material-border, rgb(128 128 128 / 30%));
            border-radius: 6px;
            padding-top: 6px;
          }
          .unizero-sidebar__heading {
            padding: 0 8px 6px;
            font-weight: 600;
          }
          .unizero-sidebar.is-full .unizero-sidebar__list {
            flex: 1;
            min-height: 0;
            max-height: none;
          }
          .unizero-sidebar__provider-actions {
            display: flex;
            gap: 6px;
            margin: 8px 6px;
          }
          .unizero-sidebar__provider-actions .unizero-sidebar__more {
            display: inline-block;
            margin: 0;
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
      // No <link rel="localization"> in the body: every section instance (library
      // pane and each reader tab) would add one to the main document, and closing a
      // reader tab removes it again, which drops the add-on's FTL from document.l10n
      // even though other links to it remain. Zotero's item-menu build then fails in
      // translateFragment and the item context menu never opens until restart. The
      // resource is inserted once per main window in hooks.onMainWindowLoad instead.
      bodyXHTML: "",
      header: {
        l10nID: `${config.addonRef}-itemPaneSection-header`,
        icon: `chrome://${config.addonRef}/content/icons/reference.svg`,
      },
      sidenav: {
        l10nID: `${config.addonRef}-itemPaneSection-sidenav`,
        icon: `chrome://${config.addonRef}/content/icons/reference-sidenav.svg`,
      },
      onItemChange: ({ body, item, tabType, setEnabled }: any) => {
        // The reader may not have been added to Zotero.Reader yet when this hook
        // runs. Hiding the section based on getReader() therefore makes it stay
        // invisible for the lifetime of the tab in Zotero 8/9.
        setEnabled(["library", "reader"].includes(tabType) && Boolean(item));
        if (["library", "reader"].includes(tabType)) { this.full.ownerChanged(body?.ownerDocument?.defaultView); }
      },
      onRender: ({ body, item, tabType }: any) => {
        if (!["library", "reader"].includes(tabType)) {
          this.sidebar.clear(body);
          return;
        }
        const paper = this.sectionPaper(body, item, tabType);
        // A standalone note or PDF has no paper: clear the section rather than leave
        // the previous paper's lists (and drop targets) under it.
        if (paper) { this.sidebar.render(body, paper); } else { this.sidebar.clear(body); }
      },
      onAsyncRender: async ({ body, tabType, setSectionSummary }: any) => {
        if (!["library", "reader"].includes(tabType)) { return; }
        setSectionSummary("");
        try {
          await this.sidebar.whenLoaded(body);
        } catch (error) {
          ztoolkit.log("Reference section async render failed", error);
        }
      },
    }) as string
    this.tabObserverID = Zotero.Notifier.registerObserver({
      notify: async (event: string, type: string) => {
        // The owner's current tab is re-read, so a switch in another window is a no-op.
        if (type === "tab" && event === "select") { this.full.ownerChanged(); }
      },
    }, ["tab"], `${config.addonRef}-uniconnection-full`);
  }

  public onDestroy() {
    this.full.close();
    if (this.tabObserverID) {
      Zotero.Notifier.unregisterObserver(this.tabObserverID);
      this.tabObserverID = undefined;
    }
    this.explorerReferences.dispose();
    this.explorerCitations.dispose();
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
    const identifiers = readItemPaperIdentifiers(item);
    return referencesCacheIsUsable(cached, identifiers) ? cached : undefined;
  }

  /**
   * The in-session copy of a relation record.
   *
   * It exists so a load survives caching being switched off, not as a second
   * source of truth — so it answers to the same identity checks the saved shard
   * does. Reading it unchecked kept a result fetched before the metadata was
   * completed alive for the rest of the session: the fetch prompt saw a loaded
   * relation and stopped offering the fetch that would have replaced it.
   */
  private sessionReferencesCache(
    key: string,
    identifiers: ItemPaperIdentifiers,
  ): ReferencesCache | undefined {
    const cached = this.explorerReferences.get(key);
    return referencesCacheIsUsable(cached, identifiers) ? cached : undefined;
  }

  private sessionCitationsCache(
    key: string,
    identifiers: ItemPaperIdentifiers,
  ): CitationsCache | undefined {
    const cached = this.explorerCitations.get(key);
    return citationsCacheIsUsable(cached, identifiers) ? cached : undefined;
  }

  private async saveReferencesCache(
    item: Zotero.Item,
    source: string,
    references: ItemBaseInfo[],
    resolved: boolean,
    perSource?: RelationSourceResult[],
    recordDiscovery = true,
    /** Set when re-saving a list that was not fetched again (see ReferencesCache.loadedAt). */
    loadedAt?: number,
  ): Promise<void> {
    const payload = makeReferencesCache(
      item,
      source,
      references,
      resolved,
      perSource,
      loadedAt,
    );
    const key = this.explorerKey(item);
    this.referencesWrites.set(key, (this.referencesWrites.get(key) || 0) + 1);
    this.explorerReferences.set(key, payload);
    const catalogSnapshot: PaperCatalogDiscoverySnapshot = {
      kind: "references",
      retrievedAt: payload.savedAt,
      merged: references.map(catalogSeedFromEntry),
      sources: (perSource || []).map((entry) => ({
        provider: entry.key,
        entries: entry.entries.map(catalogSeedFromEntry),
        complete: sourceSnapshotIsComplete(entry),
      })),
    };
    if (this.isCacheEnabled("saveAPIReferences")) {
      await localStorage.set(item, CACHE_KEY_REFERENCES, payload);
      // A cache write is not a Zotero item mutation and therefore emits no item
      // notification. Refresh the resident topology only after the bytes land.
      await uniConnection.ingestItem(item, false);
    }
    // Catalog storage is additive. A catalog conflict or damaged index must not
    // prevent the established References cache from being saved and rendered.
    if (recordDiscovery) { void this.ingestCatalogSnapshot(zoteroSeed(item), catalogSnapshot); }
  }

  private readCitationsCache(item: Zotero.Item): CitationsCache | undefined {
    if (!this.isCacheEnabled("saveCitations")) { return; }
    const identifiers = readItemPaperIdentifiers(item);
    const cached = localStorage.get(item, CACHE_KEY_CITATIONS) as CitationsCache | undefined;
    return citationsCacheIsUsable(cached, identifiers) ? cached : undefined;
  }

  private async persistCitationsCache(
    item: Zotero.Item,
    state: CitationsCache,
    recordDiscovery = true,
  ): Promise<void> {
    if (!state.all.length && !completedEmptyCitations(state)) { return; }
    const savedAt = Date.now();
    const normalized = { ...state, savedAt };
    this.explorerCitations.set(this.explorerKey(item), normalized);
    const catalogSnapshot: PaperCatalogDiscoverySnapshot = {
      kind: "citations",
      retrievedAt: savedAt,
      merged: state.all.map(catalogSeedFromEntry),
      sources: (state.perSource || []).map((entry) => ({
        provider: entry.key,
        entries: entry.entries.map(catalogSeedFromEntry),
        complete: sourceSnapshotIsComplete(entry),
      })),
    };
    if (this.isCacheEnabled("saveCitations")) {
      await localStorage.set(item, CACHE_KEY_CITATIONS, {
        ...normalized,
        savedAt,
        all: forPersistence(state.all, state.source),
        perSource: persistRelationSources(state.perSource),
      });
    }
    if (recordDiscovery) { void this.ingestCatalogSnapshot(zoteroSeed(item), catalogSnapshot); }
  }

  private explorerKey(item: Zotero.Item): string {
    return `${item.libraryID}:${item.key}`;
  }

  private ingestCatalogSnapshot(
    seed: LiteratureSeed,
    snapshot: PaperCatalogDiscoverySnapshot,
  ): Promise<PaperCatalogDiscoveryResult | undefined> {
    const key = `${seed.libraryID}:${seed.itemKey}:${snapshot.kind}:${snapshot.retrievedAt}`;
    const existing = this.catalogIngestions.get(key);
    if (existing) { return existing; }
    // The seed binds its Paper on the way in.
    const ingestion = recordCatalogDiscoverySnapshot(seed.item, snapshot)
      .catch((error) => {
        ztoolkit.log("Literature catalog ingestion failed", error);
        return undefined;
      });
    this.catalogIngestions.set(key, ingestion);
    while (this.catalogIngestions.size > 64) {
      const oldest = this.catalogIngestions.keys().next().value;
      if (typeof oldest === "string") { this.catalogIngestions.delete(oldest); }
    }
    return ingestion;
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
    seed: LiteratureSeed,
    kind: LiteratureRelationKind,
    merged: ItemBaseInfo[],
    perSource: RelationSourceResult[],
    total: number,
    hasMore: boolean,
    source: string,
    retrievedAt = Date.now(),
    recordDiscovery = true,
  ): Promise<LiteratureSnapshot> {
    const bySource: Partial<Record<RelationSourceKey, LiteratureCandidate[]>> = {};
    const sources: LiteratureSourceView[] = [];
    const sourceCandidates: LiteratureCandidate[][] = [];
    for (const entry of perSource) {
      if (entry.entries.length) {
        const candidates = await this.candidatesWithMembership(
          seed.libraryID,
          entry.entries,
        );
        bySource[entry.key] = candidates;
        sourceCandidates.push(candidates);
      } else {
        sourceCandidates.push([]);
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
    const candidates = await this.candidatesWithMembership(
      seed.libraryID,
      merged,
    );
    if (recordDiscovery) {
      void this.ingestCatalogSnapshot(seed, {
        kind: kind as "references" | "citations",
        retrievedAt,
        merged: candidates.map(catalogSeed),
        sources: perSource.map((entry, index) => ({
          provider: entry.key,
          entries: sourceCandidates[index].map(catalogSeed),
          complete: sourceSnapshotIsComplete(entry),
        })),
      }).then((observed) => {
        if (observed) {
          candidates.forEach((candidate, index) => {
            candidate.paperID = observed.mergedPaperIDs[index];
          });
          perSource.forEach((entry, sourceIndex) => {
            const sourceList = bySource[entry.key] || [];
            sourceList.forEach((candidate, entryIndex) => {
              candidate.paperID = observed.sourcePaperIDs[sourceIndex]?.[entryIndex];
            });
          });
        }
      });
    }
    return {
      kind,
      seed: {
        libraryID: seed.libraryID,
        itemKey: seed.itemKey,
        title: seed.title,
      },
      source,
      total,
      loaded: merged.length,
      hasMore,
      items: candidates,
      sources,
      bySource,
    };
  }

  /** Bridge projection only: no provider repair, attachment promotion or catalog writes. */
  public async getCachedLiteratureSnapshot(
    item: Zotero.Item,
    kind: LiteratureRelationKind,
  ): Promise<LiteratureSnapshot | undefined> {
    if (kind === "relation") { return this.getUniConnectionSnapshot(item, false); }
    await localStorage.load(item);
    const key = this.explorerKey(item);
    const identifiers = readItemPaperIdentifiers(item);
    const references = kind === "references"
      ? this.readReferencesCache(item) || this.sessionReferencesCache(key, identifiers)
      : undefined;
    const citations = kind === "citations"
      ? this.readCitationsCache(item) || this.sessionCitationsCache(key, identifiers)
      : undefined;
    const state = references || citations;
    if (!state) { return; }
    const entries = references?.references || citations!.all;
    // The bridge uses the combined list only. Membership is a local, read-only
    // projection; deliberately do not call buildCombinedSnapshot, which ingests.
    return {
      kind,
      seed: { libraryID: item.libraryID, itemKey: item.key, title: String(item.getField("title") || "") },
      source: state.source,
      total: references ? entries.length : citations!.total,
      loaded: citations ? citations.loaded || entries.length : entries.length,
      hasMore: citations ? this.citationsHasMore(citations) : false,
      items: await this.candidatesWithMembership(item.libraryID, entries.map((entry) => ({ ...entry }))),
      sources: [],
      bySource: {},
    };
  }

  /**
   * Parse the runtime's raw, local-only bibliography records into the minimal
   * ItemBaseInfo shape used by both References surfaces.
   */
  private async parsedZoMinerReferences(
    item: Zotero.Item,
  ): Promise<ItemBaseInfo[] | null> {
    const extracted = await readZoMinerReferences(item);
    if (!extracted?.length) { return extracted; }
    return extracted.map((reference) => {
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
  }

  /**
   * Shared data entry point for the UniConnection lists and the bridge. It reads
   * the same per-item shards as the item pane; when a shard is missing it fetches
   * through the established providers and writes the normal cache shape, so the
   * full window never creates a parallel source of truth.
   */
  public async getLiteratureSnapshot(
    item: Zotero.Item,
    kind: LiteratureRelationKind,
    refresh = false,
    options: { recordDiscovery?: boolean } = {},
  ): Promise<LiteratureSnapshot> {
    // Explicit bridge fetches may populate the provider cache, but GET never
    // writes the Paper catalog. Existing Zotero callers retain catalog ingestion.
    const recordDiscovery = options.recordDiscovery !== false;
    if (kind === "relation") {
      return this.getUniConnectionSnapshot(item, refresh);
    }
    await localStorage.load(item);
    const key = this.explorerKey(item);
    const identifiers = readItemPaperIdentifiers(item);

    if (kind === "references") {
      let state = refresh
        ? undefined
        : (this.readReferencesCache(item) ||
          this.sessionReferencesCache(key, identifiers));
      // A completed empty provider lookup remains a valid diagnostic cache, but a
      // later conversion may have added local PDF evidence. Promote that evidence
      // without discarding the preserved per-source statuses.
      if (state && !state.references.length) {
        const extracted = await this.parsedZoMinerReferences(item);
        if (extracted?.length) {
          state = {
            ...state,
            savedAt: Date.now(),
            source: "ZoMiner",
            references: extracted,
          };
          this.explorerReferences.set(key, state);
          await this.saveReferencesCache(
            item,
            state.source,
            state.references,
            state.resolved,
            state.perSource,
            recordDiscovery,
          );
        }
      }
      if (!state) {
        const result = await fetchReferencesByIdentifiers(
          identifiers.doi,
          identifiers.semanticScholarPaperId,
        );
        let references = result?.references || [];
        let source = result?.source || "none";
        if (!references.length) {
          const extracted = await this.parsedZoMinerReferences(item);
          if (extracted?.length) {
            references = extracted;
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
        await this.saveReferencesCache(
          item,
          state.source,
          state.references,
          state.resolved,
          state.perSource,
          recordDiscovery,
        );
      }
      // Upgrade Crossref "DOI-only" rows to real bibliographic data. The item-pane
      // box does this through resolveReferences; the explorer path returns records
      // instead of mutating rows, so without this those entries display a bare DOI
      // forever. No-op once the placeholders are filled, so reopening is cheap.
      await this.fillReferencePlaceholders(state, (filled) =>
        this.saveReferencesCache(
          item,
          filled.source,
          filled.references,
          filled.resolved,
          filled.perSource,
          recordDiscovery,
          filled.loadedAt ?? filled.savedAt,
        ));
      return this.buildCombinedSnapshot(
        zoteroSeed(item),
        kind,
        state.references,
        state.perSource || [],
        state.references.length,
        false,
        state.source,
        state.savedAt,
        recordDiscovery,
      );
    }

    let state = refresh
      ? undefined
      : (this.readCitationsCache(item) ||
        this.sessionCitationsCache(key, identifiers));
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
      await this.persistCitationsCache(item, state, recordDiscovery);
    }
    return this.buildCombinedSnapshot(
      zoteroSeed(item),
      kind,
      state.all,
      state.perSource || [],
      state.total,
      this.citationsHasMore(state),
      state.source,
      state.savedAt,
      recordDiscovery,
    );
  }

  /**
   * Read-only projection of the derived library relation index.
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
        savedAt: Date.now(),
        perSource: advanced,
        all: merged,
        loaded: merged.length,
        total: Math.max(state.total, ...advanced.map((entry) => entry.total)),
        page: Math.max(0, ...advanced.map((entry) => entry.page || 0)),
      };
      this.explorerCitations.set(key, state);
      await this.persistCitationsCache(item, state);
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
          savedAt: Date.now(),
          page: state.page + 1,
          loaded: state.loaded + result.citations.length,
          all: [...state.all, ...result.citations],
        };
        this.explorerCitations.set(key, state);
        await this.persistCitationsCache(item, state);
      }
    }
    return this.buildCombinedSnapshot(
      zoteroSeed(item),
      "citations",
      state.all,
      state.perSource || [],
      state.total,
      this.citationsHasMore(state),
      state.source,
      state.savedAt,
    );
  }

  public async addLiteratureCandidateToLibrary(
    destination: PaperDestination,
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
    const { libraryID } = destination;
    const existing = (await resolveLibraryMembership(libraryID, [entry])).get(entry);
    if (existing) {
      return { inLibrary: true, libraryID, itemID: existing.id };
    }

    const created = await createDiscoveredPaper(destination, {
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
    invalidateLibraryMembership(libraryID);
    return { inLibrary: true, libraryID, itemID: created.id };
  }

  /**
   * The paper a section shows: the item itself, or in a reader tab (or for a
   * selected attachment or note) its parent.
   */
  private sectionPaper(body: Element, item: Zotero.Item | undefined, tabType: string): Zotero.Item | undefined {
    if (tabType === "reader") {
      const reader = this.getReaderForBody(body);
      const attachment = reader && Zotero.Items.get((reader as any).itemID || (reader as any)._itemID);
      const parent = attachment?.parentItem;
      if (parent) { return parent; }
    }
    if (!item) { return; }
    return item.isRegularItem() ? item : item.parentItem || undefined;
  }

  /** The sidebar's view of this data plane; see LiteratureSidebarPort. */
  private sidebarPort(): LiteratureSidebarPort {
    return {
      cachedReferences: (item) => this.getCachedLiteratureSnapshot(item, "references"),
      fetchReferences: (item, refresh) => this.getLiteratureSnapshot(item, "references", refresh),
      canFetchReferences: (item) => {
        const identifiers = readItemPaperIdentifiers(item);
        // References can also come from the conversion's extracted bibliography.
        return Boolean(identifiers.doi || identifiers.semanticScholarPaperId || findReferencesAttachment(item));
      },
      resolvePendingReferences: (item) => this.resolvePendingReferences(item),
      cachedCitations: (item) => this.getCachedLiteratureSnapshot(item, "citations"),
      fetchCitations: (item, refresh) => this.getLiteratureSnapshot(item, "citations", refresh),
      loadMoreCitations: (item) => this.loadMoreLiteratureCitations(item),
      addToLibrary: (item, candidate) =>
        this.addLiteratureCandidateToLibrary(paperDestinationFromItem(item), candidate),
      openFull: (win, item) => this.openFull(win, item),
      attachTip: (element, candidate, item) => this.attachTip(element, candidate, item),
    };
  }

  /**
   * Finish resolving a cached References list whose rows still lack a title — raw
   * citation text, or Crossref's DOI-only rows. The sidebar calls this in the
   * background on every open until the shard is marked resolved. Writes the shard
   * only when something resolved, and marks it resolved only when the whole batch
   * reached the providers. A list written meanwhile (a Refresh) wins: this run's
   * older copy is dropped rather than saved over it.
   */
  public async resolvePendingReferences(item: Zotero.Item): Promise<boolean> {
    await localStorage.load(item);
    const cached = this.readReferencesCache(item);
    if (!cached || cached.resolved) { return false; }
    const key = this.explorerKey(item);
    const writes = this.referencesWrites.get(key) || 0;
    const references = cached.references;
    const pending = references.filter((reference) =>
      !reference.title && (reference.text || reference.identifiers?.DOI));
    let changed = false;
    const { failed } = pending.length
      ? await resolveMany(
        pending.map((reference) => ({ raw: reference.text || "", identifiers: reference.identifiers })),
        (position, info) => {
          if (!info) { return; }
          const reference = pending[position];
          // A low-confidence result is a guess: it may be shown, never stored as
          // identity — "+" would otherwise import the wrong paper from it.
          if (info.lowConfidence) {
            reference.lowConfidence = true;
            reference.abstract = info.abstract || reference.abstract;
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
          if (reference._placeholderText && info.title) {
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
      )
      : { failed: 0 };
    if ((this.referencesWrites.get(key) || 0) !== writes) { return false; }
    const complete = failed === 0;
    if (changed || complete) {
      await this.saveReferencesCache(item, cached.source, references, complete, cached.perSource, true,
        cached.loadedAt ?? cached.savedAt);
    }
    return changed;
  }

  /**
   * The hover card for a provider row (the "isShowTip" preference), shared by the
   * sidebar's rows. Shows after a delay and lingers while the pointer moves onto it.
   */
  private attachTip(element: HTMLElement, candidate: LiteratureCandidate, item?: Zotero.Item): void {
    const reference = {
      identifiers: { ...(candidate.identifiers || {}) },
      title: candidate.title,
      text: candidate.text || candidate.title,
      authors: candidate.authors || [],
      year: candidate.year,
      abstract: candidate.abstract,
      primaryVenue: candidate.primaryVenue,
      source: candidate.source,
      tags: [],
      _item: item,
    } as unknown as ItemInfo;
    const idText = Object.entries(candidate.identifiers || {})
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${value}`)[0] || "Reference";
    const win = element.ownerDocument.defaultView!;
    let timer: number | undefined;
    let tipUI: TipUI | undefined;
    element.addEventListener("mouseenter", () => {
      if (!Zotero.Prefs.get(`${config.addonRef}.isShowTip`)) { return; }
      element.classList.add("active");
      // The stacked item pane sits below the list, so the card goes above the row; that
      // layout is the main window's, not UniConnection full's.
      const stacked = Zotero.Prefs.get("extensions.zotero.layout", true) == "stacked" && Boolean((win as any).ZoteroPane);
      const position = stacked ? "top center" : "left";
      timer = win.setTimeout(() => {
        const rect = element.getBoundingClientRect();
        rect.x -= 5;
        tipUI = this.showTipUI(rect, reference, position, idText, win);
        if (!element.classList.contains("active")) { tipUI.container.style.display = "none"; }
      }, TIP_SHOW_DELAY_MS);
    });
    element.addEventListener("mouseleave", () => {
      element.classList.remove("active");
      win.clearTimeout(timer);
      if (!tipUI) { return; }
      const current = tipUI;
      const timeout = current.removeTipAfterMillisecond;
      const list = element.closest(".unizero-sidebar__list");
      current.tipTimer = win.setTimeout(async () => {
        for (let i = 0; i < timeout / 2; i++) {
          if (list?.querySelector(".active")) { return; }
          await Zotero.Promise.delay(1 / 1000);
        }
        current.clear();
      }, timeout / 2);
    });
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
    state: ReferencesCache,
    persist: (state: ReferencesCache) => Promise<void>,
  ): Promise<void> {
    const pending = state.references
      .map((reference, index) => ({ reference, index }))
      .filter(({ reference }) =>
        !reference.title &&
        reference.identifiers?.DOI &&
        !reference._placeholderUnresolved);
    if (!pending.length) { return; }
    let changed = false;
    const unresolved: number[] = [];
    const { failed } = await resolveMany(
      pending.map(({ reference }) => ({
        raw: reference.text || "",
        identifiers: reference.identifiers,
      })),
      (position, info) => {
        // A low-confidence guess or a titleless result leaves the placeholder as it
        // was; only a confident, titled match is worth writing over the DOI row.
        if (!info || info.lowConfidence || !info.title) {
          unresolved.push(position);
          return;
        }
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
    // Record the rows the providers answered about but could not identify. Without
    // this the whole batch is retried on every open — resolveOne's memo only spans
    // the session — so a shard full of unresolvable DOI rows spent the same
    // requests, and the same wait, after every restart. A transport failure
    // anywhere in the batch leaves every entry retryable: the per-entry callback
    // cannot tell "no such paper" from "never reached the API". An explicit
    // refresh rebuilds the rows from the providers and so clears the marks.
    if (!failed) {
      for (const position of unresolved) {
        const { reference } = pending[position];
        if (reference._placeholderUnresolved) { continue; }
        reference._placeholderUnresolved = true;
        changed = true;
      }
    }
    // Persist so the enrichment survives the session; unchanged runs (nothing
    // resolved) skip the write to avoid needless cache churn and a bumped savedAt.
    if (changed) { await persist(state); }
  }

  public showTipUI(refRect: Rect, reference: ItemInfo, position: string, idText?: string, win?: Window) {
    let toTimeInfo = (t: string) => {
      if (!t) { return undefined }
      let info = (new Date(t)).toString().split(" ")
      return `${info[1]} ${info[3]}`
    }
    let tipUI = new TipUI(win)
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
            : (info.url || this.utils.identifiers2URL(info.identifiers) || undefined),
          // A paper already in the library opens there (its PDF), not on the web.
          reference._item || undefined
        )
      })
    }
    return tipUI
  }
}
