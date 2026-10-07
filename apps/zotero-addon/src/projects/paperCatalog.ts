/**
 * Durable Paper catalog shared by library and Board-pinned papers.
 *
 * A Zotero item is a binding on a stable Paper document, not the Paper ID itself.
 * Reliable identifier aliases let an external discovery become Zotero-bound later
 * without changing BoardNode.paperID. Ambiguous alias conflicts are rejected rather
 * than silently merging two Papers.
 */

import { config } from "../../package.json";
import { isMissingFile } from "../utils/fileState";
import { compareCodeUnits } from "../utils/ordering";
import { SerialQueue } from "../utils/serialQueue";
import { literatureCandidateFromItem } from "../zotero/literatureCollectionAdapter";
import { libraryScope } from "../zotero/libraryScope";
import {
  createProjectObjectID,
  type ProjectObjectKind,
} from "./projectRepository";
import {
  LITERATURE_OBSERVATION_SCHEMA,
  PAPER_SCHEMA,
  PAPER_REDIRECT_SCHEMA,
  type LiteratureCitationObservation,
  type PaperDocument,
  type PaperIdentifiers,
  type PaperRedirectDocument,
  type ZoteroPaperBinding,
} from "./types";

const PAPER_INDEX_SCHEMA = 1;
const OBSERVATION_INDEX_SCHEMA = 2;
const LEGACY_OBSERVATION_INDEX_SCHEMA = 1;

interface PaperIndexDocument {
  schema: number;
  bindings: Record<string, string>;
  aliases: Record<string, string>;
  provisionals: Record<string, string>;
  redirects: Record<string, string>;
}

interface ObservationIndexDocument {
  schema: number;
  keys: Record<string, string>;
  byPaper: Record<string, string[]>;
}

interface PaperCatalogOptions {
  now?: () => number;
  createID?: (kind: ProjectObjectKind) => string;
}

export interface PaperCatalogSeed {
  identifiers: PaperDocument["identifiers"];
  title: string;
  authors: string[];
  year?: string;
  type?: string;
  primaryVenue?: string;
  abstract?: string;
  sourceOrder?: number;
}

export interface PaperCatalogDiscoverySource {
  provider: string;
  entries: PaperCatalogSeed[];
  /**
   * True only when this is a successful terminal result, not one page or a
   * provider failure. A complete snapshot can replace older observations for
   * the same seed/query/provider route.
   */
  complete?: boolean;
}

export interface PaperCatalogDiscoverySnapshot {
  kind: "references" | "citations";
  retrievedAt: number;
  merged: PaperCatalogSeed[];
  sources: PaperCatalogDiscoverySource[];
}

export interface PaperCatalogDiscoveryResult {
  seedPaperID: string;
  mergedPaperIDs: string[];
  sourcePaperIDs: string[][];
  observations: LiteratureCitationObservation[];
  removedObservationIDs: string[];
  garbageCollectedPaperIDs: string[];
}

export interface PaperIdentifierInspection {
  aliases: string[];
  paperIDs: string[];
  status: "unmatched" | "matched" | "conflict";
}

export interface PaperCatalogMergeResult {
  paper: PaperDocument;
  redirect: PaperRedirectDocument;
  removedObservationIDs: string[];
}

export interface PaperCatalogGarbageCollection {
  removedPaperIDs: string[];
}

function defaultDataDirectory(): string {
  const dir = (Zotero as any).DataDirectory?.dir;
  if (typeof dir === "string" && dir) { return dir; }
  return Zotero.getTempDirectory().parent.path;
}

function bindingKey(binding: ZoteroPaperBinding): string {
  return `${binding.library}:${binding.itemKey}`;
}

/**
 * Alias keys are persisted and compared across devices, so this folds case with
 * the invariant mapping rather than the host locale's. See `utils/ordering`.
 */
function normalIdentifier(value: string | undefined): string | undefined {
  const normal = String(value || "").trim().toLowerCase();
  return normal || undefined;
}

function identifierAliases(
  identifiers: PaperDocument["identifiers"],
): string[] {
  return [
    ["doi", normalIdentifier(identifiers.doi)?.replace(
      /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/,
      "",
    )],
    ["arxiv", normalIdentifier(identifiers.arxiv)?.replace(/^arxiv:\s*/, "")],
    ["s2", normalIdentifier(identifiers.semanticScholarPaperId)],
    ["openalex", normalIdentifier(identifiers.openAlexId)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([kind, value]) => `${kind}:${value}`);
}

function paperIDForAliases(
  index: PaperIndexDocument,
  aliases: string[],
): string | undefined {
  const matches = new Set(
    aliases
      .map((alias) => index.aliases[alias])
      .filter(Boolean)
      .map((paperID) => resolveIndexedPaperID(index, paperID)),
  );
  if (matches.size > 1) {
    throw new Error("Paper identifiers resolve to conflicting catalog records");
  }
  return [...matches][0];
}

function resolveIndexedPaperID(
  index: PaperIndexDocument,
  paperID: string,
): string {
  let current = paperID;
  const visited = new Set<string>();
  while (index.redirects[current]) {
    if (visited.has(current)) {
      throw new Error(`Paper redirect cycle detected at ${current}`);
    }
    visited.add(current);
    current = index.redirects[current];
  }
  return current;
}

function observationNaturalKey(
  input: Pick<
    LiteratureCitationObservation,
    "queryKind" | "provider" | "citingPaperID" | "citedPaperID"
  >,
): string {
  return [
    input.queryKind,
    String(input.provider || "unknown").trim().toLowerCase(),
    input.citingPaperID,
    input.citedPaperID,
  ].join("\u0000");
}

function emptyObservationIndex(): ObservationIndexDocument {
  return {
    schema: OBSERVATION_INDEX_SCHEMA,
    keys: {},
    byPaper: {},
  };
}

function addObservationAdjacency(
  byPaper: Record<string, string[]>,
  observation: Pick<
    LiteratureCitationObservation,
    "id" | "citingPaperID" | "citedPaperID"
  >,
): Record<string, string[]> {
  const next = { ...byPaper };
  for (const paperID of new Set([
    observation.citingPaperID,
    observation.citedPaperID,
  ])) {
    const ids = next[paperID] || [];
    if (!ids.includes(observation.id)) {
      next[paperID] = [...ids, observation.id].sort();
    }
  }
  return next;
}

function removeObservationAdjacency(
  byPaper: Record<string, string[]>,
  observationID: string,
  paperIDs: Iterable<string>,
): Record<string, string[]> {
  const next = { ...byPaper };
  for (const paperID of new Set(paperIDs)) {
    const ids = next[paperID];
    if (!ids?.includes(observationID)) { continue; }
    const retained = ids.filter((id) => id !== observationID);
    if (retained.length) {
      next[paperID] = retained;
    } else {
      delete next[paperID];
    }
  }
  return next;
}

function observationAdjacency(
  observations: Iterable<LiteratureCitationObservation>,
): Record<string, string[]> {
  let byPaper: Record<string, string[]> = {};
  for (const observation of observations) {
    byPaper = addObservationAdjacency(byPaper, observation);
  }
  return byPaper;
}

function validStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>)
      .every((entry) => typeof entry === "string");
}

