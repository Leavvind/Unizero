"""Runtime state must live outside the package and be relocatable.

This is the one behavioural change made on purpose when moving here from ZoMiner, which
derived every state path from ``__file__`` -- that stops working the moment the code is
installed rather than run from a clone.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from unizero_runtime import paths


def test_env_override_wins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "elsewhere"
    monkeypatch.setenv(paths.ENV_HOME, str(target))
    assert paths.runtime_home() == target


def test_blank_override_falls_back_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    # An empty variable is a common accident in shell wrappers; it must not resolve the
    # home to the current working directory.
    monkeypatch.setenv(paths.ENV_HOME, "   ")
    assert paths.runtime_home() == paths.default_home()


def test_state_never_lands_inside_the_package(tmp_path: Path) -> None:
    package_dir = Path(paths.__file__).resolve().parent
    home = paths.ensure_home(tmp_path / "home")
    for path in (
        paths.config_path(home),
        paths.work_dir(home),
        paths.store_dir(home),
        paths.user_templates_dir(home),
    ):
        assert package_dir not in path.resolve().parents


def test_builtin_templates_ship_with_the_package() -> None:
    builtin = paths.builtin_templates_dir()
    assert builtin.is_dir()
    # The add-on falls back to this id when the template list cannot be fetched, so its
    # absence would break conversion in exactly the degraded case it exists to cover.
    assert (builtin / "paper-to-markdown.yaml").is_file()


def test_ensure_home_is_idempotent(tmp_path: Path) -> None:
    home = tmp_path / "home"
    assert paths.ensure_home(home) == paths.ensure_home(home)
    assert paths.work_dir(home).is_dir()
    assert paths.store_dir(home).is_dir()
    assert paths.user_templates_dir(home).is_dir()


def test_legacy_zominer_directory_is_adopted_as_is(tmp_path: Path,
                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    """Pointing the home at an existing paper_service directory must just work.

    That is the whole migration story for existing ZoMiner users, so it gets a test
    rather than only a line in the docs.
    """
    legacy = tmp_path / "paper_service"
    (legacy / "work").mkdir(parents=True)
    (legacy / "store").mkdir()
    (legacy / "user_templates").mkdir()
    (legacy / "config.json").write_text('{"port": 24000}', encoding="utf-8")

    monkeypatch.setenv(paths.ENV_HOME, str(legacy))

    from unizero_runtime.application.config import ConfigStore

    assert ConfigStore().snapshot()["port"] == 24000
