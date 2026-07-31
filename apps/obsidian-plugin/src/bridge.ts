/**
 * HTTP client for the Zotero add-on's localhost bridge.
 *
 * `requestUrl` is used rather than `fetch` on purpose: it goes through Electron's
 * network stack instead of the page's, so it is not subject to the renderer's CORS
 * rules and sends no `Origin`. That is what lets a plugin talk to Zotero's server
 * without the add-on having to relax anything.
 *
 * The types below mirror `apps/zotero-addon/src/server/bridgePayloads.ts`. They are
 * duplicated rather than imported because the two plugins ship separately and a
 * user can run mismatched versions; `BRIDGE_API` is the number that catches it.
 */

import { requestUrl } from "obsidian";
import type { PaperRef } from "./citation";

export const BRIDGE_API = 1;

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

  private async get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    let response;
    try {
      response = await requestUrl({
        url: this.url(path, params),
        method: "GET",
        // Without this the helper throws on 404, which is a normal answer here.
        throw: false,
      });
    } catch (error) {
      // A refused connection is the common case and deserves a readable message
      // rather than Electron's.
      throw new BridgeError(0, `Zotero is not reachable (${(error as Error).message})`);
    }

    if (response.status < 200 || response.status >= 300) {
      const message = safeErrorMessage(response.text) ||
        `bridge request failed with status ${response.status}`;
      throw new BridgeError(response.status, message);
    }
    return response.json as T;
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
