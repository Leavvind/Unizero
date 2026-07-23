"""Runtime state locations.

ZoMiner kept everything beside ``server.py``: ``config.json``, ``work/``, ``store/``
and ``user_templates/`` all lived inside the source checkout.  That works for a script
you run from a clone, but not for an installed package -- the code directory may be
read-only, may be a site-packages path, and is replaced wholesale on upgrade.

So state moves out of the package and the package keeps only what ships with it (the
built-in templates).  Everything mutable resolves from a single *runtime home*.

Existing ZoMiner users keep their data by pointing ``UNIZERO_RUNTIME_HOME`` at their old
``paper_service`` directory: the layout inside the home is identical, so the existing
``config.json``, ``work/``, ``store/`` and ``user_templates/`` are picked up as they are.
"""

from __future__ import annotations

import os
from pathlib import Path


ENV_HOME = "UNIZERO_RUNTIME_HOME"

_PACKAGE_DIR = Path(__file__).resolve().parent


def default_home() -> Path:
    """Platform-appropriate location for runtime state.

    Deliberately not ``~/.unizero`` on every platform: on Windows a dotted directory in
    the user profile is neither discoverable nor conventional, and roaming profiles
    would try to sync the (large, disposable) work directory.
    """
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
        return Path(base) / "UniZero" / "runtime"
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "unizero" / "runtime"


def runtime_home() -> Path:
    """Resolve the runtime home, honouring the environment override."""
    override = os.environ.get(ENV_HOME, "").strip()
    return Path(override).expanduser() if override else default_home()


def config_path(home: Path | None = None) -> Path:
    return (home or runtime_home()) / "config.json"


def work_dir(home: Path | None = None) -> Path:
    """Scratch space for conversions. Disposable: each job cleans up after itself."""
    return (home or runtime_home()) / "work"


def store_dir(home: Path | None = None) -> Path:
    """Durable state that is *not* user-editable, e.g. annotation injection records."""
    return (home or runtime_home()) / "store"


def user_templates_dir(home: Path | None = None) -> Path:
    return (home or runtime_home()) / "user_templates"


def builtin_templates_dir() -> Path:
    """Ships with the package, so it is package data rather than a home subdirectory."""
    return _PACKAGE_DIR / "templates"


def ensure_home(home: Path | None = None) -> Path:
    """Create the runtime home and its subdirectories if they do not exist yet."""
    resolved = home or runtime_home()
    for directory in (resolved, work_dir(resolved), store_dir(resolved),
                      user_templates_dir(resolved)):
        directory.mkdir(parents=True, exist_ok=True)
    return resolved
