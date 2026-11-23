"""In-process single-worker job queue for GPU-friendly conversion."""

from __future__ import annotations

import threading
import time
import uuid
from queue import Queue
from typing import Callable, Optional

from ..cancellation import CancelToken, JobCancelled, bound
from ..contracts import ConvertRequest

#: How long a cancel request waits for the worker to wind a running job down. Killing
#: the MinerU tree takes well under a second; the margin covers a slow machine.
CANCEL_SETTLE_SECONDS = 10.0


class Job:
    def __init__(self, job_id: str, request: ConvertRequest):
        self.id = job_id
        self.request = request
        self.status = "queued"
        self.log: list[str] = []
        self.result: Optional[dict] = None
        self.error: Optional[str] = None
        self.created = time.time()
        self.cancel_token = CancelToken()
        #: A cancel was asked for while it ran. The job may still end ``done``: a
        #: Publish stage that has started is never interrupted.
        self.cancel_requested = False
        #: Set once the job has reached a terminal status.
        self.finished = threading.Event()

    def append(self, line: str) -> None:
        self.log.append(line)
        if len(self.log) > 2000:
            del self.log[:1000]


class JobManager:
    def __init__(self, processor: Callable[[Job], None]):
        self._processor = processor
        self._jobs: dict[str, Job] = {}
        self._queue: Queue[str] = Queue()
        self._lock = threading.RLock()
        threading.Thread(target=self._worker_loop, daemon=True).start()

    def submit(self, request: ConvertRequest) -> Job:
        job = Job(uuid.uuid4().hex, request)
        with self._lock:
            self._jobs[job.id] = job
        self._queue.put(job.id)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda job: job.created, reverse=True)

    def queued(self) -> int:
        # Counted by status, not queue length: a cancelled job stays in the queue
        # until the worker reaches and skips it.
        return sum(1 for job in self.list() if job.status == "queued")

    def has_active(self) -> bool:
        return any(job.status in ("queued", "running") for job in self.list())

    def cancel(self, job_id: str) -> Optional[Job]:
        """Stop a queued or running job; a finished one is returned untouched.

        A queued job is cancelled at once. A running one has its child processes
        killed and is waited for, so the status returned is the one the job actually
        ended with -- ``done`` if it finished before the request landed.
        """
        job = self.get(job_id)
        if job is None:
            return None
        with self._lock:
            if job.status == "queued":
                job.status = "cancelled"
                job.append("[cancelled] before it started")
                job.finished.set()
                return job
            running = job.status == "running"
        if running:
            job.cancel_requested = True
            job.append("[cancel] stop requested")
            job.cancel_token.cancel()
            job.finished.wait(CANCEL_SETTLE_SECONDS)
        return job

    def _worker_loop(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                job = self.get(job_id)
                if job is None:
                    continue
                with self._lock:
                    # Cancelled while it waited its turn: nothing to run.
                    if job.status != "queued":
                        continue
                    job.status = "running"
                self._run(job)
            finally:
                self._queue.task_done()

    def _run(self, job: Job) -> None:
        try:
            with bound(job.cancel_token):
                self._processor(job)
            job.status = "done"
        except JobCancelled:
            self._mark_cancelled(job)
        except Exception as exc:
            if job.cancel_token.cancelled:
                # A killed child surfaces as whatever error its caller made of the
                # exit code; the cause was the cancel, not a conversion fault.
                self._mark_cancelled(job)
            else:
                job.status = "failed"
                job.error = str(exc)
                job.append(f"[error] {exc}")
        finally:
            job.finished.set()

    @staticmethod
    def _mark_cancelled(job: Job) -> None:
        job.status = "cancelled"
        job.append("[cancelled] stopped on request")
