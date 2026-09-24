/**
 * HTTP client for the Zotero add-on's localhost bridge.
 *
 * `requestUrl` is used rather than `fetch` so the call goes through Electron's
 * network stack instead of the page's and is not subject to the renderer's CORS
 * rules. That is not enough on its own: Zotero's connector server silently
 * closes any request that looks browser-like (User-Agent starting with
 * `Mozilla/`, or any `Origin` header). Electron sends both, which surfaces as
 * `net::ERR_EMPTY_RESPONSE`. Local clients must send `Zotero-Allowed-Request`.
 *
 * The types below mirror `apps/zotero-addon/src/server/bridgePayloads.ts`. They are
 * duplicated rather than imported because the two plugins ship separately and a
 * user can run mismatched versions; `BRIDGE_API` is the number that catches it.
 */

import { requestUrl } from "obsidian";
import type { PaperRef } from "./citation";

export const BRIDGE_API = 1;

/**
 * Required by Zotero's HTTP server for any non-connector client. Without it,
 * Zotero drops the socket and Electron reports `net::ERR_EMPTY_RESPONSE`.
 */
const ZOTERO_ALLOWED_HEADERS = {
  "Zotero-Allowed-Request": "1",
} as const;

export interface BridgePaperLinks {
  zoteroSelect: string;
  zoteroPdf?: string;
  markdown?: string;
  hasMarkdownAttachment: boolean;
}

export interface BridgePaper {
  citekey: string;
  citekeyPinned: boolean;
  ambiguous: boolean;
  libraryID: number;
  itemKey: string;
  title: string;
  authors: string[];
  year?: string;
  itemType: string;
  venue?: string;
  abstract?: string;
  doi?: string;
  arxiv?: string;
  semanticScholarPaperId?: string;
  citationCount?: number;
  links: BridgePaperLinks;
}

export interface BridgeRelatedPaper {
  title: string;
  authors: string[];
  year?: string;
  doi?: string;
  arxiv?: string;
  url?: string;
  venue?: string;
  citationCount?: number;
  isInfluential?: boolean;
  paperID?: string;
  inLibrary: boolean;
  libraryID?: number;
  itemKey?: string;
  citekey?: string;
}

export type RelationKind = "references" | "citations" | "relation";

export interface BridgeRelations {
  libraryID: number;
  itemKey: string;
  citekey: string;
  kind: RelationKind;
  loaded: boolean;
  source: string;
  total: number;
  count: number;
  hasMore: boolean;
  items: BridgeRelatedPaper[];
}

export interface BridgeSuggestion {
  citekey: string;
  libraryID: number;
  itemKey: string;
  title: string;
  authors: string[];
  year?: string;
}

export interface BridgePing {
  product: string;
  addonVersion: string;
  api: number;
  capabilities: string[];
  ready: boolean;
}

export interface BridgeLibrary {
  libraryID: number;
  name: string;
  type: string;
}

export interface BridgeCollection {
  libraryID: number;
  collectionKey: string;
  name: string;
  parentKey?: string;
}

export interface BridgeCollections {
  libraries: BridgeLibrary[];
  collections: BridgeCollection[];
}

export interface BridgeCollectionItem {
  libraryID: number;
  itemKey: string;
  title: string;
  authors: string[];
  year?: string;
  venue?: string;
  hasPDF: boolean;
  hasMarkdown: boolean;
  dateAdded?: string;
}

export interface BridgeCollectionItems {
  scope: {
    libraryID: number;
    collectionKey?: string;
    name: string;
  };
  items: BridgeCollectionItem[];
}

/** Thrown for every non-2xx answer, so callers can branch on 404 specifically. */
export class BridgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export class UnizeroBridge {
  /** Read lazily so a settings change takes effect without a reload. */
  constructor(private readonly endpoint: () => string) {}

