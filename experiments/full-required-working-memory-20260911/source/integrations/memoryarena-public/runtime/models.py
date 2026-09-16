from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    FAILED_RETRYABLE = "failed-retryable"
    SUCCEEDED = "succeeded"
    BLOCKED = "blocked"


class FailureKind(str, Enum):
    TIMEOUT = "timeout"
    RATE_LIMIT = "rate-limit"
    PROVIDER_5XX = "provider-5xx"
    NETWORK = "network"
    AUTH = "auth"
    INVALID_REQUEST = "invalid-request"
    QUOTA_EXHAUSTED = "quota-exhausted"
    MODEL_NOT_FOUND = "model-not-found"
    RESPONSE_MODEL_MISMATCH = "response-model-mismatch"
    INTERRUPTED = "interrupted"
    PROTOCOL = "protocol"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class FailureClassification:
    kind: FailureKind
    retryable: bool
    blocked: bool
    status_code: Optional[int] = None
    provider_code: Optional[str] = None
    retry_after_seconds: Optional[float] = None
    stage: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["kind"] = self.kind.value
        return value


@dataclass(frozen=True)
class NormalizedUsage:
    """Provider-neutral token and cost accounting.

    ``reasoning_tokens`` is a subset of output tokens.  Unknown pricing is
    represented as ``None`` rather than zero so reports cannot accidentally
    claim that an unpriced model was free.
    """

    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    total_tokens: Optional[int] = None
    cost_usd: Optional[float] = None
    price_source: Optional[str] = None
    price_sha256: Optional[str] = None

    def __post_init__(self) -> None:
        token_fields = (
            self.input_tokens,
            self.output_tokens,
            self.cached_input_tokens,
            self.cache_write_tokens,
            self.reasoning_tokens,
        )
        if any(value < 0 for value in token_fields):
            raise ValueError("token counts must be non-negative")
        if self.total_tokens is not None and self.total_tokens < 0:
            raise ValueError("total_tokens must be non-negative")
        if self.cost_usd is not None and self.cost_usd < 0:
            raise ValueError("cost_usd must be non-negative")
        if self.reasoning_tokens > self.output_tokens:
            raise ValueError("reasoning_tokens must be a subset of output_tokens")

    @property
    def effective_total_tokens(self) -> int:
        if self.total_tokens is not None:
            return self.total_tokens
        return (
            self.input_tokens
            + self.cached_input_tokens
            + self.cache_write_tokens
            + self.output_tokens
        )

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["effective_total_tokens"] = self.effective_total_tokens
        return value

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "NormalizedUsage":
        return cls(
            input_tokens=int(value.get("input_tokens", 0)),
            output_tokens=int(value.get("output_tokens", 0)),
            cached_input_tokens=int(value.get("cached_input_tokens", 0)),
            cache_write_tokens=int(value.get("cache_write_tokens", 0)),
            reasoning_tokens=int(value.get("reasoning_tokens", 0)),
            total_tokens=(
                int(value["total_tokens"])
                if value.get("total_tokens") is not None
                else None
            ),
            cost_usd=(
                float(value["cost_usd"])
                if value.get("cost_usd") is not None
                else None
            ),
            price_source=value.get("price_source"),
            price_sha256=value.get("price_sha256"),
        )


@dataclass(frozen=True)
class TaskSpec:
    task_key: str
    domain: str
    subtask_ids: tuple[str, ...]
    source_record_hash: str
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.task_key:
            raise ValueError("task_key must not be empty")
        if not self.domain:
            raise ValueError("domain must not be empty")
        if not self.subtask_ids:
            raise ValueError("a task group must contain at least one subtask")
        if len(set(self.subtask_ids)) != len(self.subtask_ids):
            raise ValueError(f"duplicate subtask ids in {self.task_key}")
        if not re.fullmatch(r"[0-9a-f]{64}", self.source_record_hash):
            raise ValueError("source_record_hash must be a lowercase SHA-256")

    def to_manifest_entry(self) -> dict[str, Any]:
        return {
            "task_key": self.task_key,
            "domain": self.domain,
            "subtask_ids": list(self.subtask_ids),
            "source_record_hash": self.source_record_hash,
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_manifest_entry(cls, value: Mapping[str, Any]) -> "TaskSpec":
        return cls(
            task_key=str(value["task_key"]),
            domain=str(value["domain"]),
            subtask_ids=tuple(str(item) for item in value["subtask_ids"]),
            source_record_hash=str(value["source_record_hash"]),
            metadata=dict(value.get("metadata", {})),
        )


@dataclass(frozen=True)
class AttemptContext:
    run_id: str
    task: TaskSpec
    attempt_id: str
    attempt_dir: Path
    memory_scope: str


@dataclass(frozen=True)
class TaskExecutionResult:
    """A complete, infrastructure-valid result for one official task group.

    A wrong model answer is still a valid result and must be returned here.
    Provider failures and incomplete official output must be raised instead.
    """

    completed_subtask_ids: tuple[str, ...]
    result: Mapping[str, Any]
    usage: Sequence[Mapping[str, Any]] = field(default_factory=tuple)
    metadata: Mapping[str, Any] = field(default_factory=dict)
