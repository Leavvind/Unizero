"""Cross-language guardrails for the canonical HTTP v1 schema."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import BaseModel

from unizero_runtime.api.app import CAPABILITIES
from unizero_runtime.contracts import (
    API_VERSION,
    AnnotateRequest,
    AnnotateResponse,
    AnnotationPayload,
    ConvertOptionsPatch,
    ConvertRequest,
    HealthResponse,
    JobAccepted,
    JobStatusResponse,
    TemplateDetailResponse,
    TemplateListResponse,
    TemplateSummary,
    WorkflowListResponse,
    WorkflowTemplateDocument,
)


ROOT = Path(__file__).resolve().parents[3]
SCHEMA = json.loads(
    (ROOT / "packages" / "contracts" / "http" / "v1.schema.json").read_text(
        encoding="utf-8",
    ),
)

MODEL_DEFINITIONS: list[tuple[type[BaseModel], str]] = [
    (ConvertOptionsPatch, "ConvertOptionsPatch"),
    (ConvertRequest, "ConvertRequest"),
    (AnnotationPayload, "AnnotationPayload"),
    (AnnotateRequest, "AnnotateRequest"),
    (HealthResponse, "HealthResponse"),
    (TemplateSummary, "TemplateSummary"),
    (TemplateListResponse, "TemplateListResponse"),
    (WorkflowListResponse, "WorkflowListResponse"),
    (WorkflowTemplateDocument, "WorkflowTemplateDocument"),
    (TemplateDetailResponse, "TemplateDetail"),
    (JobAccepted, "JobAccepted"),
    (JobStatusResponse, "JobStatusResponse"),
    (AnnotateResponse, "AnnotateResponse"),
]


@pytest.mark.parametrize(("model", "definition_name"), MODEL_DEFINITIONS)
def test_python_models_match_schema_fields_and_requiredness(
    model: type[BaseModel],
    definition_name: str,
) -> None:
    canonical = SCHEMA["$defs"][definition_name]
    generated = model.model_json_schema()

    assert set(generated.get("properties", {})) == set(canonical.get("properties", {}))
    assert set(generated.get("required", [])) == set(canonical.get("required", []))


def test_api_version_and_required_capabilities_match_schema() -> None:
    assert API_VERSION == SCHEMA["x-api-version"]
    assert set(SCHEMA["x-required-capabilities"]) <= set(CAPABILITIES)


@pytest.mark.parametrize(
    ("filename", "model"),
    [
        ("convert-request.group.json", ConvertRequest),
        ("annotate-request.group.json", AnnotateRequest),
    ],
)
def test_shared_examples_validate(filename: str, model: type[BaseModel]) -> None:
    payload = json.loads(
        (ROOT / "packages" / "contracts" / "examples" / filename).read_text(
            encoding="utf-8",
        ),
    )
    parsed = model.model_validate(payload)
    assert parsed.library_scope == "groups/123456"
