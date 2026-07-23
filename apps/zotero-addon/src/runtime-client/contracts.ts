/**
 * Paper runtime HTTP contract, v1.
 *
 * 这些类型描述的是 add-on 和 Python runtime 之间那条 localhost HTTP 边界，来源是
 * ZoMiner `paper_service/api.py` 当前实现的 `/api/v1`。它们是**契约**，不是内部模型：
 * 字段名保持服务端的 snake_case，不做“顺手美化”——改一个名字就等于换一个协议版本。
 *
 * 长期归属是 packages/contracts（见 docs/PROJECT_STRUCTURE.md）。在把 schema 抽成语言
 * 中立定义之前，这里是 TypeScript 侧的唯一事实来源。
 *
 * ⚠ **本文件是 `services/paper-runtime/src/unizero_runtime/contracts.py` 的手工镜像。**
 * 改任一侧必须同改另一侧。两边各自类型检查都是绿的——因为它们各自自洽——所以漂移只会
 * 在用户点下按钮的那一刻以 4xx 的形式暴露。Python 侧至少有 `tests/test_api_contract.py`
 * 把形状钉住，TS 侧没有等价物，这条注释就是它的替代品。
 */

/** 契约主版本。与服务端 `/health` 的 `api_version` 必须精确相等。 */
export const API_VERSION = "1";

export const API_PREFIX = `/api/v${API_VERSION}`;

/** 插件正常工作所必需的服务端能力；缺任何一个都直接判为不兼容。 */
export const REQUIRED_CAPABILITIES = ["convert", "annotate", "jobs"] as const;

export interface HealthResponse {
  ok: boolean;
  service: string;
  service_version: string;
  api_version: string;
  capabilities: string[];
  workflows: unknown[];
  mineru_version: string;
  vault: string;
  vault_configured: boolean;
  papers_dir: string;
  queued: number;
  [key: string]: unknown;
}

export interface TemplateSummary {
  id: string;
  name: string;
  version: number;
  description: string;
  builtin: boolean;
  /** 用户覆盖了同 ID 的内置模板时为 true。 */
  customized: boolean;
  stages: string[];
  modules: unknown[];
}

export interface TemplateListResponse {
  templates: TemplateSummary[];
}

export interface WorkflowListResponse {
  workflows: TemplateSummary[];
}

export interface WorkflowTemplateDocument {
  schema_version: number;
  id: string;
  name: string;
  version: number;
  description: string;
  modules: unknown[];
}

export interface TemplateDetail {
  template: WorkflowTemplateDocument;
  yaml: string;
  builtin: boolean;
  customized: boolean;
}

export interface ConvertOptionsPatch {
  backend?: string;
  ocr_mode?: string;
  language?: string;
  device?: string;
  enable_formula?: boolean;
  enable_table?: boolean;
  split_threshold?: number;
  chunk_size?: number;
  images_mode?: string;
  table_mode?: string;
  strip_repeated_lines?: boolean;
  strip_references?: boolean;
  table_vlm?: boolean;
}

/**
 * 转换请求。
 *
 * `pdf_path` 是 Zotero 附件在本机文件系统上的绝对路径——runtime 是独立进程，读不到
 * Zotero 的存储抽象，只能靠路径。这也是为什么这条边界只在 localhost 上成立。
 */
export interface ConvertRequest {
  pdf_path: string;
  attachment_key?: string;
  attachment_title?: string;
  is_supplement?: boolean;
  library_id?: number;
  /**
   * Zotero URI scope: `library` for the user library, `groups/<groupID>` for groups.
   * Additive v1 capability `library-scope`; omitted for an older runtime.
   */
  library_scope?: string;
  template?: string;
  /** Kept for compatibility with the original v1 endpoint. */
  workflow?: string;
  options?: ConvertOptionsPatch;
  /** 独立附件（没有父条目）时缺省。 */
  item_key?: string;
  title?: string;
  doi?: string;
  publication?: string;
  year?: string;
  authors?: string[];
  /** 由 Better BibTeX 提供，未安装时缺省。 */
  citekey?: string;
}

export interface ConvertAccepted {
  job_id: string;
  status: JobStatus;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobResult {
  md_path?: string;
  tables_html_path?: string;
  references?: ExtractedReference[];
  [key: string]: unknown;
}

export interface JobState {
  job_id: string;
  status: JobStatus;
  log_tail?: string[];
  result?: JobResult;
  error?: string;
}

/**
 * 抽取工件：原始引文串 + 定位信息，不含解析后的元数据。
 * 标题/作者/年份的解析由 add-on 侧的 providers 完成，见 src/modules/zomReferences.ts。
 */
export interface ExtractedReference {
  raw?: string;
  page?: number;
  doi?: string;
  arxiv?: string;
  [key: string]: unknown;
}

export interface AnnotationPayloadItem {
  key: string;
  attachment_key?: string;
  text: string;
  comment?: string;
  page_label?: string;
  sort_index?: string;
}

export interface AnnotateRequest {
  item_key?: string;
  library_id?: number;
  /** See ConvertRequest.library_scope. */
  library_scope?: string;
  annotations?: AnnotationPayloadItem[];
  citekey?: string;
}

export interface AnnotateResponse {
  md_path: string;
  injected: number;
  total: number;
  /** 上一轮已经注入过、这次跳过的数量。注入是幂等的。 */
  already: number;
  /** 在 Markdown 里找不到对应位置的批注。 */
  skipped: unknown[];
  unrouted: number;
}

/** 服务端统一错误体。 */
export interface RuntimeErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}
