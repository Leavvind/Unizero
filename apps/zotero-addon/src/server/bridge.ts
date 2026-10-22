/**
 * Localhost bridge for external editors (primarily the Obsidian plugin).
 *
 * Zotero already runs an HTTP server on 127.0.0.1:23119 for its connector; adding
 * endpoints to it is the established way for a Zotero add-on to answer a process
 * it cannot be loaded into. That is what lets an Obsidian plugin render a paper
 * without shipping a second copy of the metadata, the reference cache, or the
 * identity rules.
 *
 * Load-bearing properties:
 *
 * - **Mostly read-only.** GET endpoints never mutate Zotero or the Paper catalog.
 *   The write-shaped exceptions all act on the user's own artifacts:
 *   `POST /convert` starts the same conversion job the Zotero item menu already
 *   runs; `POST /canvas` adds an empty `unizero:canvas` attachment to a paper that
 *   has none; `POST /trash` moves the paper's Raw or Canvas to Zotero's trash; and
 *   `POST /restore-raw` replaces Raw with a copy of Raw Backup, trashing the old
 *   one. Nothing is erased, and none accepts bibliographic edits, Paper-catalog
 *   writes, file contents, or exploration import from the editor — those need a
 *   separate write-back design.
 * - **No unrequested provider traffic.** Relations answer from cache. A cache miss
 *   returns `loaded: false` so the consumer can prompt, exactly as Unizero Home
 *   does; only an explicit `fetch=1` is allowed to reach the network. Opening a
 *   note must never turn into a silent round of provider calls.
 * - **Templates are listed, never started for.** `GET /templates` asks the paper
 *   runtime only when it is already running; a stopped runtime is reported as
 *   `available: false` rather than launched, as the Zotero item menu does.
 * - **Localhost only.** Zotero's server binds the loopback interface. Nothing here
 *   widens that, and no endpoint accepts an origin-supplied path or file target.
 *
 * `Zotero.Server.Endpoints` is not part of Zotero's typed public surface, so the
 * registration below is cast. It is, however, the only cross-process entry point
 * Zotero offers, and it has been stable for as long as the connector has existed.
 */

import { config, version } from "../../package.json";
import { convertItems } from "../features/conversion/commands";
import {
  managedAttachment,
  rawBackupFile,
  restoreRawFromBackup,
  trashManagedArtifact,
  type ManagedArtifact,
} from "../zotero/artifactActions";
import { ensureCanvasAttachment } from "../zotero/canvasAdapter";
import { libraryAcceptsFiles, libraryEditable, libraryScope } from "../zotero/libraryScope";
import { rawBackupAttachment } from "../zotero/literatureCollectionAdapter";
import { runtimeClient } from "../runtime-client/client";
import { health } from "../runtime-client/process";
import type Views from "../modules/views";
import type { LiteratureRelationKind } from "../modules/literatureRelations";
import {
  BRIDGE_API_VERSION,
  bridgeCanvas,
  bridgeCollectionItems,
  bridgeCollections,
  bridgePaperFromItem,
  bridgeRelationsFromSnapshot,
  bridgeRelationsUnloaded,
} from "./bridgePayloads";
import {
  citekeyForItem,
  isValidCitekey,
  libraryItem,
  pinnedCitekey,
  registerCitekeyInvalidation,
  resolveCitekey,
  suggestCitekeys,
  unregisterCitekeyInvalidation,
} from "./citekeys";

const ROOT = "/unizero/v1";
const PING = `${ROOT}/ping`;
const PAPER = `${ROOT}/paper`;
const RELATIONS = `${ROOT}/relations`;
const SUGGEST = `${ROOT}/suggest`;
const COLLECTIONS = `${ROOT}/collections`;
const COLLECTION_ITEMS = `${ROOT}/collection-items`;
const CONVERT = `${ROOT}/convert`;
const TEMPLATES = `${ROOT}/templates`;
const CANVAS = `${ROOT}/canvas`;
const TRASH = `${ROOT}/trash`;
const RESTORE_RAW = `${ROOT}/restore-raw`;

/** Same default template as the item menu: it creates the Raw that Obsidian opens. */
const DEFAULT_CONVERT_TEMPLATE_ID = "paper-to-zotero-markdown";
const DEFAULT_CONVERT_TEMPLATE_NAME = "Generate Raw Markdown";

/** The runtime's own template-id rule (`_SAFE_ID` in pipeline/templates.py). */
const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;

interface BridgeTemplate {
  id: string;
  name: string;
  description: string;
}