function validStringArrayRecord(
  value: unknown,
): value is Record<string, string[]> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>)
      .every((entry) =>
        Array.isArray(entry) &&
        entry.every((id) => typeof id === "string"));
}

type DiscoveryFingerprintInput = Pick<
  PaperCatalogSeed,
  "title" | "year" | "authors"
>;

function discoveryMatchKey(seed: DiscoveryFingerprintInput): string {
  return JSON.stringify([
    String(seed.title || "").normalize("NFKC").trim().toLowerCase(),
    String(seed.year || "").trim(),
    String(seed.authors?.[0] || "").normalize("NFKC").trim().toLowerCase(),
  ]);
}

function provisionalPaperKey(
  seedPaperID: string,
  queryKind: "references" | "citations",
  route: string,
  seed: DiscoveryFingerprintInput,
  occurrence: number,
): string {
  return [
    seedPaperID,
    queryKind,
    String(route || "combined").trim().toLowerCase(),
    discoveryMatchKey(seed),
    occurrence,
  ].join("\u0000");
}

function nextFingerprintOccurrence(
  occurrences: Map<string, number>,
  seed: DiscoveryFingerprintInput,
): number {
  const fingerprint = discoveryMatchKey(seed);
  const occurrence = occurrences.get(fingerprint) || 0;
  occurrences.set(fingerprint, occurrence + 1);
  return occurrence;
}

function retentionRank(retention: PaperDocument["retention"]): number {
  return { cache: 0, pinned: 1, zotero: 2 }[retention];
}

function samePaperContent(
  left: PaperDocument,
  right: PaperDocument,
): boolean {
  const content = (paper: PaperDocument) => ({
    identifiers: paper.identifiers,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    type: paper.type,
    primaryVenue: paper.primaryVenue,
    abstract: paper.abstract,
    bindings: paper.bindings,
    canonicalBinding: paper.canonicalBinding,
    retention: paper.retention,
  });
  return JSON.stringify(content(left)) === JSON.stringify(content(right));
}

export class PaperCatalog {
  private readonly now: () => number;
  private readonly createID: (kind: ProjectObjectKind) => string;
  private index?: PaperIndexDocument;
  private observationIndex?: ObservationIndexDocument;
  private readonly writes = new SerialQueue();
  private batchDepth = 0;
  private paperIndexDirty = false;
  private observationIndexDirty = false;
  private pendingObservationRemovals = new Set<string>();

  public constructor(
    private readonly root: string,
    options: PaperCatalogOptions = {},
  ) {
    this.now = options.now || (() => Date.now());
    this.createID = options.createID || createProjectObjectID;
  }

  public async ensureZoteroPaper(item: Zotero.Item): Promise<PaperDocument> {
    return this.writes.run(() => this.ensureZoteroPaperExclusive(item));
  }

  public async ensureExternalPaper(
    seed: PaperCatalogSeed,
  ): Promise<PaperDocument> {
    return this.writes.run(() => this.ensureExternalPaperExclusive(seed));
  }

  public async pinPaper(paperID: string): Promise<PaperDocument> {
    let result!: PaperDocument;
    await this.writes.run(async () => {
      const existing = await this.readPaperDirect(
        await this.resolvePaperIDDirect(paperID),
      );
      if (retentionRank(existing.retention) >= retentionRank("pinned")) {
        result = existing;
        return;
      }
      result = {
        ...existing,
        retention: "pinned",
        updatedAt: this.now(),
      };
      await this.writeJSON(this.paperPath(existing.id), result);
    });
    return result;
  }

  public async recordDiscoverySnapshot(
    seedItem: Zotero.Item,
    snapshot: PaperCatalogDiscoverySnapshot,
  ): Promise<PaperCatalogDiscoveryResult> {
    return this.writes.run(() => this.recordDiscoverySnapshotExclusive(
          (catalog) => catalog.ensureZoteroPaperExclusive(seedItem),
          snapshot,
        ));
  }

  /**
   * The same recording for a seed that has no Zotero item — a Board card pinned
   * from a reference list. Only how the seed Paper is obtained differs; the
   * observations, provenance, and compaction are identical, because a discovery
   * route is a property of the Paper, not of whether Zotero happens to hold it.
   */
  public async recordExternalDiscoverySnapshot(
    seedPaperID: string,
    snapshot: PaperCatalogDiscoverySnapshot,
  ): Promise<PaperCatalogDiscoveryResult> {
    return this.writes.run(() => this.recordDiscoverySnapshotExclusive(
          async (catalog) =>
            catalog.readPaperDirect(
              await catalog.resolvePaperIDDirect(seedPaperID),
            ),
          snapshot,
        ));
  }

  public async listCitationObservations(
    paperID?: string,
  ): Promise<LiteratureCitationObservation[]> {
    await this.writes.settled();
    const index = await this.loadObservationIndex();
    const resolvedPaperID = paperID
      ? await this.resolvePaperIDDirect(paperID)
      : undefined;
    const ids = resolvedPaperID
      ? [...new Set(index.byPaper[resolvedPaperID] || [])].sort()
      : [...new Set(Object.values(index.keys))].sort();
    const observations = await Promise.all(ids.map((id) =>
      this.readObservationDirect(id)));
    return observations;
  }

