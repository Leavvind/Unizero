/**
 * Typed HTTP client for the paper runtime.
 *
 * Ported from ZoMiner's `modules/api-client.js` with identical behaviour; the only
 * changes are typing and error extraction. This is the one place in the add-on
 * that knows the runtime's HTTP details — feature modules above it see only the
 * types in contracts.ts and never touch URLs, status codes, or Zotero.HTTP.
 */

import {
  API_PREFIX,
  API_VERSION,
  REQUIRED_CAPABILITIES,
  type AnnotateRequest,
  type AnnotateResponse,
  type ConvertAccepted,
  type ConvertRequest,
  type HealthResponse,
  type JobState,
  type RuntimeErrorBody,
  type TemplateDetail,
  type TemplateListResponse,
  type WorkflowListResponse,
} from "./contracts";
import { serviceURL } from "./settings";

/** 15s: conversion is an async job, and every synchronous endpoint only does
 *  bookkeeping, so none should take anywhere near this long. */
const REQUEST_TIMEOUT_MS = 15000;
const LIBRARY_SCOPE_CAPABILITY = "library-scope";
let runtimeCapabilities = new Set<string>();

/**
 * Contract incompatibility. Kept apart from network errors because the remedies
 * differ completely: a network error can be retried or fixed by starting the
 * service, whereas no number of retries fixes a version mismatch — the user has to
 * upgrade one of the two sides.
 */
export class RuntimeIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeIncompatibleError";
  }
}

/**
 * Dig the server's structured error body out of a Zotero.HTTP exception.
 *
 * On a non-2xx response Zotero.HTTP throws an object wrapping the xhr, so a plain
 * String(error) yields only "Unexpected status code 500" and the error.message the
 * server took care to return is lost.
 */
function toRuntimeError(error: unknown): Error {
  try {
    const xhr = (error as any)?.xmlhttp ?? (error as any)?.xhr;
    let payload: RuntimeErrorBody | string | undefined =
      xhr?.response ?? xhr?.responseText;
    if (typeof payload === "string") {
      payload = JSON.parse(payload) as RuntimeErrorBody;
    }
    const detail = (payload as RuntimeErrorBody | undefined)?.error;
    if (detail) {
      return new Error(detail.message || detail.code || String(error));
    }
  } catch (ignored) {
    // The body is not JSON, or there is no body at all: fall back to the raw error.
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  baseURL: string = serviceURL(),
): Promise<T> {
  const options: Record<string, unknown> = {
    headers: { "Content-Type": "application/json" },
    responseType: "json",
    timeout: REQUEST_TIMEOUT_MS,
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  try {
    const xhr = await Zotero.HTTP.request(
      method,
      baseURL + API_PREFIX + path,
      options as any,
    );
    const response = (xhr as any).response as T & RuntimeErrorBody;
    // The server also signals business failures as 200 plus an error body, not
    // only through status codes.
    if (response && (response as RuntimeErrorBody).error) {
      const detail = (response as RuntimeErrorBody).error!;
      throw new Error(detail.message || detail.code || "runtime error");
    }
    return response;
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export const runtimeClient = {
  version: API_VERSION,
  request,

  /**
   * Handshake. Confirms both that the service is alive and that it speaks the
   * same protocol.
   *
   * Versions must match exactly rather than fall in a compatible range: during v1
   * both sides move fast, and the "probably compatible" failure mode — fields
   * silently missing — is far harder to diagnose than an outright rejection.
   */
  async health(): Promise<HealthResponse> {
    const health = await request<HealthResponse>("GET", "/health");
    if (String(health.api_version) !== API_VERSION) {
      throw new RuntimeIncompatibleError(
        `Incompatible service API version: the add-on needs v${API_VERSION}, the service offers v${health.api_version}`,
      );
    }
    const capabilities = health.capabilities || [];
    runtimeCapabilities = new Set(capabilities);
    for (const required of REQUIRED_CAPABILITIES) {
      if (!capabilities.includes(required)) {
        throw new RuntimeIncompatibleError(`The local service lacks a required capability: ${required}`);
      }
    }
    return health;
  },

  workflows: () => request<WorkflowListResponse>("GET", "/workflows"),
  modules: () => request<unknown>("GET", "/modules"),

  templates: () => request<TemplateListResponse>("GET", "/templates"),
  template: (templateId: string) =>
    request<TemplateDetail>("GET", `/templates/${encodeURIComponent(templateId)}`),
  saveTemplate: (templateId: string, payload: unknown) =>
    request<unknown>("PUT", `/templates/${encodeURIComponent(templateId)}`, payload),
  resetTemplate: (templateId: string) =>
    request<unknown>("DELETE", `/templates/${encodeURIComponent(templateId)}`),

  convert: (payload: ConvertRequest) => {
    const compatible = withoutUnsupportedLibraryScope(payload);
    return request<ConvertAccepted>("POST", "/convert", compatible);
  },
  job: (jobId: string, logTail = 20) =>
    request<JobState>(
      "GET",
      `/jobs/${encodeURIComponent(jobId)}?log_tail=${logTail}`,
    ),
  jobs: () => request<unknown>("GET", "/jobs"),

  annotate: (payload: AnnotateRequest) => {
    const compatible = withoutUnsupportedLibraryScope(payload);
    return request<AnnotateResponse>("POST", "/annotate", compatible);
  },

  config: () => request<unknown>("GET", "/config"),
  saveConfig: (payload: unknown) => request<unknown>("POST", "/config", payload),
  saveConfigAtPort: (port: number, payload: unknown) =>
    request<unknown>("POST", "/config", payload, `http://127.0.0.1:${port}`),
  shutdown: () => request<unknown>("POST", "/shutdown"),
};

export type RuntimeClient = typeof runtimeClient;

/**
 * Older ZoMiner runtimes reject unknown request fields. User-library requests can fall
 * back to their historical shape; group-library requests must fail loudly rather than
 * generate links and state for the wrong library.
 */
function withoutUnsupportedLibraryScope<
  T extends ConvertRequest | AnnotateRequest
>(payload: T): T {
  if (runtimeCapabilities.has(LIBRARY_SCOPE_CAPABILITY)) { return payload; }
  if (payload.library_scope && payload.library_scope !== "library") {
    throw new RuntimeIncompatibleError(
      "This local service does not support Zotero group libraries; upgrade the UniZero runtime",
    );
  }
  const compatible = { ...payload };
  delete compatible.library_scope;
  return compatible;
}