/** Templates of the running runtime, or null when it is not running. */
async function runningTemplates(): Promise<BridgeTemplate[] | null> {
  if (!(await health())) { return null; }
  const listed = (await runtimeClient.templates()).templates || [];
  return listed.map((template) => ({
    id: template.id,
    name: template.name || template.id,
    description: template.description || "",
  }));
}

const SUGGEST_LIMIT_DEFAULT = 20;
const SUGGEST_LIMIT_MAX = 100;

type BridgeResponse = [status: number, contentType: string, body: string];

interface RequestQuery {
  [name: string]: string | undefined;
}

/**
 * Pull query parameters out of whatever shape Zotero's server handed us.
 *
 * Zotero 7+ calls single-argument `init` with
 * `{ method, pathname, pathParams, searchParams, headers, data }`, where
 * `searchParams` is a `URLSearchParams`. Older docs and a few third-party
 * examples still talk about a plain `query` object or a raw query string; accept
 * those too so a future server change does not blank every endpoint again.
 *
 * This is load-bearing: reading the wrong field makes every paper lookup report
 * "citekey is required" and every `@` completion dump the alphabetically-first
 * slice of the library (empty needle → rank everything equally).
 */
function queryFromRequest(request: {
  searchParams?: { entries?: () => IterableIterator<[string, string]> };
  query?: RequestQuery | string;
} | null | undefined): RequestQuery {
  if (!request) { return {}; }

  const params = request.searchParams;
  if (params && typeof params.entries === "function") {
    const out: RequestQuery = {};
    for (const [key, value] of params.entries()) {
      out[key] = value;
    }
    return out;
  }

  if (typeof request.query === "string" && request.query) {
    const out: RequestQuery = {};
    for (const part of request.query.split("&")) {
      if (!part) { continue; }
      const split = part.indexOf("=");
      const rawName = split < 0 ? part : part.slice(0, split);
      const rawValue = split < 0 ? "" : part.slice(split + 1);
      try {
        out[decodeURIComponent(rawName)] = decodeURIComponent(rawValue);
      } catch {
        out[rawName] = rawValue;
      }
    }
    return out;
  }

  if (request.query && typeof request.query === "object") {
    return request.query;
  }

  return {};
}

function json(status: number, body: unknown): BridgeResponse {
  return [status, "application/json", JSON.stringify(body)];
}

function failure(status: number, message: string): BridgeResponse {
  return json(status, { error: message });
}

function optionalLibraryID(query: RequestQuery): number | undefined {
  const raw = Number(query.libraryID);
  return Number.isInteger(raw) ? raw : undefined;
}

function relationKind(value: string | undefined): LiteratureRelationKind | undefined {
  return value === "references" || value === "citations" || value === "relation"
    ? value
    : undefined;
}

function activeViews(): Views | undefined {
  return Zotero[config.addonInstance]?.views as Views | undefined;
}

type Lookup =
  | { found: false; response: BridgeResponse }
  | { found: true; citekey: string; ambiguous: boolean; item: Zotero.Item };

/**
 * Resolve a request to a live item.
 *
 * Preferred address is `libraryID` + `itemKey` — the durable pair external
 * editors write into notes. `citekey` remains as a secondary lookup so older
 * clients and hand-typed aliases still resolve; ambiguity is reported rather
 * than silently resolved when that path is used.
 */
async function lookup(query: RequestQuery): Promise<Lookup> {
  const itemKey = String(query.itemKey || "").trim();
  if (itemKey) {
    const libraryID = optionalLibraryID(query);
    if (libraryID === undefined) {
      return { found: false, response: failure(400, "libraryID is required with itemKey") };
    }
    if (!/^[A-Za-z0-9]+$/.test(itemKey)) {
      return { found: false, response: failure(400, "itemKey contains unsupported characters") };
    }

    const item = libraryItem(libraryID, itemKey);
    if (!item) {
      return {
        found: false,
        response: failure(404, `no item ${libraryID}/${itemKey}`),
      };
    }

    let citekey = "";
    try {
      citekey = citekeyForItem(item);
    } catch {
      citekey = itemKey;
    }
    return { found: true, citekey, ambiguous: false, item };
  }

  const citekey = String(query.citekey || "").trim();
  if (!citekey) {
    return {
      found: false,
      response: failure(400, "itemKey (with libraryID) or citekey is required"),
    };
  }
  if (!isValidCitekey(citekey)) {
    return {
      found: false,
      response: failure(400, "citekey contains unsupported characters"),
    };
  }

  const miss: Lookup = {
    found: false,
    response: failure(404, `no item matches @${citekey}`),
  };

  const resolution = await resolveCitekey(citekey, optionalLibraryID(query));
  if (!resolution) { return miss; }

  const item = libraryItem(resolution.libraryID, resolution.itemKey);
  // The index can outlive a delete by as long as it takes the notifier to fire.
  // Report that as a miss rather than as a server fault.
  if (!item) { return miss; }

  return { found: true, citekey, ambiguous: resolution.ambiguous, item };
}

