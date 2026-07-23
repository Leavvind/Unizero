/**
 * Paper runtime HTTP contract, v1.
 *
 * These types describe the localhost HTTP boundary between the add-on and the
 * Python runtime, taken from the `/api/v1` that ZoMiner's `paper_service/api.py`
 * implements today. They are a **contract**, not an internal model: field names
 * keep the server's snake_case and are never "tidied up in passing" — renaming one
 * is the same as changing the protocol version.
 *
 * Their long-term home is packages/contracts (see docs/PROJECT_STRUCTURE.md).
 * Until the schema is extracted into a language-neutral definition, this file is
 * the single source of truth on the TypeScript side.
 *
 * ⚠ **This file is a hand-maintained mirror of
 * `services/paper-runtime/src/unizero_runtime/contracts.py`.** A change on either
 * side requires the same change on the other. Both sides type-check green on their
 * own — because each is internally consistent — so drift only surfaces as a 4xx at
 * the moment the user clicks the button. The Python side at least has
 * `tests/test_api_contract.py` pinning the shape; the TS side has no equivalent,
 * and this comment stands in for it.
 */

/** Contract major version. Must equal the server's `/health` `api_version` exactly. */
export const API_VERSION = "1";

export const API_PREFIX = `/api/v${API_VERSION}`;

/** Server capabilities the add-on requires; a missing one means incompatible. */
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
  /** True when the user overrides a built-in template with the same ID. */
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
 * Conversion request.
 *
 * `pdf_path` is the Zotero attachment's absolute path on the local filesystem —
 * the runtime is a separate process with no access to Zotero's storage
 * abstraction, so a path is all it can use. That is also why this boundary only
 * holds on localhost.
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
  /** Absent for a standalone attachment, which has no parent item. */
  item_key?: string;
  title?: string;
  doi?: string;
  publication?: string;
  year?: string;
  authors?: string[];
  /** Supplied by Better BibTeX; absent when it is not installed. */
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
 * Extraction artifact: the raw citation string plus locating information, with no
 * resolved metadata. Title/author/year resolution happens in the add-on's
 * providers; see src/modules/zomReferences.ts.
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
  /** How many were injected in an earlier round and skipped here. Injection is idempotent. */
  already: number;
  /** Annotations with no matching location in the Markdown. */
  skipped: unknown[];
  unrouted: number;
}

/** The server's uniform error body. */
export interface RuntimeErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}
