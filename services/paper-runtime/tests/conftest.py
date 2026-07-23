"""Shared fixtures.

Every test that touches runtime state uses an isolated home under ``tmp_path``. The
autouse guard makes an accidental fallback to the real default home fail loudly instead
of quietly writing into the developer's application-data directory.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from unizero_runtime import paths


@pytest.fixture(autouse=True)
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "runtime-home"
    monkeypatch.setenv(paths.ENV_HOME, str(home))
    return paths.ensure_home(home)