  public async listCitationObservationsForPapers(
    paperIDs: Iterable<string>,
  ): Promise<LiteratureCitationObservation[]> {
    await this.writes.settled();
    const index = await this.loadObservationIndex();
    const resolvedPaperIDs = await Promise.all(
      [...new Set(paperIDs)].map((paperID) =>
        this.resolvePaperIDDirect(paperID)),
    );
    const ids = [...new Set(resolvedPaperIDs.flatMap((paperID) =>
      index.byPaper[paperID] || []))].sort();
    return Promise.all(ids.map((id) => this.readObservationDirect(id)));
  }

  public async readPaper(paperID: string): Promise<PaperDocument> {
    await this.writes.settled();
    return this.readPaperDirect(await this.resolvePaperIDDirect(paperID));
  }

  public async resolvePaperID(paperID: string): Promise<string> {
    await this.writes.settled();
    return this.resolvePaperIDDirect(paperID);
  }

  public async inspectIdentifiers(
    identifiers: PaperIdentifiers,
  ): Promise<PaperIdentifierInspection> {
    await this.writes.settled();
    const index = await this.loadIndex();
    const aliases = identifierAliases(identifiers);
    const paperIDs = [...new Set(
      aliases
        .map((alias) => index.aliases[alias])
        .filter(Boolean)
        .map((paperID) => resolveIndexedPaperID(index, paperID)),
    )].sort();
    return {
      aliases,
      paperIDs,
      status: paperIDs.length > 1
        ? "conflict"
        : paperIDs.length
        ? "matched"
        : "unmatched",
    };
  }

  public async listPaperRedirects(): Promise<PaperRedirectDocument[]> {
    await this.writes.settled();
    const index = await this.loadIndex();
    const sources = Object.keys(index.redirects).sort();
    return Promise.all(sources.map((source) => this.readRedirectDirect(source)));
  }

  public async mergePapers(
    preferredPaperID: string,
    duplicatePaperID: string,
  ): Promise<PaperCatalogMergeResult> {
    return this.writes.run(() => this.mergePapersExclusive(
          preferredPaperID,
          duplicatePaperID,
        ));
  }

  public async collectGarbage(
    protectedPaperIDs: Iterable<string> = [],
  ): Promise<PaperCatalogGarbageCollection> {
    return this.writes.run(() => this.collectGarbageExclusive(protectedPaperIDs));
  }

