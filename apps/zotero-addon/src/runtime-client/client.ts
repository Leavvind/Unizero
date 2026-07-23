/**
 * Paper runtime 的类型化 HTTP 客户端。
 *
 * 端口自 ZoMiner `modules/api-client.js`，行为保持一致，改动只在类型和错误提取上。
 * 这是 add-on 里唯一知道 runtime HTTP 细节的地方——上层功能模块只看 contracts.ts
 * 里的类型，不碰 URL、状态码或 Zotero.HTTP。
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

/** 15s：转换是异步 job，所有同步端点都只做记账，不该跑这么久。 */
const REQUEST_TIMEOUT_MS = 15000;
const LIBRARY_SCOPE_CAPABILITY = "library-scope";
let runtimeCapabilities = new Set<string>();

/**
 * 契约不兼容。与网络错误分开，因为处置方式完全不同：网络错误可以重试或启动服务，
 * 版本不匹配重试多少次都没用，必须让用户去升级其中一端。
 */
export class RuntimeIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeIncompatibleError";
  }
}

/**
 * 把服务端的结构化错误体从 Zotero.HTTP 的异常里挖出来。
 *
 * Zotero.HTTP 在非 2xx 时抛的是包着 xhr 的对象，直接 String(error) 只会得到
 * "Unexpected status code 500"，服务端辛苦返回的 error.message 就丢了。
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
    // 响应体不是 JSON 或者根本没有响应体，退回原始错误。
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
    // 服务端也会用 200 + error 体表达业务失败，不只是靠状态码。
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
   * 握手。除了确认服务活着，还要确认它说的是同一个协议。
   *
   * 版本精确匹配而不是取兼容区间：v1 阶段两端都在快速变化，"大概能通" 的失败模式
   * （字段静默缺失）比直接拒绝难查得多。
   */
  async health(): Promise<HealthResponse> {
    const health = await request<HealthResponse>("GET", "/health");
    if (String(health.api_version) !== API_VERSION) {
      throw new RuntimeIncompatibleError(
        `服务 API 版本不兼容：插件需要 v${API_VERSION}，服务提供 v${health.api_version}`,
      );
    }
    const capabilities = health.capabilities || [];
    runtimeCapabilities = new Set(capabilities);
    for (const required of REQUIRED_CAPABILITIES) {
      if (!capabilities.includes(required)) {
        throw new RuntimeIncompatibleError(`本地服务缺少必要能力: ${required}`);
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
      "当前本地服务不支持 Zotero 群组文库，请升级 UniZero runtime",
    );
  }
  const compatible = { ...payload };
  delete compatible.library_scope;
  return compatible;
}
