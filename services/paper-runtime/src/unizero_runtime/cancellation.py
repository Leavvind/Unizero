"""Stopping one conversion job from outside the worker thread.

A conversion spends nearly all its time inside a MinerU child process, and MinerU may
start children of its own. Cancelling therefore has two halves: kill that process tree
so the wait ends, and make the code that was waiting notice, so the job ends as
cancelled rather than as a failure with a confusing "mineru exit code" message.

The worker binds a :class:`CancelToken` for the duration of a job. Code that starts a
long-running child goes through :func:`tracked_process`, and Python-only stages call
:func:`raise_if_cancelled` between steps. Neither needs to know which job it serves,
and both do nothing when no token is bound (tests, direct use of the pipeline).
"""

from __future__ import annotations

import contextlib
import contextvars
import os
import signal
import subprocess
import sys
import threading
from typing import Any, Iterator, Optional


class JobCancelled(Exception):
    """The job was stopped on request; not an error in the conversion itself."""


def _popen_isolation() -> dict[str, Any]:
    """Keep the child and its descendants addressable as one group on POSIX."""
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


def _kill_tree(process: "subprocess.Popen[Any]") -> None:
    if process.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            # /T takes the whole tree: MinerU runs behind a launcher process and
            # starts workers of its own, none of which die with the parent.
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                capture_output=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
                check=False,
            )
        else:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass
    finally:
        # Covers a failed tree kill; harmless when the process is already gone.
        with contextlib.suppress(OSError):
            process.kill()


class CancelToken:
    """Cancellation state of one job: a flag plus the child processes it owns."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancelled = False
        self._processes: set["subprocess.Popen[Any]"] = set()

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def raise_if_cancelled(self) -> None:
        if self._cancelled:
            raise JobCancelled()

    def cancel(self) -> None:
        """Mark the job cancelled and kill every child it has running."""
        with self._lock:
            self._cancelled = True
            processes = list(self._processes)
        for process in processes:
            _kill_tree(process)

    def _spawn(self, command: list[str], **kwargs: Any) -> "subprocess.Popen[Any]":
        # Checked and registered under one lock, so a cancel cannot slip between
        # the check and the registration and leave an unkillable child behind.
        with self._lock:
            if self._cancelled:
                raise JobCancelled()
            process = subprocess.Popen(command, **kwargs, **_popen_isolation())
            self._processes.add(process)
        return process

    def _release(self, process: "subprocess.Popen[Any]") -> None:
        with self._lock:
            self._processes.discard(process)


_current: contextvars.ContextVar[Optional[CancelToken]] = contextvars.ContextVar(
    "unizero_cancel_token", default=None,
)


@contextlib.contextmanager
def bound(token: CancelToken) -> Iterator[CancelToken]:
    """Make ``token`` the cancellation state of everything run inside the block."""
    reset = _current.set(token)
    try:
        yield token
    finally:
        _current.reset(reset)


@contextlib.contextmanager
def shielded() -> Iterator[None]:
    """Run the block as if no job were bound: nothing inside it can be cancelled.

    For work that must not stop halfway, such as publishing outputs. A cancel that
    arrives meanwhile still sets the job's flag, but kills no child started here and
    raises nowhere inside the block.
    """
    reset = _current.set(None)
    try:
        yield
    finally:
        _current.reset(reset)


def raise_if_cancelled() -> None:
    token = _current.get()
    if token is not None:
        token.raise_if_cancelled()


@contextlib.contextmanager
def tracked_process(command: list[str], **kwargs: Any) -> Iterator["subprocess.Popen[Any]"]:
    """``subprocess.Popen`` that a cancel of the current job can kill.

    Raises :class:`JobCancelled` instead of starting once the job is cancelled, and
    again on leaving the block if the job was cancelled while the child ran, so the
    caller never mistakes a killed child's exit code for a real failure.
    """
    token = _current.get()
    if token is None:
        process = subprocess.Popen(command, **kwargs, **_popen_isolation())
    else:
        process = token._spawn(command, **kwargs)
    try:
        yield process
    finally:
        if token is not None:
            token._release(process)
    if token is not None:
        token.raise_if_cancelled()
