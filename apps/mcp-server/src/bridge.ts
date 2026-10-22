/**
 * HTTP client for the Zotero add-on's localhost bridge.
 *
 * The MCP server reads nothing from Zotero except through this bridge: which
 * attachment is Raw, which PDF a digest came from, and where each file lives are
 * the add-on's answers, not rules repeated here. That is what keeps an agent's
 * view of a paper from drifting as the add-on changes.
 *
 * The types below mirror `apps/zotero-addon/src/server/bridgePayloads.ts`. They are
 * duplicated rather than imported because the add-on and this server ship
 * separately and a user can run mismatched versions; `BRIDGE_API` and the ping
 * capabilities are what catch it.
 */

export const BRIDGE_API = 2;

/** Zotero's connector server drops requests from clients without this header. */
const ZOTERO_ALLOWED_HEADERS = { "Zotero-Allowed-Request": "1" } as const;

const DEFAULT_BASE = "http://127.0.0.1:23119";
const TIMEOUT_MS = 15_000;

export interface BridgePing {
  product: string;
  addonVersion: string;
  api: number;
  capabilities: string[];
  ready: boolean;
}

export interface BridgePaperLinks {
  zoteroSelect: string;
  zoteroPdf?: string;
  raw?: string;
  rawPath?: string;
  rawBackup?: string;
  rawBackupPath?: string;
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

export interface BridgeSuggestion {
  libraryID: number;
  itemKey: string;
  citekey: string;
  title: string;
  authors: string[];
  year?: string;
}

export interface BridgePdf {
  key: string;
  title: string;
  main: boolean;
  path?: string;
}

export interface BridgeArtifact {
  kind: string;
  key: string;
  title: string;
  contentType: string;
  source?: string;
  path?: string;
}

export interface BridgeArtifacts {
  libraryID: number;
  itemKey: string;
  pdfs: BridgePdf[];
  artifacts: BridgeArtifact[];
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
  inLibrary: boolean;
  libraryID?: number;
  itemKey?: string;
  citekey?: string;
}

export interface BridgeRelations {
  libraryID: number;
  itemKey: string;
  citekey: string;
  kind: "references" | "citations" | "relation";
  loaded: boolean;
  source: string;
  total: number;
  count: number;
  hasMore: boolean;
  items: BridgeRelatedPaper[];
}

export interface BridgeConvertAccepted {
  accepted: boolean;
  libraryID: number;
  itemKey: string;
  template: string;
  message: string;
}

/** Zotero is not running, or the add-on's bridge is not loaded. */
export class BridgeUnreachable extends Error {}

/** The bridge answered with an error status. */
export class BridgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Address of one paper: the durable pair, or a citekey alias. */
export type PaperAddress =
  | { libraryID: number; itemKey: string }
  | { citekey: string };

type Query = Record<string, string | number | boolean | undefined>;

export class BridgeClient {
  private capabilities?: Set<string>;

  constructor(
    private readonly base = process.env.UNIZERO_ZOTERO_URL || DEFAULT_BASE,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ping(): Promise<BridgePing> {
    const ping = await this.request<BridgePing>("GET", "ping");
    if (ping.product !== "unizero") {
      throw new BridgeUnreachable("the server on Zotero's port is not the UniZero bridge");
    }
    if (ping.api !== BRIDGE_API) {
      throw new BridgeError(
        409,
        `UniZero add-on ${ping.addonVersion} speaks bridge API ${ping.api}; ` +
          `this MCP server expects ${BRIDGE_API}. Update whichever is older.`,
      );
    }
    this.capabilities = new Set(ping.capabilities);
    return ping;
  }

  /** Fail clearly when the add-on is older than a feature this server needs. */
  async require(capability: string): Promise<void> {
    if (!this.capabilities?.has(capability)) { await this.ping(); }
    if (!this.capabilities?.has(capability)) {
      throw new BridgeError(
        501,
        `the installed UniZero add-on has no "${capability}" endpoint; update the add-on`,
      );
    }
  }

  paper(address: PaperAddress): Promise<BridgePaper> {
    return this.request("GET", "paper", address);
  }

  async suggest(q: string, limit: number): Promise<BridgeSuggestion[]> {
    const body = await this.request<{ items: BridgeSuggestion[] }>("GET", "suggest", { q, limit });
    return body.items || [];
  }

  async artifacts(address: PaperAddress): Promise<BridgeArtifacts> {
    await this.require("artifacts");
    return this.request("GET", "artifacts", address);
  }

  relations(
    address: PaperAddress,
    kind: BridgeRelations["kind"],
    fetchMissing: boolean,
  ): Promise<BridgeRelations> {
    return this.request("GET", "relations", {
      ...address,
      kind,
      fetch: fetchMissing ? 1 : undefined,
    });
  }

  convert(address: PaperAddress, template?: string): Promise<BridgeConvertAccepted> {
    return this.request("POST", "convert", { ...address, template });
  }

  private async request<T>(method: "GET" | "POST", endpoint: string, query: Query = {}): Promise<T> {
    const url = new URL(`/unizero/v1/${endpoint}`, this.base);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") { url.searchParams.set(key, String(value)); }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: ZOTERO_ALLOWED_HEADERS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new BridgeUnreachable(
        `Zotero is not answering at ${this.base} (${(error as Error).message}). ` +
          "Start Zotero with the UniZero add-on enabled.",
      );
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text };
    }
    if (!response.ok) {
      const message = (body as { error?: string }).error || `bridge returned ${response.status}`;
      throw new BridgeError(response.status, message);
    }
    return body as T;
  }
}
