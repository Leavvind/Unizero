import type {
  RemoteEntry,
  RemoteObject,
  SyncBackend,
  WriteCondition,
} from "./types";

const REQUEST_TIMEOUT_MS = 30_000;
const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/>
<d:getlastmodified/></d:prop></d:propfind>`;

export interface WebDAVConfig {
  baseURL: string;
  username: string;
  password: string;
  remoteRoot?: string;
}

export class WebDAVError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WebDAVError";
  }
}

function base64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    result += alphabet[a >> 2];
    result += alphabet[((a & 3) << 4) | ((b || 0) >> 4)];
    result += index + 1 < bytes.length
      ? alphabet[((b & 15) << 2) | ((c || 0) >> 6)]
      : "=";
    result += index + 2 < bytes.length ? alphabet[c & 63] : "=";
  }
  return result;
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${base64(new TextEncoder().encode(`${username}:${password}`))}`;
}

function normalBaseURL(value: string): string {
  const url = String(value || "").trim();
  if (!/^https:\/\//i.test(url)) {
    throw new Error("WebDAV URL must use HTTPS");
  }
  return url.endsWith("/") ? url : `${url}/`;
}

function normalRelativePath(value: string): string {
  const parts = String(value || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch (_error) {
        return part;
      }
    });
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("WebDAV path traversal is not allowed");
  }
  return parts
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function responseHeader(xhr: any, name: string): string | undefined {
  const value = xhr?.getResponseHeader?.(name);
  return value ? String(value) : undefined;
}

function errorStatus(error: unknown): number | undefined {
  const xhr = (error as any)?.xmlhttp || (error as any)?.xhr;
  const status = Number(xhr?.status ?? (error as any)?.status);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}

function xmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(block: string, localName: string): string | undefined {
  const match = block.match(new RegExp(
    `<(?:[\\w-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)` +
    `</(?:[\\w-]+:)?${localName}>`,
    "i",
  ));
  return match ? xmlText(match[1].replace(/<[^>]+>/g, "").trim()) : undefined;
}