/** Citekey lookup for a related result that is already in the library. */
function citekeyForLibraryItem(libraryID: number, itemID: number): string | undefined {
  const item = Zotero.Items.get(itemID) as Zotero.Item | false;
  if (!item || item.libraryID !== libraryID) { return; }
  try {
    return citekeyForItem(item);
  } catch {
    // A related row is worth showing without a citekey; it is not worth failing
    // the whole relations response over one item with unreadable fields.
    return undefined;
  }
}

async function handlePing(): Promise<BridgeResponse> {
  return json(200, {
    product: "unizero",
    addonVersion: version,
    api: BRIDGE_API_VERSION,
    capabilities: [
      "paper",
      "relations",
      "suggest",
      "collections",
      "collection-items",
      "convert",
      "templates",
      "canvas",
      "trash",
      "restore-raw",
      "subcollections",
    ],
    ready: Boolean(activeViews()),
  });
}

async function handlePaper(query: RequestQuery): Promise<BridgeResponse> {
  const found = await lookup(query);
  if (!found.found) { return found.response; }

  const paper = await bridgePaperFromItem(found.item, found.citekey, {
    pinned: Boolean(pinnedCitekey(found.item)),
    ambiguous: found.ambiguous,
  });
  return json(200, paper);
}

async function handleRelations(query: RequestQuery): Promise<BridgeResponse> {
  const kind = relationKind(query.kind);
  if (!kind) {
    return failure(400, "kind must be references, citations, or relation");
  }

  const views = activeViews();
  if (!views) {
    return failure(503, "Unizero is still starting; no Zotero window is loaded yet");
  }

  const found = await lookup(query);
  if (!found.found) { return found.response; }

  const subject = {
    libraryID: found.item.libraryID,
    itemKey: String(found.item.key),
    citekey: found.citekey,
  };

  const fetch = query.fetch === "1" || query.fetch === "true";
  if (kind !== "relation" && !fetch) {
    // Mirrors Unizero Home: a cache miss is reported, never quietly repaired by
    // calling the providers. `relationStatuses` reads shards only.
    const statuses = await views.relationStatuses(found.item);
    if (!statuses[kind].loaded) {
      return json(200, bridgeRelationsUnloaded(subject, kind));
    }
  }

  const snapshot = await views.getLiteratureSnapshot(found.item, kind);
  return json(200, bridgeRelationsFromSnapshot(
    subject,
    snapshot,
    citekeyForLibraryItem,
  ));
}

async function handleSuggest(query: RequestQuery): Promise<BridgeResponse> {
  const requested = Number(query.limit);
  const limit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, SUGGEST_LIMIT_MAX)
    : SUGGEST_LIMIT_DEFAULT;
  const items = await suggestCitekeys(
    String(query.q || ""),
    limit,
    optionalLibraryID(query),
  );
  return json(200, { items });
}

/** Library + collection tree for the Obsidian library pane picker. */
async function handleCollections(): Promise<BridgeResponse> {
  return json(200, bridgeCollections());
}

/**
 * Papers in one collection (or the whole library when `collectionKey` is
 * omitted), with its subcollections' papers when `subcollections=1`. Read-only
 * membership; never fetches providers.
 */
async function handleCollectionItems(query: RequestQuery): Promise<BridgeResponse> {
  const libraryID = optionalLibraryID(query);
  if (libraryID === undefined) {
    return failure(400, "libraryID is required");
  }
  if (libraryID <= 0) {
    return failure(400, "libraryID must be a positive integer");
  }

  const rawKey = String(query.collectionKey || "").trim();
  if (rawKey && !/^[A-Za-z0-9]+$/.test(rawKey)) {
    return failure(400, "collectionKey contains unsupported characters");
  }

  const result = await bridgeCollectionItems(
    libraryID,
    rawKey || undefined,
    String(query.subcollections || "") === "1",
  );
  if ("error" in result) {
    return failure(result.status, result.error);
  }
  return json(200, result);
}

