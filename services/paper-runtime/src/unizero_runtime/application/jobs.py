"""In-process single-worker job queue for GPU-friendly conversion."""

from __future__ import annotations

import threading
import time
import uuid
from queue import Queue
from typing import Callable, Optional

from ..contracts import ConvertRequest


class Job:
    def __init__(self, job_id: str, request: ConvertRequest):
        self.id = job_id
        self.request = request
        self.status = "queued"
        self.log: list[str] = []
        self.result: Optional[dict] = None
        self.error: Optional[str] = None
        self.created = time.time()

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
        return self._queue.qsize()

    def has_active(self) -> bool:
        return any(job.status in ("queued", "running") for job in self.list())

    def _worker_loop(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                job = self.get(job_id)
                if job is None:
                    continue
                job.status = "running"
                try:
                    self._processor(job)
                    job.status = "done"
                except Exception as exc:
                    job.status = "failed"
                    job.error = str(exc)
                    job.append(f"[error] {exc}")
            finally:
                self._queue.task_done()