  private url(path: string, params: Record<string, string | undefined>): string {
    const base = this.endpoint().replace(/\/+$/, "");
    const query = Object.entries(params)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join("&");
    return `${base}/unizero/v1/${path}${query ? `?${query}` : ""}`;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string | undefined>,
  ): Promise<T> {
    let response;
    try {
      response = await requestUrl({
        url: this.url(path, params),
        method,
        headers: { ...ZOTERO_ALLOWED_HEADERS },
        // Without this the helper throws on 404/202 edge cases we handle below.
        throw: false,
      });
    } catch (error) {
      throw new BridgeError(0, describeUnreachable(error));
    }

    if (response.status < 200 || response.status >= 300) {
      const message = safeErrorMessage(response.text) ||
        `bridge request failed with status ${response.status}`;
      throw new BridgeError(response.status, message);
    }
    return response.json as T;
  }

  private get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  ping(): Promise<BridgePing> {
    return this.get<BridgePing>("ping", {});
  }

  paper(ref: PaperRef): Promise<BridgePaper> {
    return this.get<BridgePaper>("paper", {
      libraryID: String(ref.libraryID),
      itemKey: ref.itemKey,
    });
  }

  /**
   * Relations for one paper.
   *
   * `fetch` is off by default and must stay that way for anything triggered by
   * rendering: the add-on answers from cache and reports `loaded: false` on a
   * miss, so opening a note never turns into provider traffic the user did not
   * ask for. Only an explicit click passes `fetch: true`.
   */
  relations(
    ref: PaperRef,
    kind: RelationKind,
    options: { fetch?: boolean } = {},
  ): Promise<BridgeRelations> {
    return this.get<BridgeRelations>("relations", {
      libraryID: String(ref.libraryID),
      itemKey: ref.itemKey,
      kind,
      fetch: options.fetch ? "1" : undefined,
    });
  }

  async suggest(query: string, limit = 20): Promise<BridgeSuggestion[]> {
    const payload = await this.get<{ items: BridgeSuggestion[] }>("suggest", {
      q: query,
      limit: String(limit),
    });
    return payload.items || [];
  }

  /** Libraries and collections for the library-pane picker. */
  collections(): Promise<BridgeCollections> {
    return this.get<BridgeCollections>("collections", {});
  }

  /**
   * Papers filed in one collection, or every regular item in a library when
   * `collectionKey` is omitted. Cache-only membership; never hits providers.
   */
  collectionItems(
    libraryID: number,
    collectionKey?: string,
  ): Promise<BridgeCollectionItems> {
    return this.get<BridgeCollectionItems>("collection-items", {
      libraryID: String(libraryID),
      collectionKey: collectionKey || undefined,
    });
  }

  /**
   * Start paper→Markdown conversion in Zotero (POST /convert).
   *
   * Returns as soon as Zotero accepts the job. The actual work runs in the
   * add-on / paper-runtime; progress is in the UniZero panel, not here.
   */
  convert(ref: PaperRef): Promise<BridgeConvertAccepted> {
    return this.request<BridgeConvertAccepted>("POST", "convert", {
      libraryID: String(ref.libraryID),
      itemKey: ref.itemKey,
    });
  }
}

export interface BridgeConvertAccepted {
  accepted: boolean;
  libraryID: number;
  itemKey: string;
  message?: string;
}

function describeUnreachable(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ERR_EMPTY_RESPONSE|Empty reply|empty response/i.test(raw)) {
    return (
      `Zotero closed the connection without answering (${raw}). ` +
      `The desktop app is usually running; it drops browser-like requests ` +
      `that omit the Zotero-Allowed-Request header.`
    );
  }
  return `Zotero is not reachable (${raw})`;
}

function safeErrorMessage(text: string | undefined): string | undefined {
  if (!text) { return; }
  try {
    const parsed = JSON.parse(text) as { error?: string };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    // A non-JSON body is still worth showing, but only if it is short enough to
    // belong in a notice.
    return text.length <= 200 ? text : undefined;
  }
}
