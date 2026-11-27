import { config, version } from "../../package.json";
import { initLocale } from "../utils/locale";
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

  /**
   * The data plane behind Uniconnection's Bibliography, the bridge and the MCP
   * server. It draws nothing itself: the item-pane section and UniConnection full
   * were retired (docs/UNICONNECTION.md §4.1).
   */
  public async onInit() {
    // Log the version: the most time-consuming part of this round of debugging was
    // telling "the feature is broken" apart from "an old build is still installed".
    ztoolkit.log(`${config.addonName} ${version} starting`);
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
  }

  public onDestroy() {
    this.explorerReferences.dispose();
    this.explorerCitations.dispose();
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
}