/**
 * Start Markdown conversion for one paper — the same path as the Zotero item
 * menu ("Generate Markdown from template").
 *
 * Conversion takes minutes (runtime job + artifact registration). The HTTP
 * response returns as soon as the job is *accepted for running*, not when it
 * finishes; progress lives in the UniZero panel inside Zotero. Fire-and-forget
 * is intentional so an Obsidian click does not hold a localhost socket open for
 * the whole run.
 */
async function handleTemplates(): Promise<BridgeResponse> {
  const templates = await runningTemplates();
  return json(200, {
    available: templates !== null,
    defaultTemplate: DEFAULT_CONVERT_TEMPLATE_ID,
    templates: templates || [],
  });
}

async function handleConvert(query: RequestQuery): Promise<BridgeResponse> {
  const found = await lookup(query);
  if (!found.found) { return found.response; }

  // `template` is optional; without it the item menu's default runs.
  const templateId = (query.template || "").trim() || DEFAULT_CONVERT_TEMPLATE_ID;
  if (!TEMPLATE_ID.test(templateId)) {
    return failure(400, `invalid template id "${templateId}"`);
  }
  let templateName = templateId === DEFAULT_CONVERT_TEMPLATE_ID
    ? DEFAULT_CONVERT_TEMPLATE_NAME
    : templateId;
  // A running runtime can confirm the template now; a stopped one is started by
  // the conversion command, which reports an unknown template in the panel.
  const templates = await runningTemplates().catch(() => null);
  if (templates) {
    const known = templates.find((template) => template.id === templateId);
    if (!known) { return failure(404, `no conversion template "${templateId}"`); }
    templateName = known.name;
  }

  const mainWindow = resolveMainWindow();
  if (!mainWindow) {
    return failure(503, "No Zotero window is open; open Zotero and try again");
  }

  const libraryID = found.item.libraryID;
  const itemKey = String(found.item.key);

  void convertItems(
    mainWindow,
    [found.item],
    templateId,
    templateName,
  ).catch((error) => {
    ztoolkit.log("[bridge:convert] background conversion failed", error);
    Zotero.logError(error as Error);
  });

  return json(202, {
    accepted: true,
    libraryID,
    itemKey,
    template: templateId,
    message:
      `Conversion (${templateName}) started in Zotero. Watch the UniZero panel for progress.`,
  });
}

/**
 * The paper's Canvas attachment, created empty when it has none. Repeating the
 * request returns the same attachment; nothing here writes into an existing one.
 */
async function handleCanvas(query: RequestQuery): Promise<BridgeResponse> {
  const found = await lookup(query);
  if (!found.found) { return found.response; }
  if (!found.item.isRegularItem()) {
    return failure(400, "only a regular item can have a Canvas");
  }

  const result = await ensureCanvasAttachment(found.item)
    .catch((error: unknown) => {
      if (!libraryAcceptsFiles(found.item.libraryID)) { return undefined; }
      throw error;
    });
  if (!result) {
    return failure(403, "this Zotero library does not allow new attachment files");
  }
  return json(result.created ? 201 : 200, await bridgeCanvas(
    found.item, result.attachment, result.created,
  ));
}

function managedKind(value: string | undefined): ManagedArtifact | undefined {
  return value === "raw" || value === "canvas" ? value : undefined;
}

/** Move the paper's Raw or Canvas (`kind`) to Zotero's trash. */
async function handleTrash(query: RequestQuery): Promise<BridgeResponse> {
  const kind = managedKind(query.kind);
  if (!kind) { return failure(400, "kind must be raw or canvas"); }
  const found = await lookup(query);
  if (!found.found) { return found.response; }
  if (!managedAttachment(found.item, kind)) {
    return failure(404, `this paper has no ${kind === "raw" ? "Raw" : "Canvas"}`);
  }
  if (!libraryEditable(found.item.libraryID)) {
    return failure(403, "this Zotero library is read-only");
  }

  const trashed = await trashManagedArtifact(found.item, kind);
  return json(200, {
    libraryID: found.item.libraryID,
    itemKey: String(found.item.key),
    kind,
    trashed: Boolean(trashed),
    attachmentKey: trashed ? String(trashed.key) : undefined,
  });
}

