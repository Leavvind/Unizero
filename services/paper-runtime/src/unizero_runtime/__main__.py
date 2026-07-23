"""Executable entry point: ``python -m unizero_runtime``.

Replaces ZoMiner's ``paper_service/server.py``. The add-on still launches the runtime as
a child process, so two things matter as much as starting the server: every startup
failure has to end up in a file the add-on can read back, and the banner has to name the
interpreter actually in use -- picking the wrong Python is the single most common way
this service fails to come up.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import paths


def _redirect_output(log_path: Path) -> None:
    """Send stdout/stderr to the log before anything else can fail.

    Line buffered: the add-on reads the tail of this file to explain a crash, and a
    half-flushed buffer is exactly the case where that explanation is missing.
    """
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(log_path, "w", encoding="utf-8", buffering=1)
        sys.stdout = handle
        sys.stderr = handle
    except Exception:
        # A missing log is survivable; refusing to start because of it is not.
        pass


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="unizero-runtime")
    parser.add_argument(
        "--home",
        type=Path,
        default=None,
        help=(
            "runtime state directory (config.json, work/, store/, user_templates/); "
            f"defaults to ${paths.ENV_HOME} or {paths.default_home()}"
        ),
    )
    parser.add_argument("--port", type=int, default=None, help="override the configured port")
    parser.add_argument(
        "--no-log-file",
        action="store_true",
        help="keep stdout/stderr on the console instead of redirecting to server.log",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    home = paths.ensure_home(args.home)

    if not args.no_log_file:
        _redirect_output(home / "server.log")

    print(f"[boot] python: {sys.executable}")
    print(f"[boot] home: {home}")

    from .composition import build_runtime

    try:
        runtime = build_runtime(home)
    except BaseException:
        import traceback
        traceback.print_exc()
        sys.stdout.flush()
        return 1

    config = runtime.config.snapshot()
    port = args.port or int(config["port"])
    print(f"[boot] mineru: {runtime.application.mineru_version or 'NOT FOUND on PATH'}")
    print(f"[boot] listening on http://127.0.0.1:{port}")
    sys.stdout.flush()

    import uvicorn

    try:
        uvicorn.run(runtime.app, host="127.0.0.1", port=port)
    except BaseException:
        import traceback
        traceback.print_exc()
        sys.stdout.flush()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
