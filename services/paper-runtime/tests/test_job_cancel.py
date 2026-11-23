"""Cancelling jobs: queued ones at once, running ones by killing their child process."""

from __future__ import annotations

import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient

from unizero_runtime.application.jobs import Job, JobManager
from unizero_runtime.cancellation import (
    CancelToken,
    JobCancelled,
    bound,
    raise_if_cancelled,
    tracked_process,
)
from unizero_runtime.composition import build_runtime
from unizero_runtime.contracts import API_VERSION, ConvertRequest

PREFIX = f"/api/v{API_VERSION}"
SLEEPER = [sys.executable, "-c", "import time; time.sleep(120)"]


def _request() -> ConvertRequest:
    return ConvertRequest(
        pdf_path="/nonexistent.pdf",
        attachment_key="ATTACH01",
        attachment_title="",
        is_supplement=False,
        library_id=1,
        template="paper-to-markdown",
    )


def _wait_for(predicate, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("condition not reached in time")


def _sleeping_processor(started: threading.Event):
    """A processor that spends its time in a tracked child, as a conversion does."""

    def process(job: Job) -> None:
        with tracked_process(SLEEPER, stdout=subprocess.PIPE) as proc:
            started.set()
            proc.wait()
            # A real caller would turn this exit code into a RuntimeError.
            raise RuntimeError(f"child exited {proc.returncode}")

    return process


def test_cancelling_a_running_job_kills_its_child_and_ends_cancelled() -> None:
    started = threading.Event()
    manager = JobManager(_sleeping_processor(started))
    job = manager.submit(_request())
    assert started.wait(10)

    began = time.monotonic()
    result = manager.cancel(job.id)

    assert result is job
    assert job.status == "cancelled"
    assert job.error is None
    assert job.finished.is_set()
    # Waiting out the 120s sleeper would mean the child was never killed.
    assert time.monotonic() - began < 8
    assert not manager.has_active()


def test_a_queued_job_is_cancelled_without_running() -> None:
    started = threading.Event()
    ran: list[str] = []
    gate = threading.Event()

    def process(job: Job) -> None:
        ran.append(job.id)
        started.set()
        gate.wait(10)

    manager = JobManager(process)
    first = manager.submit(_request())
    assert started.wait(10)
    second = manager.submit(_request())
    assert manager.queued() == 1

    manager.cancel(second.id)
    assert second.status == "cancelled"
    assert manager.queued() == 0

    gate.set()
    _wait_for(lambda: first.status == "done")
    # Give the worker the chance to (wrongly) pick the cancelled job up.
    third = manager.submit(_request())
    _wait_for(lambda: third.status == "done")
    assert ran == [first.id, third.id]
    assert second.status == "cancelled"


def test_cancelling_a_finished_job_changes_nothing() -> None:
    manager = JobManager(lambda job: None)
    job = manager.submit(_request())
    _wait_for(lambda: job.status == "done")

    manager.cancel(job.id)

    assert job.status == "done"


def test_cancelling_an_unknown_job_reports_nothing() -> None:
    assert JobManager(lambda job: None).cancel("missing") is None


def test_a_real_failure_is_still_a_failure() -> None:
    def process(job: Job) -> None:
        raise RuntimeError("conversion broke")

    manager = JobManager(process)
    job = manager.submit(_request())
    _wait_for(lambda: job.status == "failed")

    assert job.error == "conversion broke"


def test_a_child_cannot_start_once_the_job_is_cancelled() -> None:
    token = CancelToken()
    token.cancel()

    with bound(token):
        with pytest.raises(JobCancelled):
            with tracked_process(SLEEPER):
                pytest.fail("the child should not have been started")
        with pytest.raises(JobCancelled):
            raise_if_cancelled()


def test_without_a_bound_token_nothing_is_cancelled() -> None:
    raise_if_cancelled()
    with tracked_process([sys.executable, "-c", "pass"]) as proc:
        assert proc.wait() == 0


@pytest.fixture
def client() -> TestClient:
    return TestClient(build_runtime().app, base_url="http://127.0.0.1:23120")


def test_health_announces_the_cancel_capability(client: TestClient) -> None:
    assert "job-cancel" in client.get(f"{PREFIX}/health").json()["capabilities"]


def test_cancel_endpoint_answers_404_for_an_unknown_job(client: TestClient) -> None:
    response = client.post(f"{PREFIX}/jobs/nope/cancel")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "job_not_found"


def test_cancel_endpoint_reports_the_status_the_job_ended_with() -> None:
    runtime = build_runtime()
    http = TestClient(runtime.app, base_url="http://127.0.0.1:23120")
    started = threading.Event()
    runtime.jobs._processor = _sleeping_processor(started)
    job = runtime.jobs.submit(_request())
    assert started.wait(10)

    response = http.post(f"{PREFIX}/jobs/{job.id}/cancel")

    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"
    listed = http.get(f"{PREFIX}/jobs").json()
    assert [item["status"] for item in listed] == ["cancelled"]


def _runner(token: CancelToken, ran: list[str], cancel_in: str):
    """A three-module run whose ``cancel_in`` module requests a cancel as it runs."""
    from unizero_runtime.pipeline.workflow import (
        ModuleRegistry,
        WorkflowModule,
        WorkflowRunner,
        WorkflowTemplate,
    )

    registry: ModuleRegistry = ModuleRegistry()

    def handler(name: str):
        def run(_ctx, _settings) -> None:
            ran.append(name)
            if name == cancel_in:
                token.cancel()
            # A module that starts a child after the cancel: only a shielded one may.
            with tracked_process([sys.executable, "-c", "pass"]) as proc:
                proc.wait()

        return run

    for module_id, role in (
        ("m.extract", "extract"),
        ("m.vault", "publish"),
        ("m.zotero", "publish"),
        ("m.tail", "process"),
    ):
        registry.register(WorkflowModule(
            id=module_id, name=module_id, role=role, handler=handler(module_id),
        ))
    template = WorkflowTemplate.from_dict({
        "id": "t",
        "name": "t",
        "modules": [
            {"id": "x", "module": "m.extract"},
            {"id": "v", "module": "m.vault"},
            {"id": "z", "module": "m.zotero"},
            {"id": "t", "module": "m.tail", "enabled": False},
        ],
    })
    return WorkflowRunner(template, registry)


def test_a_cancel_before_publish_stops_the_run() -> None:
    token, ran = CancelToken(), []
    runner = _runner(token, ran, cancel_in="m.extract")

    with bound(token), pytest.raises(JobCancelled):
        runner.run(object(), lambda _line: None)

    assert ran == ["m.extract"]


def test_a_cancel_during_publish_lets_every_output_finish() -> None:
    token, ran = CancelToken(), []
    runner = _runner(token, ran, cancel_in="m.vault")

    with bound(token):
        report = runner.run(object(), lambda _line: None)
        # The shield ends with the run: later work in the job is cancellable again.
        with pytest.raises(JobCancelled):
            raise_if_cancelled()

    # Both Publish modules ran, and the disabled module after them raised nothing.
    assert ran == ["m.extract", "m.vault", "m.zotero"]
    assert [stage.status for stage in report.stages] == ["done", "done", "done"]


def test_a_running_cancel_is_reported_while_the_job_winds_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    started = threading.Event()

    def process(job: Job) -> None:
        # Stands in for a shielded Publish stage: it ignores the cancel and finishes.
        started.set()
        release.wait(10)

    manager = JobManager(process)
    job = manager.submit(_request())
    assert started.wait(10)

    monkeypatch.setattr("unizero_runtime.application.jobs.CANCEL_SETTLE_SECONDS", 0.1)
    manager.cancel(job.id)

    assert job.status == "running"
    assert job.cancel_requested
    release.set()
    _wait_for(lambda: job.status == "done")
