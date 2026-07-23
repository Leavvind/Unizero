/**
 * Paper runtime HTTP contract, v1.
 *
 * 这些类型描述的是 add-on 和 Python runtime 之间那条 localhost HTTP 边界，来源是
 * ZoMiner `paper_service/api.py` 当前实现的 `/api/v1`。它们是**契约**，不是内部模型：
 * 字段名保持服务端的 snake_case，不做“顺手美化”——改一个名字就等于换一个协议版本。
 *
 * 长期归属是 packages/contracts（见 docs/PROJECT_STRUCTURE.md）。在 Phase 4 把 schema
 * 抽成语言中立定义之前，这里是 TypeScript 侧的唯一事实来源。
 */

/** 契约主版本。与服务端 `/health` 的 `api_version` 必须精确相等。 */
export const API_VERSION = "1";

export const API_PREFIX = `/api/v${API_VERSION}`;

/** 插件正常工作所必需的服务端能力；缺任何一个都直接判为不兼容。 */
export const REQUIRED_CAPABILITIES = ["convert", "annotate", "jobs"] as const;

export interface HealthResponse {
  api_version: string | number;
  capabilities?: string[];
  [key: string]: unknown;
}

export interface TemplateSummary {
  id: string;
  name?: string;
  description?: string;
  /** 用户覆盖过内置模板时为 true。 */
  overridden?: boolean;
}

export interface TemplateListResponse {
  templates?: TemplateSummary[];
}

export interface TemplateDetail extends TemplateSummary {
  workflow?: unknown;
  [key: string]: unknown;
}

/**
 * 转换请求。
 *
 * `pdf_path` 是 Zotero 附件在本机文件系统上的绝对路径——runtime 是独立进程，读不到
 * Zotero 的存储抽象，只能靠路径。这也是为什么这条边界只在 localhost 上成立。
 */
export interface ConvertRequest {
  pdf_path: string;
  attachment_key: string;
  attachment_title: string;
  is_supplement: boolean;
  library_id: number;
  template: string;
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
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobResult {
  md_path?: string;
  tables_html_path?: string;
  references?: ExtractedReference[];
  [key: string]: unknown;
}

export interface JobState {
  job_id?: string;
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
  attachment_key: string;
  text: string;
  comment: string;
  page_label: string;
  sort_index: string;
}

export interface AnnotateRequest {
  item_key: string;
  library_id: number;
  annotations: AnnotationPayloadItem[];
  citekey?: string;
}

export interface AnnotateResponse {
  injected: number;
  total: number;
  /** 上一轮已经注入过、这次跳过的数量。注入是幂等的。 */
  already?: number;
  /** 在 Markdown 里找不到对应位置的批注。 */
  skipped?: unknown[];
}

/** 服务端统一错误体。 */
export interface RuntimeErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}