  private async ensureZoteroPaperExclusive(
    item: Zotero.Item,
  ): Promise<PaperDocument> {
    const binding: ZoteroPaperBinding = {
      library: libraryScope(item.libraryID),
      itemKey: String(item.key),
    };
    const key = bindingKey(binding);
    const index = await this.loadIndex();
    const candidate = literatureCandidateFromItem(item);
    const identifiers: PaperDocument["identifiers"] = {
      doi: candidate.identifiers.DOI || undefined,
      arxiv: candidate.identifiers.arXiv || undefined,
      semanticScholarPaperId: candidate.identifiers.paperID || undefined,
    };
    const aliases = identifierAliases(identifiers);
    const aliasID = paperIDForAliases(index, aliases);
    const bindingID = index.bindings[key]
      ? resolveIndexedPaperID(index, index.bindings[key])
      : undefined;
    if (bindingID && aliasID && bindingID !== aliasID) {
      // An item catalogued before its metadata carried an identifier gets a
      // Paper that is nothing but the binding, while the same work may already
      // be in the catalog under the DOI another paper's reference list named.
      // Completing the metadata makes the two meet. A binding is not a second
      // identity, so the identifier-less record folds into the identified one
      // and the item goes on being catalogued; only two records that each
      // assert an identifier are a real conflict, because merging those would
      // silently fuse papers the user still has to tell apart.
      const bound = await this.readPaperDirect(bindingID);
      if (identifierAliases(bound.identifiers).length) {
        throw new Error(
          "Zotero binding conflicts with an existing Paper identity",
        );
      }
      await this.mergePapersExclusive(aliasID, bindingID);
      return this.ensureZoteroPaperExclusive(item);
    }
    const knownID = bindingID || aliasID;
    const timestamp = this.now();
    const existing = knownID ? await this.readPaperDirect(knownID) : undefined;
    const canonicalBinding = existing?.canonicalBinding ||
      existing?.bindings[0] ||
      binding;
    const metadataOwner = bindingKey(canonicalBinding) === key;
    const mergedIdentifiers: PaperDocument["identifiers"] = {
      doi: metadataOwner
        ? identifiers.doi || existing?.identifiers.doi
        : existing?.identifiers.doi || identifiers.doi,
      arxiv: metadataOwner
        ? identifiers.arxiv || existing?.identifiers.arxiv
        : existing?.identifiers.arxiv || identifiers.arxiv,
      semanticScholarPaperId: metadataOwner
        ? identifiers.semanticScholarPaperId ||
          existing?.identifiers.semanticScholarPaperId
        : existing?.identifiers.semanticScholarPaperId ||
          identifiers.semanticScholarPaperId,
      openAlexId: metadataOwner
        ? identifiers.openAlexId || existing?.identifiers.openAlexId
        : existing?.identifiers.openAlexId || identifiers.openAlexId,
    };
    const paperID = existing?.id || this.createID("paper");
    const bindings = existing?.bindings?.some(
      (entry) => bindingKey(entry) === key,
    )
      ? existing.bindings
      : [...(existing?.bindings || []), binding];
    const paper: PaperDocument = {
      schema: PAPER_SCHEMA,
      id: paperID,
      identifiers: mergedIdentifiers,
      title: metadataOwner
        ? candidate.title || "Untitled"
        : existing?.title || candidate.title || "Untitled",
      authors: metadataOwner
        ? candidate.authors || []
        : existing?.authors || candidate.authors || [],
      year: metadataOwner ? candidate.year : existing?.year || candidate.year,
      type: metadataOwner ? candidate.type : existing?.type || candidate.type,
      primaryVenue: metadataOwner
        ? candidate.primaryVenue
        : existing?.primaryVenue || candidate.primaryVenue,
      abstract: metadataOwner
        ? candidate.abstract
        : existing?.abstract || candidate.abstract,
      bindings,
      canonicalBinding,
      retention: "zotero",
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    const aliasesComplete = identifierAliases(mergedIdentifiers).every(
      (alias) => index.aliases[alias] === paperID,
    );
    if (
      existing &&
      samePaperContent(existing, paper) &&
      index.bindings[key] === paperID &&
      aliasesComplete
    ) {
      return existing;
    }
    await this.writeJSON(this.paperPath(paperID), paper);
    await this.updateIndex(
      index,
      paperID,
      [key],
      identifierAliases(mergedIdentifiers),
      [],
    );
    return paper;
  }

  private async ensureExternalPaperExclusive(
    seed: PaperCatalogSeed,
  ): Promise<PaperDocument> {
    return this.ensureDiscoveredPaperExclusive(seed, "pinned");
  }

  private async ensureDiscoveredPaperExclusive(
    seed: PaperCatalogSeed,
    retention: "cache" | "pinned",
    provisionalKey?: string,
    legacyProvisionalPrefix?: string,
    legacyOccurrence = 0,
  ): Promise<PaperDocument> {
    const index = await this.loadIndex();
    const aliases = identifierAliases(seed.identifiers);
    const aliasID = paperIDForAliases(index, aliases);
    const provisionalID = provisionalKey && index.provisionals[provisionalKey]
      ? resolveIndexedPaperID(index, index.provisionals[provisionalKey])
      : undefined;
    if (aliasID && provisionalID && aliasID !== provisionalID) {
      throw new Error(
        "A provisional Paper conflicts with an existing identifier alias",
      );
    }
    let compatibleLegacyID: string | undefined;
    if (!aliasID && !provisionalID && legacyProvisionalPrefix) {
      const legacyMatches: string[] = [];
      const legacyMappings = Object.entries(index.provisionals)
        .filter(([key]) => key.startsWith(legacyProvisionalPrefix))
        .sort(([left], [right]) => {
          const position = (key: string) =>
            Number(key.slice(legacyProvisionalPrefix.length));
          return position(left) - position(right) || compareCodeUnits(left, right);
        });
      for (const [, legacy] of legacyMappings) {
        const legacyID = resolveIndexedPaperID(index, legacy);
        if (legacyMatches.includes(legacyID)) { continue; }
        const legacyPaper = await this.readPaperDirect(legacyID);
        // Schema 1 used the result-list position as provisional identity. Reuse
        // that record only when its bibliographic fingerprint still matches;
        // insertions or reordering must never change what a stable Paper ID means.
        if (discoveryMatchKey(legacyPaper) === discoveryMatchKey(seed)) {
          legacyMatches.push(legacyID);
        }
      }
      compatibleLegacyID = legacyMatches[legacyOccurrence];
    }
    const knownID = aliasID || provisionalID || compatibleLegacyID;
    const existing = knownID ? await this.readPaperDirect(knownID) : undefined;
    const timestamp = this.now();
    const paperID = existing?.id || this.createID("paper");
    const identifiers: PaperDocument["identifiers"] = {
      doi: existing?.identifiers.doi || seed.identifiers.doi,
      arxiv: existing?.identifiers.arxiv || seed.identifiers.arxiv,
      semanticScholarPaperId: existing?.identifiers.semanticScholarPaperId ||
        seed.identifiers.semanticScholarPaperId,
      openAlexId: existing?.identifiers.openAlexId ||
        seed.identifiers.openAlexId,
    };
    const zoteroOwned = existing?.retention === "zotero";
    const nextRetention = existing &&
      retentionRank(existing.retention) > retentionRank(retention)
      ? existing.retention
      : retention;
    const paper: PaperDocument = {
      schema: PAPER_SCHEMA,
      id: paperID,
      identifiers,
      title: zoteroOwned
        ? existing.title
        : (seed.title || existing?.title || "Untitled"),
      authors: zoteroOwned
        ? [...existing.authors]
        : seed.authors?.length
        ? [...seed.authors]
        : [...(existing?.authors || [])],
      year: zoteroOwned ? existing.year : (seed.year || existing?.year),
      type: zoteroOwned ? existing.type : (seed.type || existing?.type),
      primaryVenue: zoteroOwned
        ? existing.primaryVenue
        : (seed.primaryVenue || existing?.primaryVenue),
      abstract: zoteroOwned
        ? existing.abstract
        : (seed.abstract || existing?.abstract),
      bindings: existing?.bindings || [],
      canonicalBinding: existing?.canonicalBinding,
      retention: nextRetention,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    const nextAliases = identifierAliases(identifiers);
    const indexComplete = nextAliases.every(
      (alias) => index.aliases[alias] === paperID,
    ) && (!provisionalKey || index.provisionals[provisionalKey] === paperID);
    if (existing && samePaperContent(existing, paper) && indexComplete) {
      return existing;
    }
    await this.writeJSON(this.paperPath(paperID), paper);
    await this.updateIndex(
      index,
      paperID,
      [],
      nextAliases,
      provisionalKey ? [provisionalKey] : [],
    );
    return paper;
  }

  private async recordDiscoverySnapshotExclusive(
    resolveSeedPaper: (catalog: this) => Promise<PaperDocument>,
    snapshot: PaperCatalogDiscoverySnapshot,
  ): Promise<PaperCatalogDiscoveryResult> {
    let result!: Omit<
      PaperCatalogDiscoveryResult,
      "garbageCollectedPaperIDs"
    >;
    this.batchDepth += 1;
    try {
      const seedPaper = await resolveSeedPaper(this);
      const mergedPapers: PaperDocument[] = [];
      const mergedOccurrences = new Map<string, number>();
      for (let index = 0; index < snapshot.merged.length; index += 1) {
        const entry = snapshot.merged[index];
        const anonymous = identifierAliases(entry.identifiers).length === 0;
        const occurrence = anonymous
          ? nextFingerprintOccurrence(mergedOccurrences, entry)
          : 0;
        mergedPapers.push(await this.ensureDiscoveredPaperExclusive(
          entry,
          "cache",
          anonymous
            ? provisionalPaperKey(
                seedPaper.id,
                snapshot.kind,
                "merged",
                entry,
                occurrence,
              )
            : undefined,
          anonymous
            ? `${seedPaper.id}:${snapshot.kind}:merged:`
            : undefined,
          occurrence,
        ));
      }

      const anonymousMatches = new Map<string, string[]>();
      snapshot.merged.forEach((entry, index) => {
        if (identifierAliases(entry.identifiers).length) { return; }
        const key = discoveryMatchKey(entry);
        const ids = anonymousMatches.get(key) || [];
        ids.push(mergedPapers[index].id);
        anonymousMatches.set(key, ids);
      });

      const observations: LiteratureCitationObservation[] = [];
      const removedObservationIDs: string[] = [];
      const sourcePaperIDs: string[][] = [];
      const sources = snapshot.sources.length
        ? snapshot.sources
        : [{
            provider: "combined",
            entries: snapshot.merged,
            complete: false,
          }];
      for (const source of sources) {
        const paperIDs: string[] = [];
        const activeObservationKeys = new Set<string>();
        const sourceOccurrences = new Map<string, number>();
        for (let index = 0; index < source.entries.length; index += 1) {
          const entry = source.entries[index];
          const aliases = identifierAliases(entry.identifiers);
          const anonymousOccurrence = !aliases.length
            ? nextFingerprintOccurrence(sourceOccurrences, entry)
            : 0;
          let candidatePaper: PaperDocument;
          if (!aliases.length) {
            const matches = anonymousMatches.get(discoveryMatchKey(entry));
            const matchedID = matches?.shift();
            candidatePaper = matchedID
              ? await this.readPaperDirect(matchedID)
              : await this.ensureDiscoveredPaperExclusive(
                  entry,
                  "cache",
                  provisionalPaperKey(
                    seedPaper.id,
                    snapshot.kind,
                    source.provider,
                    entry,
                    anonymousOccurrence,
                  ),
                  `${seedPaper.id}:${snapshot.kind}:${source.provider}:`,
                  anonymousOccurrence,
                );
          } else {
            const knownID = paperIDForAliases(
              await this.loadIndex(),
              aliases,
            );
            candidatePaper = knownID
              ? await this.readPaperDirect(knownID)
              : await this.ensureDiscoveredPaperExclusive(
                  entry,
                  "cache",
                );
          }
          paperIDs.push(candidatePaper.id);
          const citingPaperID = snapshot.kind === "references"
            ? seedPaper.id
            : candidatePaper.id;
          const citedPaperID = snapshot.kind === "references"
            ? candidatePaper.id
            : seedPaper.id;
          const observation = await this.recordObservationExclusive({
            citingPaperID,
            citedPaperID,
            provider: source.provider,
            queryKind: snapshot.kind,
            retrievedAt: snapshot.retrievedAt,
            sourceOrder: entry.sourceOrder ?? index + 1,
          });
          observations.push(observation);
          activeObservationKeys.add(observationNaturalKey(observation));
        }
        if (source.complete) {
          removedObservationIDs.push(
            ...await this.compactObservationRouteExclusive(
              seedPaper.id,
              snapshot.kind,
              source.provider,
              activeObservationKeys,
            ),
          );
        }
        sourcePaperIDs.push(paperIDs);
      }
      result = {
        seedPaperID: seedPaper.id,
        mergedPaperIDs: mergedPapers.map((paper) => paper.id),
        sourcePaperIDs,
        observations,
        removedObservationIDs,
      };
    } finally {
      this.batchDepth -= 1;
      await this.flushIndexes();
    }
    const garbage = result.removedObservationIDs.length
      ? await this.collectGarbageExclusive([])
      : { removedPaperIDs: [] };
    return {
      ...result,
      garbageCollectedPaperIDs: garbage.removedPaperIDs,
    };
  }

  private async recordObservationExclusive(
    input: Omit<LiteratureCitationObservation, "schema" | "id" | "kind">,
  ): Promise<LiteratureCitationObservation> {
    const index = await this.loadObservationIndex();
    const provider = String(input.provider || "unknown").trim() || "unknown";
    const key = observationNaturalKey({ ...input, provider });
    const id = index.keys[key] || this.createID("observation");
    const observation: LiteratureCitationObservation = {
      schema: LITERATURE_OBSERVATION_SCHEMA,
      id,
      kind: "cites",
      ...input,
      provider,
    };
    if (index.keys[key]) {
      const existing = await this.readObservationDirect(id);
      if (existing.retrievedAt > observation.retrievedAt) {
        return existing;
      }
      if (
        existing.citingPaperID === observation.citingPaperID &&
        existing.citedPaperID === observation.citedPaperID &&
        existing.provider === observation.provider &&
        existing.queryKind === observation.queryKind &&
        existing.retrievedAt === observation.retrievedAt &&
        existing.sourceOrder === observation.sourceOrder
      ) {
        return existing;
      }
    }
    await this.writeJSON(this.observationPath(id), observation);
    if (!index.keys[key]) {
      const next = {
        schema: OBSERVATION_INDEX_SCHEMA,
        keys: { ...index.keys, [key]: id },
        byPaper: addObservationAdjacency(index.byPaper, observation),
      };
      this.observationIndex = next;
      if (this.batchDepth) {
        this.observationIndexDirty = true;
      } else {
        await this.writeJSON(this.observationIndexPath(), next);
      }
    }
    return observation;
  }

  private async compactObservationRouteExclusive(
    seedPaperID: string,
    queryKind: "references" | "citations",
    provider: string,
    activeKeys: Set<string>,
  ): Promise<string[]> {
    const index = await this.loadObservationIndex();
    const normalProvider = String(provider || "unknown")
      .trim()
      .toLowerCase();
    const removed: string[] = [];
    const nextKeys = { ...index.keys };
    let nextByPaper = index.byPaper;
    for (const [key, observationID] of Object.entries(index.keys)) {
      const [storedKind, storedProvider, citingPaperID, citedPaperID] =
        key.split("\u0000");
      const sameRoute = storedKind === queryKind &&
        storedProvider === normalProvider &&
        (queryKind === "references"
          ? citingPaperID === seedPaperID
          : citedPaperID === seedPaperID);
      if (!sameRoute || activeKeys.has(key)) { continue; }
      delete nextKeys[key];
      removed.push(observationID);
      nextByPaper = removeObservationAdjacency(
        nextByPaper,
        observationID,
        [citingPaperID, citedPaperID],
      );
      this.pendingObservationRemovals.add(observationID);
    }
    if (!removed.length) { return removed; }
    this.observationIndex = {
      schema: OBSERVATION_INDEX_SCHEMA,
      keys: nextKeys,
      byPaper: nextByPaper,
    };
    if (this.batchDepth) {
      this.observationIndexDirty = true;
    } else {
      this.observationIndexDirty = true;
      await this.flushIndexes();
    }
    return removed.sort();
  }

  private async mergePapersExclusive(
    preferredPaperID: string,
    duplicatePaperID: string,
  ): Promise<PaperCatalogMergeResult> {
    const index = await this.loadIndex();
    const preferredID = resolveIndexedPaperID(index, preferredPaperID);
    const duplicateID = resolveIndexedPaperID(index, duplicatePaperID);
    if (preferredID === duplicateID) {
      const redirectedSource = preferredPaperID !== preferredID
        ? preferredPaperID
        : duplicatePaperID !== duplicateID
        ? duplicatePaperID
        : undefined;
      const redirect = redirectedSource
        ? await this.readRedirectDirect(redirectedSource)
        : undefined;
      if (!redirect) {
        throw new Error("A Paper cannot be merged into itself");
      }
      return {
        paper: await this.readPaperDirect(preferredID),
        redirect,
        removedObservationIDs: [],
      };
    }

    const preferred = await this.readPaperDirect(preferredID);
    const duplicate = await this.readPaperDirect(duplicateID);
    const timestamp = this.now();
    const bindingMap = new Map<string, ZoteroPaperBinding>();
    for (const binding of [...preferred.bindings, ...duplicate.bindings]) {
      bindingMap.set(bindingKey(binding), binding);
    }
    const strongerRetention = retentionRank(preferred.retention) >=
      retentionRank(duplicate.retention)
      ? preferred.retention
      : duplicate.retention;
    const paper: PaperDocument = {
      ...preferred,
      identifiers: {
        doi: preferred.identifiers.doi || duplicate.identifiers.doi,
        arxiv: preferred.identifiers.arxiv || duplicate.identifiers.arxiv,
        semanticScholarPaperId:
          preferred.identifiers.semanticScholarPaperId ||
          duplicate.identifiers.semanticScholarPaperId,
        openAlexId: preferred.identifiers.openAlexId ||
          duplicate.identifiers.openAlexId,
      },
      title: preferred.title || duplicate.title,
      authors: preferred.authors.length
        ? [...preferred.authors]
        : [...duplicate.authors],
      year: preferred.year || duplicate.year,
      type: preferred.type || duplicate.type,
      primaryVenue: preferred.primaryVenue || duplicate.primaryVenue,
      abstract: preferred.abstract || duplicate.abstract,
      bindings: [...bindingMap.values()],
      canonicalBinding: preferred.canonicalBinding ||
        preferred.bindings[0] ||
        duplicate.canonicalBinding ||
        duplicate.bindings[0],
      retention: strongerRetention,
      createdAt: Math.min(preferred.createdAt, duplicate.createdAt),
      updatedAt: timestamp,
    };
    const redirect: PaperRedirectDocument = {
      schema: PAPER_REDIRECT_SCHEMA,
      kind: "paper-redirect",
      sourcePaperID: duplicateID,
      targetPaperID: preferredID,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.writeJSON(this.paperPath(preferredID), paper);
    await this.writeJSON(this.redirectPath(duplicateID), redirect);

    const rewriteMappings = (values: Record<string, string>) =>
      Object.fromEntries(Object.entries(values).map(([key, value]) => [
        key,
        resolveIndexedPaperID(index, value) === duplicateID
          ? preferredID
          : resolveIndexedPaperID(index, value),
      ]));
    const nextIndex: PaperIndexDocument = {
      schema: PAPER_INDEX_SCHEMA,
      bindings: rewriteMappings(index.bindings),
      aliases: rewriteMappings(index.aliases),
      provisionals: rewriteMappings(index.provisionals),
      redirects: {
        ...rewriteMappings(index.redirects),
        [duplicateID]: preferredID,
      },
    };
    for (const alias of [
      ...identifierAliases(preferred.identifiers),
      ...identifierAliases(duplicate.identifiers),
    ]) {
      nextIndex.aliases[alias] = preferredID;
    }
    this.index = nextIndex;
    for (const [sourcePaperID, targetPaperID] of Object.entries(
      nextIndex.redirects,
    )) {
      if (
        sourcePaperID === duplicateID ||
        index.redirects[sourcePaperID] === targetPaperID
      ) {
        continue;
      }
      const existingRedirect = await this.readRedirectDirect(sourcePaperID);
      await this.writeJSON(this.redirectPath(sourcePaperID), {
        ...existingRedirect,
        targetPaperID,
        updatedAt: timestamp,
      } satisfies PaperRedirectDocument);
    }
    await this.writeJSON(this.indexPath(), nextIndex);
    this.paperIndexDirty = false;

    const removedObservationIDs = await this.rewriteMergedObservationsExclusive(
      duplicateID,
      preferredID,
    );
    await IOUtils.remove(this.paperPath(duplicateID), { ignoreAbsent: true });
    return { paper, redirect, removedObservationIDs };
  }

  private async rewriteMergedObservationsExclusive(
    duplicatePaperID: string,
    preferredPaperID: string,
  ): Promise<string[]> {
    const index = await this.loadObservationIndex();
    const observations = await Promise.all(
      [...new Set(Object.values(index.keys))]
        .map((id) => this.readObservationDirect(id)),
    );
    const groups = new Map<string, LiteratureCitationObservation[]>();
    const removed: string[] = [];
    for (const observation of observations) {
      const rewritten = {
        ...observation,
        citingPaperID: observation.citingPaperID === duplicatePaperID
          ? preferredPaperID
          : observation.citingPaperID,
        citedPaperID: observation.citedPaperID === duplicatePaperID
          ? preferredPaperID
          : observation.citedPaperID,
      };
      if (rewritten.citingPaperID === rewritten.citedPaperID) {
        removed.push(rewritten.id);
        continue;
      }
      const key = observationNaturalKey(rewritten);
      const entries = groups.get(key) || [];
      entries.push(rewritten);
      groups.set(key, entries);
    }

    const nextKeys: Record<string, string> = {};
    const winners: LiteratureCitationObservation[] = [];
    for (const [key, entries] of groups) {
      entries.sort((left, right) =>
        right.retrievedAt - left.retrievedAt || compareCodeUnits(left.id, right.id));
      const winner = entries[0];
      nextKeys[key] = winner.id;
      winners.push(winner);
      await this.writeJSON(this.observationPath(winner.id), winner);
      for (const loser of entries.slice(1)) {
        removed.push(loser.id);
      }
    }
    this.observationIndex = {
      schema: OBSERVATION_INDEX_SCHEMA,
      keys: nextKeys,
      byPaper: observationAdjacency(winners),
    };
    await this.writeJSON(
      this.observationIndexPath(),
      this.observationIndex,
    );
    this.observationIndexDirty = false;
    for (const observationID of removed) {
      await IOUtils.remove(this.observationPath(observationID), {
        ignoreAbsent: true,
      });
    }
    return removed.sort();
  }

  private async collectGarbageExclusive(
    protectedPaperIDs: Iterable<string>,
  ): Promise<PaperCatalogGarbageCollection> {
    const index = await this.loadIndex();
    const protectedIDs = new Set<string>();
    for (const paperID of protectedPaperIDs) {
      protectedIDs.add(resolveIndexedPaperID(index, paperID));
    }
    const observationIndex = await this.loadObservationIndex();
    for (const observationID of new Set(Object.values(observationIndex.keys))) {
      const observation = await this.readObservationDirect(observationID);
      protectedIDs.add(resolveIndexedPaperID(index, observation.citingPaperID));
      protectedIDs.add(resolveIndexedPaperID(index, observation.citedPaperID));
    }

    let paths: string[];
    try {
      paths = await IOUtils.getChildren(this.paperObjectsPath());
    } catch (error) {
      if (isMissingFile(error)) { return { removedPaperIDs: [] }; }
      throw error;
    }
    const removals: Array<{ paperID: string; path: string }> = [];
    for (const path of paths) {
      if (!String(path).endsWith(".json")) { continue; }
      const filename = String(path).split(/[\\/]/).pop() || "";
      const paperID = filename.slice(0, -".json".length);
      if (index.redirects[paperID] || protectedIDs.has(paperID)) { continue; }
      const paper = await this.readPaperDirect(paperID);
      if (paper.retention !== "cache") { continue; }
      removals.push({ paperID, path });
    }
    const removedPaperIDs = removals.map((entry) => entry.paperID);
    if (!removedPaperIDs.length) { return { removedPaperIDs }; }
    const removed = new Set(removedPaperIDs);
    const keepMappings = (values: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(values).filter(([, value]) => !removed.has(value)),
      );
    this.index = {
      schema: PAPER_INDEX_SCHEMA,
      bindings: keepMappings(index.bindings),
      aliases: keepMappings(index.aliases),
      provisionals: keepMappings(index.provisionals),
      redirects: { ...index.redirects },
    };
    await this.writeJSON(this.indexPath(), this.index);
    this.paperIndexDirty = false;
    for (const removal of removals) {
      await IOUtils.remove(removal.path, { ignoreAbsent: true });
    }
    return { removedPaperIDs: removedPaperIDs.sort() };
  }

  private async updateIndex(
    index: PaperIndexDocument,
    paperID: string,
    bindings: string[],
    aliases: string[],
    provisionals: string[],
  ): Promise<void> {
    const nextIndex: PaperIndexDocument = {
      schema: PAPER_INDEX_SCHEMA,
      bindings: { ...index.bindings },
      aliases: { ...index.aliases },
      provisionals: { ...index.provisionals },
      redirects: { ...index.redirects },
    };
    for (const binding of bindings) { nextIndex.bindings[binding] = paperID; }
    for (const alias of aliases) { nextIndex.aliases[alias] = paperID; }
    for (const provisional of provisionals) {
      nextIndex.provisionals[provisional] = paperID;
    }
    this.index = nextIndex;
    if (this.batchDepth) {
      this.paperIndexDirty = true;
    } else {
      await this.writeJSON(this.indexPath(), nextIndex);
    }
  }

  private async flushIndexes(): Promise<void> {
    if (this.batchDepth) { return; }
    if (this.paperIndexDirty && this.index) {
      await this.writeJSON(this.indexPath(), this.index);
      this.paperIndexDirty = false;
    }
    if (this.observationIndexDirty && this.observationIndex) {
      await this.writeJSON(
        this.observationIndexPath(),
        this.observationIndex,
      );
      this.observationIndexDirty = false;
    }
    if (this.pendingObservationRemovals.size) {
      const removals = [...this.pendingObservationRemovals];
      this.pendingObservationRemovals.clear();
      for (const observationID of removals) {
        await IOUtils.remove(this.observationPath(observationID), {
          ignoreAbsent: true,
        });
      }
    }
  }

  private async readPaperDirect(paperID: string): Promise<PaperDocument> {
    const paper = await this.readJSON(this.paperPath(paperID));
    if (
      paper?.schema !== PAPER_SCHEMA ||
      paper?.id !== paperID ||
      !Array.isArray(paper?.bindings)
    ) {
      throw new Error(`Unsupported or invalid Paper document: ${paperID}`);
    }
    return paper;
  }

  private async loadIndex(): Promise<PaperIndexDocument> {
    if (this.index) { return this.index; }
    try {
      const parsed = await this.readJSON(this.indexPath());
      if (
        parsed?.schema !== PAPER_INDEX_SCHEMA ||
        !parsed?.bindings ||
        typeof parsed.bindings !== "object"
      ) {
        throw new Error("Unsupported or invalid Paper index");
      }
      this.index = {
        schema: PAPER_INDEX_SCHEMA,
        bindings: parsed.bindings,
        aliases: parsed.aliases && typeof parsed.aliases === "object"
          ? parsed.aliases
          : {},
        provisionals: parsed.provisionals &&
          typeof parsed.provisionals === "object"
          ? parsed.provisionals
          : {},
        redirects: parsed.redirects && typeof parsed.redirects === "object"
          ? parsed.redirects
          : {},
      };
    } catch (error) {
      if (!isMissingFile(error)) { throw error; }
      this.index = {
        schema: PAPER_INDEX_SCHEMA,
        bindings: {},
        aliases: {},
        provisionals: {},
        redirects: {},
      };
    }
    return this.index;
  }

  private async loadObservationIndex(): Promise<ObservationIndexDocument> {
    if (this.observationIndex) { return this.observationIndex; }
    try {
      const parsed = await this.readJSON(this.observationIndexPath());
      if (!validStringRecord(parsed?.keys)) {
        throw new Error("Unsupported or invalid Literature observation index");
      }
      const keys = parsed.keys as Record<string, string>;
      if (
        parsed.schema === OBSERVATION_INDEX_SCHEMA &&
        validStringArrayRecord(parsed.byPaper)
      ) {
        this.observationIndex = {
          schema: OBSERVATION_INDEX_SCHEMA,
          keys,
          byPaper: parsed.byPaper,
        };
      } else if (parsed.schema === LEGACY_OBSERVATION_INDEX_SCHEMA) {
        const observations = await Promise.all(
          [...new Set(Object.values(keys))].map((id) =>
            this.readObservationDirect(id)),
        );
        this.observationIndex = {
          schema: OBSERVATION_INDEX_SCHEMA,
          keys,
          byPaper: observationAdjacency(observations),
        };
        await this.writeJSON(
          this.observationIndexPath(),
          this.observationIndex,
        );
      } else {
        throw new Error("Unsupported or invalid Literature observation index");
      }
    } catch (error) {
      if (!isMissingFile(error)) { throw error; }
      this.observationIndex = emptyObservationIndex();
    }
    return this.observationIndex;
  }

  private async readObservationDirect(
    observationID: string,
  ): Promise<LiteratureCitationObservation> {
    const observation = await this.readJSON(
      this.observationPath(observationID),
    );
    if (
      observation?.schema !== LITERATURE_OBSERVATION_SCHEMA ||
      observation?.id !== observationID ||
      observation?.kind !== "cites"
    ) {
      throw new Error(
        `Unsupported or invalid Literature observation: ${observationID}`,
      );
    }
    return observation;
  }

  private async resolvePaperIDDirect(paperID: string): Promise<string> {
    return resolveIndexedPaperID(await this.loadIndex(), paperID);
  }

  private async readRedirectDirect(
    sourcePaperID: string,
  ): Promise<PaperRedirectDocument> {
    const redirect = await this.readJSON(this.redirectPath(sourcePaperID));
    if (
      redirect?.schema !== PAPER_REDIRECT_SCHEMA ||
      redirect?.kind !== "paper-redirect" ||
      redirect?.sourcePaperID !== sourcePaperID ||
      typeof redirect?.targetPaperID !== "string"
    ) {
      throw new Error(`Unsupported or invalid Paper redirect: ${sourcePaperID}`);
    }
    return redirect;
  }

  private async readJSON(path: string): Promise<any> {
    return JSON.parse(await IOUtils.readUTF8(path) as string);
  }

  private async writeJSON(path: string, value: unknown): Promise<void> {
    await IOUtils.makeDirectory(PathUtils.parent(path)!, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.writeUTF8(path, JSON.stringify(value), {
      tmpPath: `${path}.tmp`,
    });
  }

  private indexPath(): string {
    return PathUtils.join(this.root, "index.json");
  }

  private paperPath(paperID: string): string {
    return PathUtils.join(this.root, "objects", `${paperID}.json`);
  }

  private paperObjectsPath(): string {
    return PathUtils.join(this.root, "objects");
  }

  private observationIndexPath(): string {
    return PathUtils.join(this.root, "observation-index.json");
  }

  private observationPath(observationID: string): string {
    return PathUtils.join(
      this.root,
      "observations",
      `${observationID}.json`,
    );
  }

  private redirectPath(sourcePaperID: string): string {
    return PathUtils.join(
      this.root,
      "redirects",
      `${sourcePaperID}.json`,
    );
  }
}

let catalog: PaperCatalog | undefined;

function defaultCatalog(): PaperCatalog {
  if (!catalog) {
    catalog = new PaperCatalog(PathUtils.join(
      defaultDataDirectory(),
      config.addonRef,
      "literature",
    ));
  }
  return catalog;
}

export async function ensureCatalogPaper(
  item: Zotero.Item,
): Promise<PaperDocument> {
  return defaultCatalog().ensureZoteroPaper(item);
}

export async function ensureCatalogExternalPaper(
  seed: PaperCatalogSeed,
): Promise<PaperDocument> {
  return defaultCatalog().ensureExternalPaper(seed);
}

export async function pinCatalogPaper(
  paperID: string,
): Promise<PaperDocument> {
  return defaultCatalog().pinPaper(paperID);
}

export async function recordCatalogDiscoverySnapshot(
  seedItem: Zotero.Item,
  snapshot: PaperCatalogDiscoverySnapshot,
): Promise<PaperCatalogDiscoveryResult> {
  return defaultCatalog().recordDiscoverySnapshot(seedItem, snapshot);
}

export async function recordCatalogExternalDiscoverySnapshot(
  seedPaperID: string,
  snapshot: PaperCatalogDiscoverySnapshot,
): Promise<PaperCatalogDiscoveryResult> {
  return defaultCatalog().recordExternalDiscoverySnapshot(seedPaperID, snapshot);
}

export async function listCatalogCitationObservations(
  paperID?: string,
): Promise<LiteratureCitationObservation[]> {
  return defaultCatalog().listCitationObservations(paperID);
}

export async function listCatalogCitationObservationsForPapers(
  paperIDs: Iterable<string>,
): Promise<LiteratureCitationObservation[]> {
  return defaultCatalog().listCitationObservationsForPapers(paperIDs);
}

export async function readCatalogPaper(paperID: string): Promise<PaperDocument> {
  return defaultCatalog().readPaper(paperID);
}

export async function resolveCatalogPaperID(paperID: string): Promise<string> {
  return defaultCatalog().resolvePaperID(paperID);
}

export async function inspectCatalogPaperIdentifiers(
  identifiers: PaperIdentifiers,
): Promise<PaperIdentifierInspection> {
  return defaultCatalog().inspectIdentifiers(identifiers);
}

export async function mergeCatalogPapers(
  preferredPaperID: string,
  duplicatePaperID: string,
): Promise<PaperCatalogMergeResult> {
  return defaultCatalog().mergePapers(preferredPaperID, duplicatePaperID);
}

export async function listCatalogPaperRedirects():
Promise<PaperRedirectDocument[]> {
  return defaultCatalog().listPaperRedirects();
}

export async function collectCatalogGarbage(
  protectedPaperIDs: Iterable<string> = [],
): Promise<PaperCatalogGarbageCollection> {
  return defaultCatalog().collectGarbage(protectedPaperIDs);
}
