"""Versioned HTTP contracts shared by the ZoMiner local service endpoints."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


API_VERSION = "1"
try:
    SERVICE_VERSION = version("unizero-runtime")
except PackageNotFoundError:
    # Source-tree imports before installation (for example, an editor) still get a
    # meaningful value. Installed and editable environments use pyproject metadata.
    SERVICE_VERSION = "0.1.0"


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConvertOptionsPatch(RequestModel):
    backend: Optional[str] = None
    ocr_mode: Optional[str] = None
    language: Optional[str] = None
    device: Optional[str] = None
    enable_formula: Optional[bool] = None
    enable_table: Optional[bool] = None
    split_threshold: Optional[int] = None
    chunk_size: Optional[int] = None
    images_mode: Optional[str] = None
    table_mode: Optional[str] = None
    strip_repeated_lines: Optional[bool] = None
    strip_references: Optional[bool] = None
    table_vlm: Optional[bool] = None


class ConvertRequest(RequestModel):
    pdf_path: str
    title: str = ""
    authors: list[str] = Field(default_factory=list)
    year: str = ""
    doi: str = ""
    publication: str = ""
    citekey: str = ""
    item_key: str = ""
    attachment_key: str = ""
    attachment_title: str = ""
    is_supplement: bool = False
    library_id: int = 1
    library_scope: str = Field(
        default="library",
        pattern=r"^(library|groups/[1-9][0-9]*)$",
    )
    template: str = "paper-to-markdown"
    workflow: Optional[str] = None
    options: Optional[ConvertOptionsPatch] = None

    @property
    def template_id(self) -> str:
        """Prefer the new name while accepting v1's workflow field."""
        return self.workflow or self.template


class AnnotationPayload(RequestModel):
    key: str
    attachment_key: str = ""
    text: str
    comment: str = ""
    page_label: str = ""
    sort_index: str = ""


class AnnotateRequest(RequestModel):
    citekey: str = ""
    item_key: str = ""
    library_id: int = 1
    library_scope: str = Field(
        default="library",
        pattern=r"^(library|groups/[1-9][0-9]*)$",
    )
    annotations: list[AnnotationPayload] = Field(default_factory=list)


class FrontmatterConfigPatch(RequestModel):
    tags: Optional[list[str]] = None
    extra: Optional[dict[str, Any]] = None


class ConfigPatch(RequestModel):
    port: Optional[int] = None
    vault_root: Optional[str] = None
    papers_dir: Optional[str] = None
    work_dir: Optional[str] = None
    bbt_rpc: Optional[str] = None
    options: Optional[ConvertOptionsPatch] = None
    frontmatter: Optional[FrontmatterConfigPatch] = None


class JobAccepted(BaseModel):
    job_id: str
    status: str


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    log_tail: list[str] = Field(default_factory=list)
    result: Optional[dict[str, Any]] = None
    error: Optional[str] = None


class TemplateSummary(BaseModel):
    id: str
    name: str
    version: int
    description: str
    builtin: bool
    customized: bool
    stages: list[str]
    modules: list[dict[str, Any]]


class TemplateListResponse(BaseModel):
    templates: list[TemplateSummary]


class WorkflowListResponse(BaseModel):
    workflows: list[TemplateSummary]


class WorkflowTemplateDocument(BaseModel):
    schema_version: int
    id: str
    name: str
    version: int
    description: str
    modules: list[dict[str, Any]]


class TemplateDetailResponse(BaseModel):
    template: WorkflowTemplateDocument
    yaml: str
    builtin: bool
    customized: bool


class AnnotateResponse(BaseModel):
    md_path: str
    total: int
    injected: int
    already: int
    skipped: list[dict[str, Any]]
    unrouted: int


class JobListItem(BaseModel):
    job_id: str
    status: str
    title: str
    attachment_title: str = ""
    is_supplement: bool = False
    workflow: str
    template: str
    created: float
    error: Optional[str] = None
    md_path: Optional[str] = None
    last_log: str = ""


class HealthResponse(BaseModel):
    ok: bool
    service: str
    service_version: str
    api_version: str
    capabilities: list[str]
    workflows: list[dict[str, Any]]
    mineru_version: str
    vault: str
    vault_configured: bool
    papers_dir: str
    queued: int


class ConfigResponse(BaseModel):
    config: dict[str, Any]
    config_path: str


class TemplateSaveRequest(RequestModel):
    template: Optional[dict[str, Any]] = None
    yaml: Optional[str] = None


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: Any = None


class ErrorResponse(BaseModel):
    error: ErrorDetail