/** Replace the paper's Raw with a copy of its Raw Backup; the old Raw is trashed. */
async function handleRestoreRaw(query: RequestQuery): Promise<BridgeResponse> {
  const found = await lookup(query);
  if (!found.found) { return found.response; }
  if (!libraryAcceptsFiles(found.item.libraryID)) {
    return failure(403, "this Zotero library does not allow new attachment files");
  }

  const backup = rawBackupAttachment(found.item);
  if (!backup) { return failure(404, "this paper has no Raw Backup"); }
  if (!(await rawBackupFile(backup))) {
    return failure(409, "the Raw Backup file is not on this machine");
  }

  const raw = await restoreRawFromBackup(found.item);
  return json(200, {
    libraryID: found.item.libraryID,
    itemKey: String(found.item.key),
    raw: `zotero://select/${libraryScope(raw.libraryID)}/items/${raw.key}`,
    rawPath: await raw.getFilePathAsync().catch(() => undefined) || undefined,
  });
}

/** Prefer the frontmost main window; fall back to any open one. */
function resolveMainWindow(): Window | null {
  try {
    const getMainWindows = (Zotero as any).getMainWindows as (() => Window[]) | undefined;
    if (typeof getMainWindows === "function") {
      const windows = getMainWindows();
      if (windows?.length) { return windows[0]; }
    }
  } catch {
    // Fall through to the single-window helper.
  }
  try {
    const win = (Zotero as any).getMainWindow?.() as Window | undefined;
    return win || null;
  } catch {
    return null;
  }
}

/**
 * Wrap a handler in Zotero's endpoint object shape.
 *
 * `init` returns a promise resolving to `[status, contentType, body]`, the form
 * Zotero's own connector endpoints use. Every rejection is converted here: an
 * endpoint that throws past Zotero's dispatcher leaves the request hanging, and a
 * consumer waiting on a socket has no way to tell that apart from a slow query.
 */
function endpointFor(
  name: string,
  handler: (query: RequestQuery) => Promise<BridgeResponse>,
  methods: string[] = ["GET"],
) {
  return function BridgeEndpoint(this: Record<string, unknown>) {
    this.supportedMethods = methods;
    this.supportedDataTypes = ["application/json"];
    this.init = async (request: {
      searchParams?: { entries?: () => IterableIterator<[string, string]> };
      query?: RequestQuery | string;
    }): Promise<BridgeResponse> => {
      try {
        return await handler(queryFromRequest(request));
      } catch (error) {
        ztoolkit.log(`[bridge:${name}] failed`, error);
        Zotero.logError(error as Error);
        return failure(500, (error as Error)?.message || "bridge request failed");
      }
    };
  };
}

const endpoints: Record<string, () => void> = {
  [PING]: endpointFor("ping", handlePing),
  [PAPER]: endpointFor("paper", handlePaper),
  [RELATIONS]: endpointFor("relations", handleRelations),
  [SUGGEST]: endpointFor("suggest", handleSuggest),
  [COLLECTIONS]: endpointFor("collections", handleCollections),
  [COLLECTION_ITEMS]: endpointFor("collection-items", handleCollectionItems),
  [CONVERT]: endpointFor("convert", handleConvert, ["POST"]),
  [TEMPLATES]: endpointFor("templates", handleTemplates),
  [CANVAS]: endpointFor("canvas", handleCanvas, ["POST"]),
  [TRASH]: endpointFor("trash", handleTrash, ["POST"]),
  [RESTORE_RAW]: endpointFor("restore-raw", handleRestoreRaw, ["POST"]),
};

let registered = false;

/** Idempotent: endpoints are process-wide, not per-window. */
export function registerBridgeEndpoints(): void {
  if (registered) { return; }
  const table = (Zotero as any).Server?.Endpoints as Record<string, unknown> | undefined;
  if (!table) {
    ztoolkit.log("[bridge] Zotero's HTTP server is unavailable; endpoints not registered");
    return;
  }

  for (const [path, endpoint] of Object.entries(endpoints)) {
    if (table[path]) {
      // Another build of this add-on, or a stale registration from a reload.
      // Overwriting is correct; silently doubling up is not.
      ztoolkit.log(`[bridge] replacing existing endpoint ${path}`);
    }
    table[path] = endpoint;
  }
  registerCitekeyInvalidation();
  registered = true;
}

export function unregisterBridgeEndpoints(): void {
  if (!registered) { return; }
  const table = (Zotero as any).Server?.Endpoints as Record<string, unknown> | undefined;
  if (table) {
    for (const [path, endpoint] of Object.entries(endpoints)) {
      if (table[path] === endpoint) { delete table[path]; }
    }
  }
  unregisterCitekeyInvalidation();
  registered = false;
}
