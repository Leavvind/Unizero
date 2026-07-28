"""The /api/v1 contract the add-on depends on.

These assertions mirror src/runtime-client/contracts.ts in the add-on. If a change here
requires editing this file, it requires a contract version bump and an add-on change --
that is the point of pinning the shape rather than only the behaviour.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from unizero_runtime.composition import build_runtime
from unizero_runtime.contracts import API_VERSION


PREFIX = f"/api/v{API_VERSION}"

# Exactly what the add-on's health negotiation requires; see REQUIRED_CAPABILITIES.
ADDON_REQUIRED_CAPABILITIES = {"convert", "annotate", "jobs"}


@pytest.fixture
def client(isolated_home: Path) -> TestClient:
    return TestClient(build_runtime(isolated_home).app)


def test_health_satisfies_the_addon_handshake(client: TestClient) -> None:
    payload = client.get(f"{PREFIX}/health").json()

    # The add-on compares this as a string and refuses to proceed on a mismatch.
    assert str(payload["api_version"]) == API_VERSION
    assert ADDON_REQUIRED_CAPABILITIES <= set(payload["capabilities"])
    assert "library-scope" in payload["capabilities"]


def test_unprefixed_health_still_answers(client: TestClient) -> None:
    # Kept for older clients; dropping it would strand a half-upgraded install.
    assert client.get("/health").status_code == 200


def test_templates_expose_id_and_name(client: TestClient) -> None:
    templates = client.get(f"{PREFIX}/templates").json()["templates"]
    assert templates
    entry = templates[0]
    assert entry["id"] and entry["name"]


def test_workflows_endpoint_uses_its_declared_envelope(client: TestClient) -> None:
    payload = client.get(f"{PREFIX}/workflows").json()
    assert payload["workflows"]


def test_unknown_template_is_rejected_before_a_job_is_created(client: TestClient) -> None:
    response = client.post(f"{PREFIX}/convert", json={
        "pdf_path": "/nonexistent.pdf",
        "attachment_key": "ATTACH01",
        "attachment_title": "",
        "is_supplement": False,
        "library_id": 1,
        "template": "no-such-template",
    })

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "template_not_found"
    # Nothing queued: a bad template must not occupy the single worker.
    assert client.get(f"{PREFIX}/jobs").json() == []


def test_errors_use_the_envelope_the_addon_unwraps(client: TestClient) -> None:
    response = client.get(f"{PREFIX}/jobs/does-not-exist")

    assert response.status_code == 404
    error = response.json()["error"]
    # toRuntimeError() in the add-on reads exactly these two fields.
    assert error["code"] == "job_not_found"
    assert error["message"]


def test_validation_failure_is_reported_in_the_same_envelope(client: TestClient) -> None:
    # pdf_path is the one genuinely required field; everything else has a default.
    response = client.post(f"{PREFIX}/convert", json={"title": "no pdf"})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_unknown_request_fields_are_refused(client: TestClient) -> None:
    """extra='forbid' turns an add-on/runtime version skew into a loud 422.

    Without it a renamed field would be silently ignored and the conversion would run
    with the wrong settings -- the failure mode this contract exists to prevent.
    """
    response = client.post(f"{PREFIX}/convert", json={
        "pdf_path": "/x.pdf",
        "definitely_not_a_field": 1,
    })

    assert response.status_code == 422


def test_invalid_library_scope_is_refused(client: TestClient) -> None:
    response = client.post(f"{PREFIX}/convert", json={
        "pdf_path": "/x.pdf",
        "library_scope": "groups/not-a-number",
    })

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_convert_request_defaults_are_part_of_the_contract(client: TestClient) -> None:
    """Documents today's permissive shape so tightening it is a deliberate decision.

    A request carrying only pdf_path is accepted and queued: template falls back to
    paper-to-markdown and library_id to 1. The library_id default is the group-library
    hazard recorded in docs/ROADMAP.md -- pinned here so the fix cannot land unnoticed.
    """
    response = client.post(f"{PREFIX}/convert", json={"pdf_path": "/nonexistent.pdf"})

    assert response.status_code == 202
    assert response.json()["job_id"]


def test_config_round_trips(client: TestClient) -> None:
    original = client.get(f"{PREFIX}/config").json()
    assert "config" in original and "config_path" in original

    updated = client.post(f"{PREFIX}/config", json={"papers_dir": "90_Archive"}).json()
    assert updated["config"]["papers_dir"] == "90_Archive"
    assert client.get(f"{PREFIX}/config").json()["config"]["papers_dir"] == "90_Archive"


def test_config_writes_into_the_runtime_home(client: TestClient, isolated_home: Path) -> None:
    client.post(f"{PREFIX}/config", json={"papers_dir": "90_Archive"})
    assert (isolated_home / "config.json").is_file()


def test_modules_endpoint_lists_registered_pipeline_steps(client: TestClient) -> None:
    modules = client.get(f"{PREFIX}/modules").json()["modules"]
    ids = {module["id"] for module in modules}
    # The built-in template is expressed in terms of these; drift breaks conversion.
    assert "transform.frontmatter" in ids
    assert "transform.references" in ids