export function parseWebDAVMultiStatus(
  body: string,
  collectionURL: string,
): RemoteEntry[] {
  const entries: RemoteEntry[] = [];
  const blocks = String(body || "").match(
    /<(?:[\w-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response>/gi,
  ) || [];
  const basePath = new URL(collectionURL).pathname.replace(/\/?$/, "/");
  for (const block of blocks) {
    const href = tag(block, "href");
    if (!href) { continue; }
    const path = new URL(href, collectionURL).pathname;
    if (path.replace(/\/?$/, "/") === basePath) { continue; }
    const relative = decodeURIComponent(path.startsWith(basePath)
      ? path.slice(basePath.length)
      : path.split("/").pop() || "");
    const key = relative.replace(/\/$/, "");
    if (!key || key.includes("/")) { continue; }
    const modifiedText = tag(block, "getlastmodified");
    entries.push({
      key,
      collection: /<(?:[\w-]+:)?collection\b/i.test(block),
      revision: tag(block, "getetag"),
      modifiedAt: modifiedText ? Date.parse(modifiedText) : undefined,
    });
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

export class WebDAVBackend implements SyncBackend {
  private readonly baseURL: string;
  private readonly remoteRoot: string;
  private readonly authorization: string;
  private readonly knownCollections = new Set<string>();

  public constructor(config: WebDAVConfig) {
    this.baseURL = normalBaseURL(config.baseURL);
    this.remoteRoot = normalRelativePath(config.remoteRoot || "Unizero/v1");
    this.authorization = basicAuthorization(
      String(config.username || "").trim(),
      config.password,
    );
  }

  public async connect(): Promise<void> {
    await this.ensureCollection(this.remoteRoot);
  }

  public async list(prefix: string): Promise<RemoteEntry[]> {
    const relative = this.withRoot(prefix);
    await this.ensureCollection(relative);
    const xhr = await this.request("PROPFIND", relative, {
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
      responseType: "text",
    });
    return parseWebDAVMultiStatus(
      String((xhr as any).responseText ?? (xhr as any).response ?? ""),
      this.url(relative, true),
    );
  }

  public async get(key: string): Promise<RemoteObject | undefined> {
    try {
      const xhr = await this.request("GET", this.withRoot(key), {
        responseType: "text",
      });
      const modified = responseHeader(xhr, "Last-Modified");
      return {
        body: String((xhr as any).responseText ?? (xhr as any).response ?? ""),
        revision: responseHeader(xhr, "ETag"),
        modifiedAt: modified ? Date.parse(modified) : undefined,
      };
    } catch (error) {
      if (errorStatus(error) === 404) { return; }
      throw this.webDAVError("GET failed", error);
    }
  }

  public async put(
    key: string,
    body: string,
    condition: WriteCondition = {},
  ): Promise<{ revision?: string }> {
    const relative = this.withRoot(key);
    const parent = relative.slice(0, relative.lastIndexOf("/"));
    if (parent) { await this.ensureCollection(parent); }
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (condition.ifMatch) { headers["If-Match"] = condition.ifMatch; }
    if (condition.ifNoneMatch) { headers["If-None-Match"] = "*"; }
    try {
      const xhr = await this.request("PUT", relative, {
        headers,
        body,
        responseType: "text",
      });
      return { revision: responseHeader(xhr, "ETag") };
    } catch (error) {
      throw this.webDAVError("PUT failed", error);
    }
  }

  public async remove(
    key: string,
    condition: WriteCondition = {},
  ): Promise<void> {
    const headers: Record<string, string> = {};
    if (condition.ifMatch) { headers["If-Match"] = condition.ifMatch; }
    try {
      await this.request("DELETE", this.withRoot(key), { headers });
    } catch (error) {
      if (errorStatus(error) === 404) { return; }
      throw this.webDAVError("DELETE failed", error);
    }
  }

  private async ensureCollection(relative: string): Promise<void> {
    const parts = normalRelativePath(relative).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.knownCollections.has(current)) { continue; }
      try {
        await this.request("PROPFIND", current, {
          headers: { Depth: "0" },
          responseType: "text",
        });
      } catch (error) {
        if (errorStatus(error) !== 404) {
          throw this.webDAVError("PROPFIND failed", error);
        }
        try {
          await this.request("MKCOL", current, { responseType: "text" });
        } catch (createError) {
          const status = errorStatus(createError);
          if (status !== 405) {
            throw this.webDAVError("MKCOL failed", createError);
          }
        }
      }
      this.knownCollections.add(current);
    }
  }

  private withRoot(key: string): string {
    const relative = normalRelativePath(key);
    return relative ? `${this.remoteRoot}/${relative}` : this.remoteRoot;
  }

  private url(relative: string, collection = false): string {
    const path = normalRelativePath(relative);
    const url = `${this.baseURL}${path}`;
    return collection && !url.endsWith("/") ? `${url}/` : url;
  }

  private async request(
    method: string,
    relative: string,
    options: Record<string, unknown> = {},
  ): Promise<any> {
    const headers = {
      Authorization: this.authorization,
      ...((options.headers as Record<string, string> | undefined) || {}),
    };
    return Zotero.HTTP.request(method, this.url(relative), {
      timeout: REQUEST_TIMEOUT_MS,
      ...options,
      headers,
    } as any);
  }

  private webDAVError(message: string, error: unknown): WebDAVError {
    const status = errorStatus(error);
    if (status === 401) {
      return new WebDAVError(
        "WebDAV authentication failed (HTTP 401). Check the account email " +
          "and third-party application password; do not use the account " +
          "login password.",
        status,
      );
    }
    const detail = status ? `HTTP ${status}` : "network error";
    return new WebDAVError(`${message}: ${detail}`, status);
  }
}
