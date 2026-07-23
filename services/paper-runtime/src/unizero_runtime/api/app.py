"""FastAPI transport adapter for the versioned ZoMiner service contract."""

from __future__ import annotations

import os
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..application.service import ServiceError, ZoMinerApplication
from ..application.config import ConfigStore
from ..contracts import (
    API_VERSION,
    SERVICE_VERSION,
    AnnotateRequest,
    ConfigPatch,
    ConfigResponse,
    ConvertRequest,
    ErrorResponse,
    HealthResponse,
    JobAccepted,
    JobListItem,
    JobStatusResponse,
    TemplateSaveRequest,
)
from ..application.jobs import Job, JobManager
from ..pipeline.steps import MODULE_REGISTRY
from ..pipeline.templates import TemplateStore


API_PREFIX = f"/api/v{API_VERSION}"
CAPABILITIES = [
    "convert", "annotate", "jobs", "config", "workflows",
    "templates", "modules",
]


def _error(status_code: int, code: str, message: str, details=None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "code": code,
                "message": message,
                "details": details,
            },
        },
    )


def _job_status(job: Job, log_tail: int) -> dict:
    tail_size = max(0, min(log_tail, 200))
    return {
        "job_id": job.id,
        "status": job.status,
        "log_tail": job.log[-tail_size:] if tail_size else [],
        "result": job.result,
        "error": job.error,
    }


def _job_list_item(job: Job) -> dict:
    request = job.request
    return {
        "job_id": job.id,
        "status": job.status,
        "title": request.title or Path(request.pdf_path).name,
        "attachment_title": request.attachment_title,
        "is_supplement": request.is_supplement,
        "workflow": request.template_id,
        "template": request.template_id,
        "created": job.created,
        "error": job.error,
        "md_path": (job.result or {}).get("md_path"),
        "last_log": job.log[-1] if job.log else "",
    }


def create_app(
    application: ZoMinerApplication,
    jobs: JobManager,
    config: ConfigStore,
    templates: TemplateStore,
) -> FastAPI:
    app = FastAPI(
        title="ZoMiner Local Service",
        version=SERVICE_VERSION,
        description="Versioned local transport for ZoMiner paper workflows.",
    )

    @app.exception_handler(ServiceError)
    async def service_error_handler(_request: Request, exc: ServiceError):
        return _error(exc.status_code, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, exc: RequestValidationError):
        return _error(422, "validation_error", "request validation failed", exc.errors())

    @app.exception_handler(HTTPException)
    async def http_error_handler(_request: Request, exc: HTTPException):
        return _error(exc.status_code, "http_error", str(exc.detail))

    @app.exception_handler(Exception)
    async def unexpected_error_handler(_request: Request, exc: Exception):
        return _error(500, "internal_error", "unexpected service error", str(exc))

    @app.get(
        f"{API_PREFIX}/health",
        response_model=HealthResponse,
        responses={500: {"model": ErrorResponse}},
    )
    @app.get("/health", include_in_schema=False)
    def health():
        return {
            **application.health(jobs.queued()),
            "service": "zominer-local-service",
            "service_version": SERVICE_VERSION,
            "api_version": API_VERSION,
            "capabilities": CAPABILITIES,
        }

    @app.get(f"{API_PREFIX}/workflows")
    def workflows():
        return {"workflows": templates.list()}

    @app.get(f"{API_PREFIX}/modules")
    def modules():
        return {"modules": MODULE_REGISTRY.describe()}

    @app.get(f"{API_PREFIX}/templates")
    def template_list():
        return {"templates": templates.list()}

    @app.get(f"{API_PREFIX}/templates/{{template_id}}")
    def template_document(template_id: str):
        document = templates.document(template_id)
        if document is None:
            raise ServiceError("template_not_found", "template not found", status_code=404)
        return document

    @app.put(f"{API_PREFIX}/templates/{{template_id}}")
    def save_template(template_id: str, request: TemplateSaveRequest):
        if (request.template is None) == (request.yaml is None):
            raise ServiceError(
                "template_payload_invalid",
                "provide exactly one of 'template' or 'yaml'",
            )
        try:
            if request.template is not None:
                incoming_id = str(request.template.get("id") or "")
                if incoming_id != template_id:
                    raise ValueError("path template id does not match document id")
                return templates.save_dict(request.template)
            return templates.save_yaml(request.yaml or "", expected_id=template_id)
        except ValueError as exc:
            raise ServiceError("template_invalid", str(exc)) from exc

    @app.delete(f"{API_PREFIX}/templates/{{template_id}}")
    def reset_template(template_id: str):
        try:
            document = templates.reset(template_id)
        except ValueError as exc:
            raise ServiceError("template_invalid", str(exc)) from exc
        return {"template": document, "deleted": document is None}

    @app.post(
        f"{API_PREFIX}/convert",
        response_model=JobAccepted,
        status_code=202,
        responses={400: {"model": ErrorResponse}},
    )
    @app.post("/convert", include_in_schema=False)
    def convert(request: ConvertRequest):
        if templates.get(request.template_id) is None:
            raise ServiceError(
                "template_not_found",
                f"unknown template '{request.template_id}'",
                status_code=400,
            )
        job = jobs.submit(request)
        return {"job_id": job.id, "status": job.status}

    @app.get(
        f"{API_PREFIX}/jobs/{{job_id}}",
        response_model=JobStatusResponse,
        responses={404: {"model": ErrorResponse}},
    )
    @app.get("/jobs/{job_id}", include_in_schema=False)
    def job_status(job_id: str, log_tail: int = 20):
        job = jobs.get(job_id)
        if job is None:
            raise ServiceError("job_not_found", "job not found", status_code=404)
        return _job_status(job, log_tail)

    @app.get(f"{API_PREFIX}/jobs", response_model=list[JobListItem])
    @app.get("/jobs", include_in_schema=False)
    def jobs_list():
        return [_job_list_item(job) for job in jobs.list()]

    @app.post(f"{API_PREFIX}/annotate")
    @app.post("/annotate", include_in_schema=False)
    def annotate(request: AnnotateRequest):
        return application.annotate(request)

    @app.get(f"{API_PREFIX}/config", response_model=ConfigResponse)
    @app.get("/config", include_in_schema=False)
    def get_config():
        return {"config": config.snapshot(), "config_path": str(config.path)}

    @app.post(f"{API_PREFIX}/config", response_model=ConfigResponse)
    @app.post("/config", include_in_schema=False)
    def set_config(update: ConfigPatch):
        patch = update.model_dump(exclude_none=True)
        return {"config": config.update(patch), "config_path": str(config.path)}

    @app.post(f"{API_PREFIX}/shutdown")
    @app.post("/shutdown", include_in_schema=False)
    def shutdown_service():
        running = jobs.has_active()
        threading.Timer(0.5, os._exit, args=(0,)).start()
        return {"ok": True, "stopping": True, "job_was_running": running}

    return app
