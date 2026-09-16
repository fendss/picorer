from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator, Mapping, Optional, Sequence

from .models import (
    AttemptContext,
    FailureClassification,
    NormalizedUsage,
    TaskSpec,
    TaskStatus,
)
from .retry import sanitize_error_message

if TYPE_CHECKING:
    from .usage import PriceTable


_SECRET_VALUE_PATTERNS = (
    re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"(?i)(api[_-]?key\s*[:=]\s*)[^\s,;]+"),
)


def _redact_secret_string(value: str) -> str:
    result = value
    for pattern in _SECRET_VALUE_PATTERNS:
        if pattern.pattern.startswith("\\bsk-"):
            result = pattern.sub("sk-[REDACTED]", result)
        else:
            result = pattern.sub(r"\1[REDACTED]", result)
    return result


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_json_atomic(path: Path, value: Any, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(canonical_json_bytes(value))
            handle.write(b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, mode)
        _fsync_directory(path.parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def _install_json_once(path: Path, value: Any, *, mode: int = 0o600) -> bool:
    """Atomically install a new immutable JSON file.

    Returns ``True`` when this call created the file.  An existing byte-for-byte
    identical value is idempotent; a conflicting value raises ``ValueError``.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    expected = canonical_json_bytes(value) + b"\n"
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(expected)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            actual = path.read_bytes()
            if actual != expected:
                raise ValueError(f"immutable artifact conflict at {path}")
            return False
        os.chmod(path, mode)
        _fsync_directory(path.parent)
        return True
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"expected an object in {path}")
    return value


def locked_manifest_document(
    value: Mapping[str, Any], *, require_existing_hash: bool = False
) -> dict[str, Any]:
    body = dict(value)
    supplied = body.pop("manifest_sha256", None)
    calculated = canonical_sha256(body)
    if require_existing_hash and supplied is None:
        raise ValueError("locked manifest is missing manifest_sha256")
    if supplied is not None and supplied != calculated:
        raise ValueError("manifest_sha256 does not match manifest contents")
    body["manifest_sha256"] = calculated
    return body


def validate_locked_manifest(value: Mapping[str, Any]) -> dict[str, Any]:
    return locked_manifest_document(value, require_existing_hash=True)


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-.")[:48]
    return slug or "task"


def _task_filename(task_key: str) -> str:
    digest = hashlib.sha256(task_key.encode("utf-8")).hexdigest()[:24]
    return f"{_safe_slug(task_key)}--{digest}.json"


def task_artifact_filename(task_key: str) -> str:
    return _task_filename(task_key)


def _assert_secret_free(value: Any, path: str = "manifest") -> None:
    secret_keys = {
        "api_key",
        "apikey",
        "authorization",
        "access_token",
        "refresh_token",
        "secret",
    }
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in secret_keys:
                raise ValueError(f"secret-bearing key is forbidden in {path}: {key}")
            _assert_secret_free(child, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            _assert_secret_free(child, f"{path}[{index}]")
    elif isinstance(value, str) and _redact_secret_string(value) != value:
        raise ValueError(f"secret-bearing string is forbidden in {path}")


def _redact_sensitive(value: Any) -> Any:
    secret_keys = {
        "api_key",
        "apikey",
        "authorization",
        "access_token",
        "refresh_token",
        "secret",
    }
    if isinstance(value, Mapping):
        redacted: dict[str, Any] = {}
        for key, child in value.items():
            normalized = str(key).lower().replace("-", "_")
            redacted[str(key)] = (
                "[REDACTED]"
                if normalized in secret_keys
                else _redact_sensitive(child)
            )
        return redacted
    if isinstance(value, (list, tuple)):
        return [_redact_sensitive(child) for child in value]
    if isinstance(value, str):
        return _redact_secret_string(value)
    return value


@dataclass(frozen=True)
class JudgeCacheKey:
    evaluator_revision: str
    judge_adapter_version: str
    system_prompt_sha256: str
    user_prompt_sha256: str
    prediction_sha256: str
    reference_sha256: str
    requested_model: str
    observed_model_policy: str
    temperature: float
    reasoning: Optional[str]
    max_output_tokens: Optional[int]

    def payload(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def digest(self) -> str:
        return canonical_sha256(self.payload())


class AttemptHandle:
    def __init__(self, store: "ArtifactStore", context: AttemptContext):
        self.store = store
        self.context = context
        self._sequence = 0
        self._sequence_lock = threading.Lock()

    @property
    def trajectory_path(self) -> Path:
        return self.context.attempt_dir / "trajectory.jsonl"

    def append_event(
        self,
        *,
        component: str,
        kind: str,
        payload: Mapping[str, Any],
        subtask_id: Optional[str] = None,
    ) -> dict[str, Any]:
        with self._sequence_lock:
            self._sequence += 1
            sequence = self._sequence
        event = {
            "event_id": uuid.uuid4().hex,
            "run_id": self.context.run_id,
            "task_key": self.context.task.task_key,
            "attempt_id": self.context.attempt_id,
            "domain": self.context.task.domain,
            "subtask_id": subtask_id,
            "sequence": sequence,
            "timestamp": utc_now(),
            "component": component,
            "kind": kind,
            "payload": _redact_sensitive(payload),
        }
        self.store._append_jsonl(self.trajectory_path, event)
        return event

    def record_usage(
        self,
        *,
        stage: str,
        model: str,
        usage: NormalizedUsage,
        request_id: Optional[str] = None,
        response_model: Optional[str] = None,
    ) -> None:
        self.store.record_usage(
            task_key=self.context.task.task_key,
            attempt_id=self.context.attempt_id,
            stage=stage,
            model=model,
            usage=usage,
            request_id=request_id,
            response_model=response_model,
        )

    def record_raw_usage(
        self,
        *,
        stage: str,
        model: str,
        usage: Mapping[str, Any],
        price_table: Optional["PriceTable"] = None,
        request_id: Optional[str] = None,
        response_model: Optional[str] = None,
    ) -> NormalizedUsage:
        from .usage import normalize_usage

        normalized = normalize_usage(
            usage,
            model=model,
            price_table=(price_table if price_table is not None else self.store.price_table),
        )
        self.record_usage(
            stage=stage,
            model=model,
            usage=normalized,
            request_id=request_id,
            response_model=response_model,
        )
        return normalized

    def finish(
        self,
        status: TaskStatus,
        *,
        failure: Optional[FailureClassification] = None,
        error: Optional[BaseException] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        return self.store.finish_attempt(
            self.context,
            status,
            failure=failure,
            error=error,
            metadata=metadata,
        )


class ArtifactStore:
    """Durable source of truth for one MemoryArena Public run."""

    def __init__(
        self,
        run_dir: Path | str,
        run_id: str,
        *,
        price_table: Optional["PriceTable"] = None,
    ):
        self.run_dir = Path(run_dir)
        self.run_id = run_id
        self.records_dir = self.run_dir / "records"
        self.attempts_dir = self.run_dir / "attempts"
        self.judge_cache_dir = self.run_dir / "judge-cache"
        self.usage_dir = self.run_dir / "usage"
        self.indexes_dir = self.run_dir / "indexes"
        self.price_table = price_table
        self._append_lock = threading.Lock()

    @property
    def run_manifest_path(self) -> Path:
        return self.run_dir / "run-manifest.json"

    @property
    def task_manifest_path(self) -> Path:
        return self.run_dir / "task-manifest.json"

    def initialize(
        self,
        *,
        run_manifest: Mapping[str, Any],
        task_manifest: Mapping[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.run_dir, 0o700)
        for directory in (
            self.records_dir,
            self.attempts_dir,
            self.judge_cache_dir,
            self.usage_dir,
            self.indexes_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, 0o700)

        task_body = dict(task_manifest)
        task_body.setdefault("benchmark_name", "MemoryArena Public")
        if task_body.get("benchmark_name") != "MemoryArena Public":
            raise ValueError("task manifest benchmark_name must be MemoryArena Public")
        task_document = locked_manifest_document(task_body)

        run_body = dict(run_manifest)
        run_body.setdefault("benchmark_name", "MemoryArena Public")
        run_body.setdefault("run_id", self.run_id)
        if run_body.get("benchmark_name") != "MemoryArena Public":
            raise ValueError("run manifest benchmark_name must be MemoryArena Public")
        if run_body.get("run_id") != self.run_id:
            raise ValueError("run manifest run_id differs from ArtifactStore run_id")
        supplied_task_hash = run_body.get("task_manifest_sha256")
        if supplied_task_hash is not None and supplied_task_hash != task_document[
            "manifest_sha256"
        ]:
            raise ValueError("run manifest references a different task manifest")
        run_body["task_manifest_sha256"] = task_document["manifest_sha256"]
        run_document = locked_manifest_document(run_body)
        _assert_secret_free(task_document)
        _assert_secret_free(run_document)

        _install_json_once(self.task_manifest_path, task_document)
        _install_json_once(self.run_manifest_path, run_document)
        return run_document, task_document

    def load_manifests(self) -> tuple[dict[str, Any], dict[str, Any]]:
        run_manifest = read_json(self.run_manifest_path)
        task_manifest = read_json(self.task_manifest_path)
        self._validate_manifest_hash(run_manifest, self.run_manifest_path)
        self._validate_manifest_hash(task_manifest, self.task_manifest_path)
        if run_manifest.get("task_manifest_sha256") != task_manifest.get(
            "manifest_sha256"
        ):
            raise ValueError("run manifest references a different task manifest")
        return run_manifest, task_manifest

    @staticmethod
    def _validate_manifest_hash(value: Mapping[str, Any], path: Path) -> None:
        expected = value.get("manifest_sha256")
        body = dict(value)
        body.pop("manifest_sha256", None)
        if not expected or canonical_sha256(body) != expected:
            raise ValueError(f"manifest integrity check failed: {path}")

    @contextlib.contextmanager
    def run_lock(self) -> Iterator[None]:
        lock_path = self.run_dir / ".runner.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            os.close(descriptor)
            raise RuntimeError(f"another runner owns {self.run_dir}") from error
        try:
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _task_attempts_dir(self, task_key: str) -> Path:
        name = _task_filename(task_key).removesuffix(".json")
        return self.attempts_dir / name

    def record_path(self, task_key: str) -> Path:
        return self.records_dir / _task_filename(task_key)

    def start_attempt(self, task: TaskSpec) -> AttemptHandle:
        attempt_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{uuid.uuid4().hex[:12]}"
        attempt_dir = self._task_attempts_dir(task.task_key) / attempt_id
        attempt_dir.mkdir(parents=True, exist_ok=False)
        os.chmod(attempt_dir, 0o700)
        memory_scope = f"{self.run_id}/{canonical_sha256(task.task_key)[:16]}/{attempt_id}"
        context = AttemptContext(
            run_id=self.run_id,
            task=task,
            attempt_id=attempt_id,
            attempt_dir=attempt_dir,
            memory_scope=memory_scope,
        )
        write_json_atomic(
            attempt_dir / "attempt.json",
            {
                "schema_version": 1,
                "run_id": self.run_id,
                "task_key": task.task_key,
                "domain": task.domain,
                "source_record_hash": task.source_record_hash,
                "attempt_id": attempt_id,
                "memory_scope": memory_scope,
                "status": TaskStatus.RUNNING.value,
                "started_at": utc_now(),
                "finished_at": None,
                "failure": None,
                "error": None,
                "metadata": {},
            },
        )
        return AttemptHandle(self, context)

    def finish_attempt(
        self,
        context: AttemptContext,
        status: TaskStatus,
        *,
        failure: Optional[FailureClassification] = None,
        error: Optional[BaseException] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        if status not in {
            TaskStatus.FAILED_RETRYABLE,
            TaskStatus.SUCCEEDED,
            TaskStatus.BLOCKED,
            TaskStatus.PENDING,
        }:
            raise ValueError(f"invalid terminal attempt status: {status.value}")
        path = context.attempt_dir / "attempt.json"
        value = read_json(path)
        if value.get("status") != TaskStatus.RUNNING.value:
            if value.get("status") == status.value:
                return value
            raise ValueError(f"attempt is already terminal: {context.attempt_id}")
        value.update(
            {
                "status": status.value,
                "finished_at": utc_now(),
                "failure": failure.to_dict() if failure else None,
                "error": sanitize_error_message(error) if error else None,
                "metadata": dict(metadata or {}),
            }
        )
        trajectory = context.attempt_dir / "trajectory.jsonl"
        value["trajectory_sha256"] = file_sha256(trajectory) if trajectory.exists() else None
        write_json_atomic(path, value)
        return value

    def list_attempts(self, task_key: str) -> list[dict[str, Any]]:
        directory = self._task_attempts_dir(task_key)
        if not directory.exists():
            return []
        attempts = []
        for path in sorted(directory.glob("*/attempt.json")):
            value = read_json(path)
            value["_attempt_dir"] = str(path.parent)
            attempts.append(value)
        attempts.sort(key=lambda item: (item.get("started_at", ""), item["attempt_id"]))
        return attempts

    def recover_stale_running(self) -> list[str]:
        recovered: list[str] = []
        for path in sorted(self.attempts_dir.glob("*/*/attempt.json")):
            value = read_json(path)
            if value.get("status") != TaskStatus.RUNNING.value:
                continue
            value.update(
                {
                    "status": TaskStatus.FAILED_RETRYABLE.value,
                    "finished_at": utc_now(),
                    "failure": {
                        "kind": "interrupted",
                        "retryable": True,
                        "blocked": False,
                        "stage": "task-supervisor",
                    },
                    "error": "runner exited before the attempt became durable",
                    "metadata": {"recovered_on_resume": True},
                }
            )
            trajectory = path.parent / "trajectory.jsonl"
            value["trajectory_sha256"] = (
                file_sha256(trajectory) if trajectory.exists() else None
            )
            write_json_atomic(path, value)
            recovered.append(str(value["attempt_id"]))
        return recovered

    def install_success(
        self,
        *,
        task: TaskSpec,
        context: AttemptContext,
        completed_subtask_ids: Sequence[str],
        result: Mapping[str, Any],
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> dict[str, Any]:
        if tuple(completed_subtask_ids) != task.subtask_ids:
            raise ValueError(
                f"incomplete or reordered subtasks for {task.task_key}: "
                f"expected {task.subtask_ids}, got {tuple(completed_subtask_ids)}"
            )
        attempt = read_json(context.attempt_dir / "attempt.json")
        if attempt.get("status") != TaskStatus.SUCCEEDED.value:
            raise ValueError("success record requires a succeeded attempt")
        record = {
            "schema_version": 1,
            "run_id": self.run_id,
            "task_key": task.task_key,
            "domain": task.domain,
            "source_record_hash": task.source_record_hash,
            "completed_subtask_ids": list(completed_subtask_ids),
            "accepted_attempt_id": context.attempt_id,
            "attempt_trajectory_sha256": attempt.get("trajectory_sha256"),
            "result": dict(result),
            "metadata": dict(metadata or {}),
            "completed_at": utc_now(),
        }
        record["record_sha256"] = canonical_sha256(record)
        _install_json_once(self.record_path(task.task_key), record)
        return record

    def load_success(self, task_key: str) -> Optional[dict[str, Any]]:
        path = self.record_path(task_key)
        if not path.exists():
            return None
        value = read_json(path)
        expected = value.get("record_sha256")
        body = dict(value)
        body.pop("record_sha256", None)
        if not expected or canonical_sha256(body) != expected:
            raise ValueError(f"success record integrity check failed: {path}")
        return value

    def task_status(self, task_key: str) -> TaskStatus:
        if self.record_path(task_key).exists():
            return TaskStatus.SUCCEEDED
        attempts = self.list_attempts(task_key)
        if not attempts:
            return TaskStatus.PENDING
        latest = TaskStatus(attempts[-1]["status"])
        return latest

    def _append_jsonl(self, path: Path, value: Mapping[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        encoded = canonical_json_bytes(dict(value)) + b"\n"
        with self._append_lock:
            descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                os.write(descriptor, encoded)
                os.fsync(descriptor)
            finally:
                with contextlib.suppress(OSError):
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)

    def record_usage(
        self,
        *,
        task_key: Optional[str],
        attempt_id: Optional[str],
        stage: str,
        model: str,
        usage: NormalizedUsage,
        request_id: Optional[str] = None,
        response_model: Optional[str] = None,
        disposition_hint: Optional[str] = None,
    ) -> None:
        if disposition_hint not in {None, "accepted_evaluation", "retry_overhead"}:
            raise ValueError(f"invalid usage disposition: {disposition_hint}")
        usage = self._auditable_usage(usage)
        self._append_jsonl(
            self.usage_dir / "events.jsonl",
            {
                "schema_version": 1,
                "timestamp": utc_now(),
                "run_id": self.run_id,
                "task_key": task_key,
                "attempt_id": attempt_id,
                "stage": stage,
                "requested_model": model,
                "response_model": response_model,
                "request_id": request_id,
                "disposition_hint": disposition_hint,
                "usage": usage.to_dict(),
            },
        )

    @staticmethod
    def _auditable_usage(usage: NormalizedUsage) -> NormalizedUsage:
        # Several OpenAI-compatible model catalogs populate an all-zero cost
        # placeholder. A zero is only auditable when it was derived from an
        # explicit, SHA-bound price table (including an explicitly free model).
        if usage.cost_usd == 0 and not (
            usage.price_sha256 is not None
            and (usage.price_source or "").startswith("price-table:")
        ):
            return replace(
                usage,
                cost_usd=None,
                price_source="unknown-unattributed-zero",
                price_sha256=None,
            )
        return usage

    def summarize_usage(self) -> dict[str, Any]:
        from .reporting import summarize_usage

        return summarize_usage(self)

    def generate_indexes(self) -> dict[str, Any]:
        from .reporting import generate_indexes

        return generate_indexes(self)
    def get_judge_cache(self, key: JudgeCacheKey) -> Optional[dict[str, Any]]:
        path = self.judge_cache_dir / f"{key.digest}.json"
        if not path.exists():
            return None
        value = read_json(path)
        if value.get("cache_key") != key.digest or value.get("key_payload") != key.payload():
            raise ValueError(f"judge cache provenance mismatch: {path}")
        if value.get("status") != "succeeded" or value.get("parse_valid") is not True:
            raise ValueError(f"invalid judge cache entry: {path}")
        return value

    def put_judge_cache(
        self,
        key: JudgeCacheKey,
        *,
        raw_response: Any,
        parsed_decision: Any,
        usage: Optional[NormalizedUsage],
        response_id: Optional[str],
        response_model: Optional[str],
        task_key: Optional[str] = None,
        attempt_id: Optional[str] = None,
    ) -> dict[str, Any]:
        path = self.judge_cache_dir / f"{key.digest}.json"
        existing = self.get_judge_cache(key)
        if existing is not None:
            return existing
        value = {
            "schema_version": 1,
            "cache_key": key.digest,
            "key_payload": key.payload(),
            "status": "succeeded",
            "parse_valid": True,
            "raw_response": _redact_sensitive(raw_response),
            "parsed_decision": parsed_decision,
            "usage": self._auditable_usage(usage).to_dict() if usage else None,
            "response_id": response_id,
            "response_model": response_model,
            "created_at": utc_now(),
        }
        try:
            created = _install_json_once(path, value)
        except ValueError:
            # Concurrent evaluators use first-success-wins cache semantics.
            raced = self.get_judge_cache(key)
            if raced is None:
                raise
            return raced
        if not created:
            cached = self.get_judge_cache(key)
            if cached is None:
                raise ValueError(f"judge cache disappeared during install: {path}")
            return cached
        if usage is not None:
            self.record_usage(
                task_key=task_key,
                attempt_id=attempt_id,
                stage="judge",
                model=key.requested_model,
                usage=usage,
                response_model=response_model,
                disposition_hint=(
                    "accepted_evaluation" if attempt_id is None else None
                ),
            )
        return value

    def write_state(self, state: Mapping[str, Any]) -> None:
        write_json_atomic(self.run_dir / "state.json", dict(state))
