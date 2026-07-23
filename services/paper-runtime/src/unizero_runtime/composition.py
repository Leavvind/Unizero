"""Composition root: build a runtime from a home directory.

ZoMiner constructed its config store, template store, application and job manager as
module-level singletons inside ``api.py``.  That made importing the transport module a
side effect -- it created directories, spawned the worker thread, and shelled out to
``mineru --version`` -- which in turn made the whole service untestable without a real
environment.

Wiring lives here instead, and nothing is built at import time.  ``asgi.py`` keeps a
module-level ``app`` for the uvicorn command line, which is the one place where an
import side effect is what the caller actually asked for.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI

from . import paths
from .api.app import create_app
from .application.config import ConfigStore
from .application.jobs import JobManager
from .application.service import ZoMinerApplication
from .pipeline.steps import MODULE_REGISTRY
from .pipeline.templates import TemplateStore


@dataclass
class Runtime:
    """Everything a running service owns, kept together so tests can reach inside."""

    home: Path
    config: ConfigStore
    templates: TemplateStore
    application: ZoMinerApplication
    jobs: JobManager
    app: FastAPI


def build_runtime(home: Path | None = None) -> Runtime:
    resolved = paths.ensure_home(home)

    config = ConfigStore(home=resolved)
    templates = TemplateStore(
        MODULE_REGISTRY,
        paths.builtin_templates_dir(),
        paths.user_templates_dir(resolved),
    )
    application = ZoMinerApplication(
        config,
        templates,
        store_dir=paths.store_dir(resolved),
    )
    # Starts the worker thread, so it is built last -- nothing can be submitted before
    # its dependencies exist.
    jobs = JobManager(application.process_conversion)

    return Runtime(
        home=resolved,
        config=config,
        templates=templates,
        application=application,
        jobs=jobs,
        app=create_app(application, jobs, config, templates),
    )
