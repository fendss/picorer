from __future__ import annotations

import hashlib
import os
import signal
import threading
import time
import traceback
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

from .adapters import load_adapter
from .artifacts import atomic_json, canonical_json, read_json, safe_component
from .contracts import RetryableStageError
from .state import PipelineState
from .transport import RedisTransport


class Worker:
    def __init__(
        self,
        state: PipelineState,
        transport: RedisTransport,
        stage: str,
        artifacts: Path,
        concurrency: int,
        stale_seconds: float,
        max_downstream_backlog: int | None = None,
    ) -> None:
        self.state = state
        self.transport = transport
        self.stage = stage
        self.artifacts = artifacts
        self.concurrency = concurrency
        self.stale_seconds = stale_seconds
        self.max_downstream_backlog = max_downstream_backlog
        self.worker = f"{os.uname().nodename}-{os.getpid()}-{stage}-{uuid.uuid4().hex[:6]}"
        self.stop = threading.Event()
        self._signals = 0

    def request_stop(self, _signum: int, _frame: object) -> None:
        self._signals += 1
        self.stop.set()
        if self._signals > 1:
            os._exit(128 + _signum)

    def _artifact_path(self, question_id: str) -> Path:
        return self.artifacts / safe_component(question_id) / f"{self.stage}.json"

    def _notify(self, question_id: str, stage: str) -> None:
        while not self.stop.is_set():
            try:
                self.transport.enqueue(question_id, stage)
                return
            except Exception:  # noqa: BLE001 - transport implementations vary
                time.sleep(1)

    def _recover_and_emit_ready(self) -> None:
        self.state.recover_stale(self.stale_seconds, self.stage)
        for question_id, stage in self.state.queue_ready(self.stage):
            self._notify(question_id, stage)

    def _process(self, message_id: str, question_id: str) -> None:
        claimed = self.state.claim(question_id, self.stage, self.worker)
        if claimed is None:
            self.transport.acknowledge(self.stage, message_id)
            return
        started = time.monotonic()
        heartbeat_stop = threading.Event()

        def heartbeat() -> None:
            while not heartbeat_stop.wait(20):
                self.state.heartbeat(question_id, self.stage, self.worker)

        heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
        heartbeat_thread.start()
        try:
            prior = {
                stage: read_json(Path(path))["output"]
                for stage, path in self.state.artifacts(question_id, self.stage).items()
            }
            adapter = load_adapter(claimed["adapter"])
            result = adapter.run(self.stage, claimed["payload"], prior)
            duration = time.monotonic() - started
            artifact = {
                "schema_version": 1,
                "question_id": question_id,
                "benchmark": claimed["benchmark"],
                "adapter": claimed["adapter"],
                "stage": self.stage,
                "attempt": claimed["attempt"],
                "duration_seconds": duration,
                "output": dict(result.output),
            }
            path = self._artifact_path(question_id)
            atomic_json(path, artifact)
            digest = hashlib.sha256(canonical_json(artifact)).hexdigest()
            next_stage = self.state.complete(
                question_id, self.stage, self.worker, result.status,
                str(path), digest, duration,
            )
            if next_stage is not None and self.state.queue_one(question_id, next_stage):
                self._notify(question_id, next_stage)
        except Exception as error:  # noqa: BLE001 - adapters define their errors
            retryable = isinstance(error, RetryableStageError)
            detail = "".join(traceback.format_exception(type(error), error, error.__traceback__))
            status = self.state.fail(
                question_id, self.stage, self.worker, detail, retryable,
            )
            if status == "ready":
                # Keep a transient endpoint outage from consuming every
                # per-question attempt in the same millisecond.
                time.sleep(min(2 ** max(int(claimed["attempt"]) - 1, 0), 30))
                if self.state.queue_one(question_id, self.stage):
                    self._notify(question_id, self.stage)
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=1)
            self.transport.acknowledge(self.stage, message_id)

    def run(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be positive")
        self.transport.client.ping()
        self.transport.ensure_group(self.stage)
        self._recover_and_emit_ready()
        # Redis is only a wake-up channel. Re-emit queued rows after a Redis
        # restart or a crash between the SQLite transition and XADD.
        for question_id in self.state.queued(self.stage):
            self._notify(question_id, self.stage)
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)
        futures: set[Future[None]] = set()
        recovery_interval = min(max(self.stale_seconds / 3, 5), 60)
        next_recovery = time.monotonic() + recovery_interval
        with ThreadPoolExecutor(max_workers=self.concurrency) as executor:
            while not self.stop.is_set() or futures:
                done = {future for future in futures if future.done()}
                for future in done:
                    future.result()
                futures -= done
                if self.stop.is_set():
                    if futures:
                        time.sleep(0.1)
                    continue
                if time.monotonic() >= next_recovery:
                    self._recover_and_emit_ready()
                    next_recovery = time.monotonic() + recovery_interval
                if len(futures) >= self.concurrency:
                    time.sleep(0.02)
                    continue
                if (
                    self.max_downstream_backlog is not None
                    and self.stage == "retrieval"
                    and self.state.backlog("answer") >= self.max_downstream_backlog
                ):
                    time.sleep(0.25)
                    continue
                values = self.transport.read(
                    self.stage, self.worker,
                    count=self.concurrency - len(futures), block_ms=1000,
                )
                for _stream, messages in values:
                    for message_id, fields in messages:
                        question_id = fields.get("question_id")
                        if not question_id:
                            self.transport.acknowledge(self.stage, message_id)
                            continue
                        futures.add(executor.submit(self._process, message_id, question_id))
