/**
 * Read-only localhost bridge for external editors.
 *
 * Zotero already runs an HTTP server on 127.0.0.1:23119 for its connector; adding
 * endpoints to it is the established way for a Zotero add-on to answer a process
 * it cannot be loaded into. That is what lets an Obsidian plugin render an
 * `@citekey` without shipping a second copy of the metadata, the reference cache,
 * or the identity rules.
 *
 * Three properties are load-bearing:
 *
 * - **Read-only.** No endpoint mutates Zotero or the Paper catalog. A GET from an
 *   editor is not a mandate to write to the user's library, and keeping the whole
 *   surface read-only means a misbehaving consumer cannot corrupt anything.
 * - **No unrequested provider traffic.** Relations answer from cache. A cache miss
 *   returns `loaded: false` so the consumer can prompt, exactly as Unizero Home
 *   does; only an explicit `fetch=1` is allowed to reach the network. Opening a
 *   note must never turn into a silent round of provider calls.
 * - **Localhost only.** Zotero's server binds the loopback interface. Nothing here
 *   widens that, and no endpoint accepts an origin-supplied path or file target.
 *
 * `Zotero.Server.Endpoints` is not part of Zotero's typed public surface, so the
 * registration below is cast. It is, however, the only cross-process entry point
 * Zotero offers, and it has been stable for as long as the connector has existed.
 */

import { config, version } from "../../package.json";
import type Views from "../modules/views";
import type { LiteratureRelationKind } from "../modules/literatureRelations";
import {
  BRIDGE_API_VERSION,
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

const SUGGEST_LIMIT_DEFAULT = 20;
const SUGGEST_LIMIT_MAX = 100;

type BridgeResponse = [status: number, contentType: string, body: string];

interface RequestQuery {
  [name: string]: string | undefined;
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
 * Resolve a citekey to a live item.
 *
 * Reports ambiguity alongside the item because that is something the consumer
 * shows the user rather than a fact it can act on silently: a derived key that
 * two papers share has no right answer, and picking one quietly would attach a
 * note to the wrong paper.
 */
async function lookup(query: RequestQuery): Promise<Lookup> {
  const citekey = String(query.citekey || "").trim();
  if (!citekey) {
    return { found: false, response: failure(400, "citekey is required") };
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
    capabilities: ["paper", "relations", "suggest"],
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

  const fetch = query.fetch === "1" || query.fetch === "true";
  if (kind !== "relation" && !fetch) {
    // Mirrors Unizero Home: a cache miss is reported, never quietly repaired by
    // calling the providers. `relationStatuses` reads shards only.
    const statuses = await views.relationStatuses(found.item);
    if (!statuses[kind].loaded) {
      return json(200, bridgeRelationsUnloaded(found.citekey, kind));
    }
  }

  const snapshot = await views.getLiteratureSnapshot(found.item, kind);
  return json(200, bridgeRelationsFromSnapshot(
    found.citekey,
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
) {
  return function BridgeEndpoint(this: Record<string, unknown>) {
    this.supportedMethods = ["GET"];
    this.supportedDataTypes = ["application/json"];
    this.init = async (request: { query?: RequestQuery }): Promise<BridgeResponse> => {
      try {
        return await handler(request?.query || {});
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
