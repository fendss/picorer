from __future__ import annotations

import hashlib
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

from .artifacts import read_json, write_json_atomic
from .chunking import chunk_text
from .clients import ChatClient, MemoryClient, MemoryWrapResult, RemoteError
from .config import SYSTEM_PROMPT, TaskConfig
from .contracts import Context, Query
from .dataset import load_pins
from .load_control import (
    AdaptiveConcurrencyConfig,
    AdaptiveConcurrencyController,
    AdaptiveStageConcurrencyConfig,
)
from .longmemeval import StructuredMemoryAppend, structured_longmemeval_appends
from .scoring import score_prediction


@dataclass(frozen=True)
class RunSettings:
    output_path: Path
    reuse_ingestion_from: Path | None = None
    max_contexts: int | None = None
    max_queries: int | None = None
    resume: bool = False
    operator_mode: str = "static"
    max_search_calls: int = 4
    context_slots: int = 1
    query_slots: int = 1
    adaptive_query_slots: (
        AdaptiveConcurrencyConfig | AdaptiveStageConcurrencyConfig | None
    ) = None
    run_config_sha256: str | None = None
    interruption_requested: Callable[[], bool] | None = None


class RunInterrupted(RuntimeError):
    """Raised only after the latest resumable state has been persisted."""


class RetryableRunUnavailable(RuntimeError):
    """Raised after a transient remote failure is persisted without scoring it."""


ADAPTIVE_STAGE_SCHEMA_VERSION = 3
ADAPTIVE_STAGE_POLICY = "stage-independent-aimd-v1"


def _adaptive_stage_config(
    value: AdaptiveConcurrencyConfig | AdaptiveStageConcurrencyConfig | None,
) -> AdaptiveStageConcurrencyConfig | None:
    if value is None:
        return None
    if isinstance(value, AdaptiveStageConcurrencyConfig):
        return value
    return AdaptiveStageConcurrencyConfig(retrieval=value, answer=value)


def _adaptive_stage_snapshot(
    value: object,
) -> dict[str, dict[str, Any]] | None:
    if not isinstance(value, dict):
        return None
    if (
        value.get("schema_version") != ADAPTIVE_STAGE_SCHEMA_VERSION
        or value.get("policy") != ADAPTIVE_STAGE_POLICY
    ):
        return None
    stages = value.get("stages")
    if not isinstance(stages, dict):
        return None
    retrieval = stages.get("retrieval")
    answer = stages.get("answer")
    if not isinstance(retrieval, dict) or not isinstance(answer, dict):
        return None
    return {"retrieval": retrieval, "answer": answer}


def _ingestion_strategy(task: TaskConfig) -> str:
    return (
        "longmemeval-visible-session-turns-v1"
        if task.task_id == "longmemeval-s"
        else "document-chunks-v1"
    )


def _user_id(task: TaskConfig, context: Context, output_path: Path) -> str:
    identity = f"{task.task_id}\0{context.ordinal}\0{output_path.resolve()}"
    return "mab-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]


def _ingestion_identity_path(source_path: Path) -> Path:
    """Resolve the original artifact whose path names the stored memory users."""
    current = source_path.resolve()
    visited: set[Path] = set()
    while True:
        if current in visited:
            raise ValueError("Ingestion reuse provenance contains a cycle")
        visited.add(current)
        source = read_json(current)
        reuse = source.get("ingestion_reuse")
        if reuse is None:
            return current
        if not isinstance(reuse, dict):
            raise ValueError("Ingestion reuse provenance must be an object")
        parent_value = reuse.get("source")
        expected_sha256 = reuse.get("sha256")
        if not isinstance(parent_value, str) or not isinstance(expected_sha256, str):
            raise ValueError("Ingestion reuse provenance is incomplete")
        parent = Path(parent_value).resolve()
        if not parent.is_file():
            raise ValueError("Ingestion reuse provenance source is unavailable")
        actual_sha256 = hashlib.sha256(parent.read_bytes()).hexdigest()
        if actual_sha256 != expected_sha256:
            raise ValueError("Ingestion reuse provenance hash does not match")
        current = parent


def _run_user_id(
    task: TaskConfig,
    context: Context,
    settings: RunSettings,
) -> str:
    identity_path = (
        settings.output_path
        if settings.reuse_ingestion_from is None
        else _ingestion_identity_path(settings.reuse_ingestion_from)
    )
    return _user_id(task, context, identity_path)


def _benchmark_query_id(context: Context, qa_pair_id: str) -> str:
    return f"context-{context.ordinal}/{qa_pair_id}"


def _new_document(
    task: TaskConfig,
    memory: MemoryClient,
    chat: ChatClient,
    settings: RunSettings,
    runtime_contract: dict[str, Any],
    runtime_identity_sha256: str,
    persistence_identity: str,
    expected_query_ids: Sequence[str],
) -> dict:
    if settings.operator_mode not in {"static", "ephemeral", "cumulative"}:
        raise ValueError("operator_mode must be static, ephemeral, or cumulative")
    if not 1 <= settings.max_search_calls <= 16:
        raise ValueError("max_search_calls must be between 1 and 16")
    pins = load_pins()
    ingestion_reuse = None if settings.reuse_ingestion_from is None else {
        "source": str(settings.reuse_ingestion_from.resolve()),
        "sha256": hashlib.sha256(
            settings.reuse_ingestion_from.read_bytes()
        ).hexdigest(),
    }
    return {
        "schema_version": 1,
        "benchmark": "MemoryAgentBench",
        "task": task.task_id,
        "capability": task.capability,
        "source": task.source,
        "official_metric": task.official_metric,
        "official_config": task.official_config,
        "ingestion_strategy": _ingestion_strategy(task),
        "memorize_template_sha256": hashlib.sha256(
            task.memorize_template.encode("utf-8")
        ).hexdigest(),
        "query_template_sha256": hashlib.sha256(
            task.query_template.encode("utf-8")
        ).hexdigest(),
        "benchmark_commit": pins["benchmark"]["commit"],
        "dataset_revision": pins["dataset"]["revision"],
        "memory_base_url": memory.http.base_url,
        "memory_system_name": memory.memory_system_name,
        "retrieval_runtime_contract": runtime_contract,
        "retrieval_runtime_identity_sha256": runtime_identity_sha256,
        "memory_persistence_identity": persistence_identity,
        "run_config_sha256": settings.run_config_sha256,
        "answer_handoff": memory.answer_handoff.handoff_id,
        "answer_prompt_version": memory.answer_handoff.prompt_version,
        "answer_system_prompt_sha256": hashlib.sha256(
            SYSTEM_PROMPT.encode("utf-8")
        ).hexdigest(),
        "memory_request_policy": {
            "timeout_seconds": memory.http.timeout_seconds,
            "initialize_retries": 0,
            "add_retries": 0,
            "wrap_retries": 0,
        },
        "answer_model": chat.model,
        "answer_base_url": chat.http.base_url,
        "answer_request_policy": {
            "timeout_seconds": chat.http.timeout_seconds,
            "retries": 0,
            "thinking_level": getattr(chat, "thinking_level", "off"),
            "max_tokens": getattr(chat, "request_max_tokens", None),
            "context_window": getattr(chat, "context_window", None),
            "context_safety_tokens": getattr(chat, "context_safety_tokens", 1024),
            "context_fit": "whole-memory-records-v1",
        },
        "operator_experiment": {
            "mode": settings.operator_mode,
            "max_search_calls": settings.max_search_calls,
            "state_boundary": "context",
            "signal": "retrieval-result-and-citations-only",
        },
        "ingestion_reuse": ingestion_reuse,
        "expected_query_ids": list(expected_query_ids),
        "context_ingestion_timestamps": {},
        "context_ingestion_users": {},
        "operator_evolution_states": {},
        "pending_by_context": {},
        "pending_by_query": {},
        "failures": [],
        "retryable_failures": [],
        "data": [],
        "metrics": {},
    }


def _summarize(document: dict) -> None:
    rows = document["data"]
    metric_names = {name for row in rows for name in row.get("metrics", {})}
    summary: dict[str, float | None] = {}
    for name in sorted(metric_names):
        values = [row["metrics"][name] for row in rows if row["metrics"].get(name) is not None]
        summary[name] = sum(values) / len(values) if values else None
    document["metrics"] = summary
    document["completed_queries"] = len(rows)
    audited_models = [
        row["retrieval_model"]
        for row in rows
        if isinstance(row.get("retrieval_model"), dict)
    ]
    unique_models: dict[str, dict] = {}
    response_models: dict[str, set[str]] = {}
    for model in audited_models:
        identity = _retrieval_model_identity(model)
        key = repr(sorted(identity.items(), key=lambda item: item[0]))
        unique_models[key] = identity
        response_models.setdefault(key, set()).update(model["responseModels"])
    document["retrieval_model_audit"] = {
        "audited_queries": len(audited_models),
        "unaudited_legacy_queries": len(rows) - len(audited_models),
        "models": [
            {**model, "responseModels": sorted(response_models[key])}
            for key, model in unique_models.items()
        ],
    }


def _retrieval_model_identity(model: dict) -> dict:
    return {
        field: model[field]
        for field in ("providerId", "modelId", "thinkingLevel", "transport")
    }


def _validate_retrieval_model_consistency(document: dict, model: dict | None) -> None:
    if model is None:
        raise ValueError("Picorer retrieval model audit is required")
    prior = [
        row.get("retrieval_model")
        for row in document["data"]
        if isinstance(row.get("retrieval_model"), dict)
    ]
    pending_values = list(document.get("pending_by_context", {}).values())
    pending_values.extend(document.get("pending_by_query", {}).values())
    legacy_pending = document.get("pending")
    if isinstance(legacy_pending, dict):
        pending_values.append(legacy_pending)
    for pending in pending_values:
        if isinstance(pending, dict) and isinstance(pending.get("retrieval_model"), dict):
            prior.append(pending["retrieval_model"])
    identity = _retrieval_model_identity(model)
    if any(_retrieval_model_identity(value) != identity for value in prior):
        raise ValueError("Picorer retrieval model changed within one benchmark artifact")


def _validate_resume_document(
    document: dict,
    expected: dict,
    contexts: Sequence[Context],
) -> None:
    # Artifacts created before ingestion strategies were explicit used generic
    # document chunks. This keeps those runs resumable without allowing them to
    # masquerade as the structured LongMemEval representation.
    document.setdefault("ingestion_strategy", "document-chunks-v1")
    identity_fields = (
        "schema_version",
        "benchmark",
        "task",
        "capability",
        "source",
        "official_metric",
        "official_config",
        "ingestion_strategy",
        "memorize_template_sha256",
        "query_template_sha256",
        "benchmark_commit",
        "dataset_revision",
        "memory_base_url",
        "memory_system_name",
        "retrieval_runtime_contract",
        "retrieval_runtime_identity_sha256",
        "memory_persistence_identity",
        "run_config_sha256",
        "answer_handoff",
        "answer_prompt_version",
        "answer_system_prompt_sha256",
        "memory_request_policy",
        "answer_model",
        "answer_base_url",
        "answer_request_policy",
        "operator_experiment",
        "ingestion_reuse",
        "expected_query_ids",
    )
    for field in identity_fields:
        if document.get(field) != expected[field]:
            raise ValueError(f"Resume output {field} does not match this run")

    rows = document.get("data")
    if not isinstance(rows, list):
        raise ValueError("Resume output data must be a list")
    valid_ids = set(expected["expected_query_ids"])
    completed_ids = [
        row.get("benchmark_query_id") for row in rows if isinstance(row, dict)
    ]
    if len(completed_ids) != len(rows) or any(
        not isinstance(value, str) or value not in valid_ids for value in completed_ids
    ):
        raise ValueError("Resume output contains an unknown benchmark_query_id")
    if len(set(completed_ids)) != len(completed_ids):
        raise ValueError("Resume output contains duplicate benchmark_query_id values")
    states = document.get("operator_evolution_states")
    if not isinstance(states, dict):
        raise ValueError("Resume output operator_evolution_states must be an object")
    timestamps = document.get("context_ingestion_timestamps")
    if not isinstance(timestamps, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in timestamps.items()
    ):
        raise ValueError("Resume output context_ingestion_timestamps must be an object")
    ingestion_users = document.get("context_ingestion_users")
    if ingestion_users is None:
        # Outputs produced before ingestion checkpoints were introduced remain
        # resumable. Proven checkpoints are reconstructed after validation.
        document["context_ingestion_users"] = {}
    elif not isinstance(ingestion_users, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in ingestion_users.items()
    ):
        raise ValueError("Resume output context_ingestion_users must be an object")
    pending_by_context = document.get("pending_by_context")
    if pending_by_context is None:
        pending_by_context = {}
        document["pending_by_context"] = pending_by_context
    if not isinstance(pending_by_context, dict):
        raise ValueError("Resume output pending_by_context must be an object")
    pending_by_query = document.get("pending_by_query")
    if pending_by_query is None:
        pending_by_query = {}
        document["pending_by_query"] = pending_by_query
    if not isinstance(pending_by_query, dict):
        raise ValueError("Resume output pending_by_query must be an object")
    legacy_pending = document.pop("pending", None)
    if legacy_pending is not None:
        if not isinstance(legacy_pending, dict):
            raise ValueError("Resume output contains an invalid pending retrieval")
        context_key = str(legacy_pending.get("context_id"))
        if context_key in pending_by_context:
            raise ValueError("Resume output contains duplicate pending retrievals")
        pending_by_context[context_key] = legacy_pending
    for context_key, pending in pending_by_context.items():
        if (
            not isinstance(context_key, str)
            or not isinstance(pending, dict)
            or str(pending.get("context_id")) != context_key
            or pending.get("benchmark_query_id") not in valid_ids
        ):
            raise ValueError("Resume output contains an invalid pending retrieval")
    for query_id, pending in pending_by_query.items():
        if (
            not isinstance(query_id, str)
            or query_id not in valid_ids
            or not isinstance(pending, dict)
            or pending.get("benchmark_query_id") != query_id
            or pending.get("benchmark_query_id") not in valid_ids
        ):
            raise ValueError("Resume output contains an invalid query pending retrieval")


def _reuse_ingestion_checkpoints(
    document: dict,
    task: TaskConfig,
    contexts: Sequence[Context],
    source_path: Path,
) -> None:
    source = read_json(source_path)
    source.setdefault("ingestion_strategy", "document-chunks-v1")
    identity_path = _ingestion_identity_path(source_path)
    for field in (
        "schema_version",
        "benchmark",
        "task",
        "source",
        "ingestion_strategy",
        "memorize_template_sha256",
        "benchmark_commit",
        "dataset_revision",
        "memory_base_url",
        "memory_system_name",
        "memory_persistence_identity",
    ):
        if source.get(field) != document.get(field):
            raise ValueError(f"Ingestion reuse source {field} does not match this run")
    users = source.get("context_ingestion_users")
    timestamps = source.get("context_ingestion_timestamps")
    if not isinstance(users, dict) or not isinstance(timestamps, dict):
        raise ValueError("Ingestion reuse source lacks context checkpoints")
    for context in contexts:
        key = str(context.ordinal)
        expected_user = _user_id(task, context, identity_path)
        if users.get(key) != expected_user or not isinstance(timestamps.get(key), str):
            raise ValueError(
                f"Ingestion reuse source lacks a valid checkpoint for context {key}"
            )
        document["context_ingestion_users"][key] = expected_user
        document["context_ingestion_timestamps"][key] = timestamps[key]


def _restore_legacy_ingestion_checkpoints(
    document: dict,
    task: TaskConfig,
    contexts: Sequence[Context],
    output_path: Path,
) -> None:
    """Infer only ingestion checkpoints proven by completed or pending queries."""
    observed_query_ids = {
        row["benchmark_query_id"] for row in document["data"]
    }
    for pending in document.get("pending_by_context", {}).values():
        observed_query_ids.add(pending["benchmark_query_id"])
    for pending in document.get("pending_by_query", {}).values():
        observed_query_ids.add(pending["benchmark_query_id"])

    for context in contexts:
        context_query_ids = {
            _benchmark_query_id(context, query.qa_pair_id)
            for query in context.queries
        }
        if observed_query_ids.isdisjoint(context_query_ids):
            continue
        document["context_ingestion_users"][str(context.ordinal)] = _user_id(
            task, context, output_path
        )


def _failure_value(
    benchmark_query_id: str,
    stage: str,
    error: Exception,
) -> dict:
    failure = {
        "benchmark_query_id": benchmark_query_id,
        "stage": stage,
        "error_type": type(error).__name__,
        "message": str(error)[:2000],
    }
    if isinstance(error, RemoteError):
        failure.update(
            {
                **(
                    {"http_status": error.http_status}
                    if error.http_status is not None
                    else {}
                ),
                **(
                    {"error_code": error.error_code}
                    if error.error_code is not None
                    else {}
                ),
                **(
                    {"retryable": error.retryable}
                    if error.retryable is not None
                    else {}
                ),
                "retryability_explicit": error.retryability_explicit,
                **(
                    {"diagnostics": error.diagnostics}
                    if error.diagnostics is not None
                    else {}
                ),
            }
        )
    return failure


def _failure_record(
    document: dict,
    benchmark_query_id: str,
    stage: str,
    error: Exception,
) -> dict:
    failure = _failure_value(benchmark_query_id, stage, error)
    document["failures"].append(failure)
    return failure


def _retryable_infrastructure_failure(error: RemoteError) -> bool:
    """Accept only typed failures that cannot represent a method resample."""
    return error.retryability_explicit is True and error.retryable is True and (
        error.http_status == 429
        or error.error_code in {"append_pending", "upstream_unavailable"}
    )


def _checkpointable_untyped_answer_failure(error: RemoteError) -> bool:
    """Checkpoint ordinary answer-provider outages at the pending prompt.

    Public OpenAI-compatible answer endpoints do not emit Picorer's typed retry
    headers.  Their transport failures and conventional overload statuses are
    recoverable only because retrieval has already been persisted.  Keeping
    this classification answer-stage-only prevents a Picorer method failure from
    being turned into retry-until-success.
    """
    if error.retryability_explicit is not False or error.retryable is not True:
        return False
    status = error.http_status
    return status is None or status in {408, 429} or status >= 500


def _aimd_congestion_failure(error: RemoteError, stage: str) -> bool:
    """Classify load signals independently from in-process retry safety."""
    return _retryable_infrastructure_failure(error) or (
        stage == "answer" and _checkpointable_untyped_answer_failure(error)
    )


def _pause_for_retryable_failure(
    document: dict,
    settings: RunSettings,
    benchmark_query_id: str,
    stage: str,
    error: RemoteError,
) -> None:
    failure = {
        "benchmark_query_id": benchmark_query_id,
        "stage": stage,
        "error_type": type(error).__name__,
        "message": str(error)[:2000],
        **({"http_status": error.http_status} if error.http_status is not None else {}),
        **({"error_code": error.error_code} if error.error_code is not None else {}),
        "retryable": True,
        "retryability_explicit": error.retryability_explicit,
        **({"diagnostics": error.diagnostics} if error.diagnostics is not None else {}),
    }
    document.setdefault("retryable_failures", []).append(failure)
    document["last_retryable_failure"] = failure
    _summarize(document)
    write_json_atomic(settings.output_path, document)
    raise RetryableRunUnavailable(
        f"Transient {stage} failure persisted for {benchmark_query_id}"
    ) from error


def _interrupt_at_checkpoint(document: dict, settings: RunSettings) -> None:
    requested = settings.interruption_requested
    if requested is None or not requested():
        return
    _summarize(document)
    write_json_atomic(settings.output_path, document)
    raise RunInterrupted("Benchmark run interrupted at a resumable checkpoint")


def _outcome_row(
    task: TaskConfig,
    context: Context,
    query: Query,
    benchmark_query_id: str,
    formatted_query: str,
    prediction: str,
    elapsed: float,
    operator_experiment: dict[str, Any] | None,
    retrieval_model: dict[str, Any] | None,
    failure: dict | None = None,
) -> dict:
    return {
        "context_id": context.ordinal,
        "benchmark_query_id": benchmark_query_id,
        "qa_pair_id": query.qa_pair_id,
        "question_id": query.question_id,
        "question_type": query.question_type,
        "query": formatted_query,
        "output": prediction,
        "answer": list(query.answers),
        "metrics": score_prediction(task, prediction, query.answers),
        "query_time_seconds": elapsed,
        "operator_experiment": operator_experiment,
        **(
            {"retrieval_model": retrieval_model}
            if retrieval_model is not None
            else {}
        ),
        **({"failure": failure} if failure is not None else {}),
    }


def _memory_appends(
    task: TaskConfig,
    context: Context,
    ingestion_timestamp: str,
    chunker: Callable[[str, int], list[str]],
) -> tuple[StructuredMemoryAppend, ...]:
    structured = (
        structured_longmemeval_appends(context.text)
        if task.task_id == "longmemeval-s"
        else None
    )
    if structured is not None:
        return structured
    return tuple(
        StructuredMemoryAppend(
            chunk=task.format_memory(chunk, ingestion_timestamp),
            messages=(),
        )
        for chunk in chunker(context.text, task.chunk_tokens)
    )


def _add_memory(
    memory: MemoryClient,
    user_id: str,
    append: StructuredMemoryAppend,
) -> None:
    if append.messages:
        memory.add(user_id, append.chunk, append.messages)
    else:
        memory.add(user_id, append.chunk)


def execute_run(
    task: TaskConfig,
    contexts: Sequence[Context],
    memory: MemoryClient,
    chat: ChatClient,
    settings: RunSettings,
    chunker: Callable[[str, int], list[str]] = chunk_text,
) -> dict:
    if not 1 <= settings.context_slots <= 64:
        raise ValueError("context_slots must be between 1 and 64")
    if not 1 <= settings.query_slots <= 256:
        raise ValueError("query_slots must be between 1 and 256")
    adaptive_stage_config = _adaptive_stage_config(settings.adaptive_query_slots)
    if adaptive_stage_config is not None:
        for stage in ("retrieval", "answer"):
            stage_config = getattr(adaptive_stage_config, stage)
            if stage_config.maximum > settings.query_slots:
                raise ValueError(
                    f"adaptive {stage} concurrency maximum must not exceed "
                    "query_slots"
                )
    selected_contexts = contexts[
        : settings.max_contexts if settings.max_contexts is not None else len(contexts)
    ]
    target_units = [
        (context, query)
        for context in selected_contexts
        for query in context.queries
    ]
    if settings.max_queries is not None:
        target_units = target_units[: settings.max_queries]
    target_query_ids = [
        _benchmark_query_id(context, query.qa_pair_id)
        for context, query in target_units
    ]
    selected_context_ids = {context.ordinal for context, _query in target_units}
    selected_contexts = tuple(
        context for context in selected_contexts
        if context.ordinal in selected_context_ids
    )
    if settings.resume and settings.output_path.exists():
        preflight = read_json(settings.output_path)
        for field, expected in (
            ("answer_handoff", memory.answer_handoff.handoff_id),
            ("answer_prompt_version", memory.answer_handoff.prompt_version),
        ):
            if preflight.get(field) != expected:
                raise ValueError(f"Resume output {field} does not match this run")
    runtime_identity = getattr(memory, "runtime_identity", None)
    if callable(runtime_identity):
        (
            runtime_contract,
            runtime_identity_sha256,
            persistence_identity,
        ) = runtime_identity()
    else:
        (
            runtime_contract,
            runtime_identity_sha256,
            persistence_identity,
        ) = MemoryClient(
            memory.http,
            memory_system_name=memory.memory_system_name,
            answer_handoff=memory.answer_handoff,
        ).runtime_identity()
    expected_document = _new_document(
        task,
        memory,
        chat,
        settings,
        runtime_contract,
        runtime_identity_sha256,
        persistence_identity,
        target_query_ids,
    )
    if settings.resume and settings.output_path.exists():
        document = read_json(settings.output_path)
        has_ingestion_checkpoints = "context_ingestion_users" in document
        _validate_resume_document(document, expected_document, selected_contexts)
        if not has_ingestion_checkpoints:
            _restore_legacy_ingestion_checkpoints(
                document, task, selected_contexts, settings.output_path
            )
            _summarize(document)
            write_json_atomic(settings.output_path, document)
    else:
        document = expected_document
        if settings.reuse_ingestion_from is not None:
            _reuse_ingestion_checkpoints(
                document,
                task,
                selected_contexts,
                settings.reuse_ingestion_from,
            )
    execution = document.setdefault("execution", {})
    history = execution.setdefault("context_slots_history", [])
    if settings.context_slots not in history:
        history.append(settings.context_slots)
    query_history = execution.setdefault("query_slots_history", [])
    if settings.query_slots not in query_history:
        query_history.append(settings.query_slots)
    restored_adaptive = execution.get("adaptive_query_concurrency")
    restored_stages = _adaptive_stage_snapshot(restored_adaptive)
    adaptive_controllers: dict[str, AdaptiveConcurrencyController] = {}
    if adaptive_stage_config is not None:
        if restored_adaptive is not None and restored_stages is None:
            migrations = execution.setdefault(
                "adaptive_query_concurrency_migrations", []
            )
            migrations.append(
                {
                    "from_schema_version": (
                        restored_adaptive.get("schema_version")
                        if isinstance(restored_adaptive, dict)
                        else None
                    ),
                    "to_schema_version": ADAPTIVE_STAGE_SCHEMA_VERSION,
                    "reason": "legacy-or-incompatible-shared-state-reset",
                }
            )
        for stage in ("retrieval", "answer"):
            stage_config = getattr(adaptive_stage_config, stage)
            restored_stage = (
                None if restored_stages is None else restored_stages[stage]
            )
            if (
                restored_stages is not None
                and not AdaptiveConcurrencyController.compatible_snapshot(
                    stage_config,
                    restored_stage,
                )
            ):
                migrations = execution.setdefault(
                    "adaptive_query_concurrency_migrations", []
                )
                migrations.append(
                    {
                        "from_schema_version": ADAPTIVE_STAGE_SCHEMA_VERSION,
                        "to_schema_version": ADAPTIVE_STAGE_SCHEMA_VERSION,
                        "stage": stage,
                        "reason": "incompatible-single-lane-state-reset",
                    }
                )
            adaptive_controllers[stage] = AdaptiveConcurrencyController(
                stage_config,
                restored_stage,
            )
    completed = {row["benchmark_query_id"] for row in document["data"]}
    document_lock = threading.RLock()
    stop_requested = threading.Event()

    def sync_adaptive_state() -> None:
        if adaptive_stage_config is not None:
            execution["adaptive_query_concurrency"] = {
                "schema_version": ADAPTIVE_STAGE_SCHEMA_VERSION,
                "policy": ADAPTIVE_STAGE_POLICY,
                "overall_query_slots": settings.query_slots,
                "stages": {
                    stage: adaptive_controllers[stage].snapshot()
                    for stage in ("retrieval", "answer")
                },
            }

    sync_adaptive_state()

    def persist_locked() -> None:
        sync_adaptive_state()
        _summarize(document)
        write_json_atomic(settings.output_path, document)

    retry_policy = {
        "explicit_ingestion_http": "unbounded",
        "typed_safe_independent_remote": "unbounded",
        "safe_error_codes": ["append_pending", "upstream_unavailable"],
        "safe_http_statuses": [429],
        "maximum_backoff_seconds": 30,
        "answer_untyped_http_statuses": [408, 429, "5xx"],
        "answer_untyped_transport_failure": "checkpoint-and-suite-resume",
        "answer_http_retry_before_checkpoint": 0,
        "answer_untyped_outage_load_control": "aimd-decrease-before-checkpoint",
        "retrieval_untyped_transport_failure": "fail-closed-no-resample",
        "adaptive_query_concurrency": None if adaptive_stage_config is None else {
            "schema_version": ADAPTIVE_STAGE_SCHEMA_VERSION,
            "policy": ADAPTIVE_STAGE_POLICY,
            "overall_query_slots": settings.query_slots,
            "stages": {
                stage: {
                    "minimum": getattr(adaptive_stage_config, stage).minimum,
                    "initial": getattr(adaptive_stage_config, stage).initial,
                    "maximum": getattr(adaptive_stage_config, stage).maximum,
                    "successes_per_increase": getattr(
                        adaptive_stage_config, stage
                    ).successes_per_increase,
                }
                for stage in ("retrieval", "answer")
            },
        },
    }
    retry_history = execution.setdefault("infrastructure_retry_policy_history", [])
    if retry_policy not in retry_history:
        retry_history.append(retry_policy)

    def provider_operation(
        operation: Callable[[], Any],
        stage: str,
    ) -> Any:
        adaptive_controller = adaptive_controllers.get(stage)
        if adaptive_controller is None:
            return operation()
        lease_id = adaptive_controller.acquire(settings.interruption_requested)
        if lease_id is None:
            with document_lock:
                sync_adaptive_state()
                _interrupt_at_checkpoint(document, settings)
            raise RunInterrupted(
                "Benchmark run interrupted while waiting for provider capacity"
            )
        try:
            result = operation()
        except RemoteError as error:
            adaptive_controller.failed(
                lease_id,
                stage,
                retryable=_aimd_congestion_failure(error, stage),
                http_status=error.http_status,
                error_code=error.error_code,
            )
            raise
        except BaseException:
            adaptive_controller.cancelled(lease_id)
            raise
        adaptive_controller.succeeded(lease_id, stage)
        return result

    def retry_ingestion_add(
        operation: Callable[[], None],
        benchmark_query_id: str,
    ) -> None:
        """Retry only server-confirmed, pre-commit-safe append failures forever.

        A transport failure has no HTTP response, so the server may already have
        committed the chunk. That case still exits through the resumable suite
        path rather than risking a duplicate append.
        """
        attempt = 0
        while True:
            try:
                operation()
                return
            except RemoteError as error:
                if not _retryable_infrastructure_failure(error):
                    raise
                attempt += 1
                with document_lock:
                    counts = execution.setdefault("infrastructure_retry_counts", {})
                    counts["ingestion_add"] = counts.get("ingestion_add", 0) + 1
                    _interrupt_at_checkpoint(document, settings)
                    if attempt == 1 or attempt & (attempt - 1) == 0:
                        persist_locked()
                delay = min(2 ** min(attempt - 1, 5), 30)
                delay += random.uniform(0, min(1.0, delay / 4))
                time.sleep(delay)
                with document_lock:
                    _interrupt_at_checkpoint(document, settings)

    def retry_independent_remote(
        operation: Callable[[], Any],
        benchmark_query_id: str,
        stage: str,
    ) -> Any:
        attempt = 0
        while True:
            try:
                return provider_operation(operation, stage)
            except RemoteError as error:
                if not _retryable_infrastructure_failure(error):
                    raise
                attempt += 1
                with document_lock:
                    counts = execution.setdefault("infrastructure_retry_counts", {})
                    key = f"{stage}_independent_query"
                    counts[key] = counts.get(key, 0) + 1
                    _interrupt_at_checkpoint(document, settings)
                    if attempt == 1 or attempt & (attempt - 1) == 0:
                        persist_locked()
                delay = min(2 ** min(attempt - 1, 5), 30)
                delay += random.uniform(0, min(1.0, delay / 4))
                time.sleep(delay)
                with document_lock:
                    _interrupt_at_checkpoint(document, settings)

    def run_independent_queries() -> dict:
        """Run static/ephemeral questions as independent scheduling units."""
        pending_by_query = document.setdefault("pending_by_query", {})
        with document_lock:
            for context_key, pending in list(document["pending_by_context"].items()):
                query_id = pending["benchmark_query_id"]
                if query_id in pending_by_query:
                    raise ValueError("Resume output contains duplicate pending retrievals")
                pending_by_query[query_id] = pending
                del document["pending_by_context"][context_key]
            persist_locked()

        units = [
            (context, query)
            for context, query in target_units
            if _benchmark_query_id(context, query.qa_pair_id) not in completed
        ]
        contexts_needed = {
            context.ordinal: context for context, _query in units
        }
        context_users: dict[int, str] = {}

        def ensure_context(context: Context) -> None:
            context_key = str(context.ordinal)
            user_id = _run_user_id(task, context, settings)
            context_users[context.ordinal] = user_id
            with document_lock:
                memory_ready = (
                    document["context_ingestion_users"].get(context_key) == user_id
                )
                _interrupt_at_checkpoint(document, settings)
            if memory_ready:
                return
            first_query = next(
                query for candidate, query in units
                if candidate.ordinal == context.ordinal
            )
            first_query_id = _benchmark_query_id(context, first_query.qa_pair_id)
            with document_lock:
                timestamps = document["context_ingestion_timestamps"]
                timestamp = timestamps.get(context_key)
                if timestamp is None:
                    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
                    timestamps[context_key] = timestamp
                    persist_locked()
            retry_independent_remote(
                lambda: memory.initialize(user_id),
                first_query_id,
                "initialize",
            )
            for append in _memory_appends(task, context, timestamp, chunker):
                retry_ingestion_add(
                    lambda append=append: _add_memory(memory, user_id, append),
                    first_query_id,
                )
            with document_lock:
                document["context_ingestion_users"][context_key] = user_id
                persist_locked()
                _interrupt_at_checkpoint(document, settings)

        ingestion_errors: list[BaseException] = []
        ingestion_workers = min(
            settings.context_slots,
            max(len(contexts_needed), 1),
        )
        with ThreadPoolExecutor(max_workers=ingestion_workers) as executor:
            futures = [
                executor.submit(ensure_context, context)
                for context in contexts_needed.values()
            ]
            for future in as_completed(futures):
                try:
                    future.result()
                except BaseException as error:
                    ingestion_errors.append(error)
        if ingestion_errors:
            raise ingestion_errors[0]

        def run_query(context: Context, query: Query) -> None:
            benchmark_query_id = _benchmark_query_id(context, query.qa_pair_id)
            formatted_query = task.format_query(query.question)
            started = time.monotonic()
            with document_lock:
                if stop_requested.is_set() or benchmark_query_id in completed:
                    return
                _interrupt_at_checkpoint(document, settings)
                pending = pending_by_query.get(benchmark_query_id)
            if pending is not None:
                wrapped = MemoryWrapResult(
                    prompt=pending["wrapped_prompt"],
                    operator_experiment=pending["operator_experiment"],
                    retrieval_model=pending.get("retrieval_model"),
                )
            else:
                try:
                    wrapped = retry_independent_remote(
                        lambda: memory.wrap(
                            context_users[context.ordinal],
                            formatted_query,
                            question_id=benchmark_query_id,
                            operator_mode=settings.operator_mode,
                            max_search_calls=settings.max_search_calls,
                            evolution_snapshot=None,
                        ),
                        benchmark_query_id,
                        "retrieval",
                    )
                except RemoteError as error:
                    if error.retryable is True:
                        raise
                    with document_lock:
                        failure = _failure_record(
                            document, benchmark_query_id, "retrieval", error
                        )
                        document["data"].append(
                            _outcome_row(
                                task,
                                context,
                                query,
                                benchmark_query_id,
                                formatted_query,
                                "",
                                time.monotonic() - started,
                                None,
                                None,
                                failure,
                            )
                        )
                        completed.add(benchmark_query_id)
                        persist_locked()
                    return
                with document_lock:
                    _validate_retrieval_model_consistency(
                        document, wrapped.retrieval_model
                    )
                    pending_by_query[benchmark_query_id] = {
                        "benchmark_query_id": benchmark_query_id,
                        "context_id": context.ordinal,
                        "wrapped_prompt": wrapped.prompt,
                        "operator_experiment": wrapped.operator_experiment,
                        "retrieval_model": wrapped.retrieval_model,
                        "evolution_snapshot": None,
                    }
                    persist_locked()
                    _interrupt_at_checkpoint(document, settings)
            try:
                prediction = retry_independent_remote(
                    lambda: chat.complete(
                        SYSTEM_PROMPT,
                        wrapped.prompt,
                        task.generation_max_tokens,
                    ),
                    benchmark_query_id,
                    "answer",
                )
            except RemoteError as error:
                if _checkpointable_untyped_answer_failure(error):
                    with document_lock:
                        stop_requested.set()
                        sync_adaptive_state()
                        _pause_for_retryable_failure(
                            document,
                            settings,
                            benchmark_query_id,
                            "answer",
                            error,
                        )
                if error.retryable is True:
                    raise
                with document_lock:
                    failure = _failure_record(
                        document, benchmark_query_id, "answer", error
                    )
                    document["data"].append(
                        _outcome_row(
                            task,
                            context,
                            query,
                            benchmark_query_id,
                            formatted_query,
                            "",
                            time.monotonic() - started,
                            wrapped.operator_experiment,
                            wrapped.retrieval_model,
                            failure,
                        )
                    )
                    pending_by_query.pop(benchmark_query_id, None)
                    completed.add(benchmark_query_id)
                    persist_locked()
                return
            row = _outcome_row(
                task,
                context,
                query,
                benchmark_query_id,
                formatted_query,
                prediction,
                time.monotonic() - started,
                wrapped.operator_experiment,
                wrapped.retrieval_model,
            )
            with document_lock:
                document["data"].append(row)
                pending_by_query.pop(benchmark_query_id, None)
                document.pop("last_retryable_failure", None)
                completed.add(benchmark_query_id)
                persist_locked()
                _interrupt_at_checkpoint(document, settings)

        query_errors: list[BaseException] = []
        workers = min(settings.query_slots, max(len(units), 1))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [
                executor.submit(run_query, context, query)
                for context, query in units
            ]
            for future in as_completed(futures):
                try:
                    future.result()
                except BaseException as error:
                    stop_requested.set()
                    query_errors.append(error)
        if query_errors:
            raise query_errors[0]
        order = {
            _benchmark_query_id(context, query.qa_pair_id): index
            for index, (context, query) in enumerate(
                (context, query)
                for context in contexts
                for query in context.queries
            )
        }
        with document_lock:
            document["data"].sort(key=lambda row: order[row["benchmark_query_id"]])
            persist_locked()
        return document

    if settings.operator_mode != "cumulative" and settings.query_slots > 1:
        return run_independent_queries()

    def run_context(context: Context) -> None:
        pending_queries = [
            query
            for query in context.queries
            if _benchmark_query_id(context, query.qa_pair_id) in target_query_ids
            and _benchmark_query_id(context, query.qa_pair_id) not in completed
        ]
        if not pending_queries:
            return
        user_id = _run_user_id(task, context, settings)
        context_key = str(context.ordinal)
        with document_lock:
            memory_ready = (
                document["context_ingestion_users"].get(context_key) == user_id
            )
            evolution_snapshot: dict[str, Any] | None = document[
                "operator_evolution_states"
            ].get(context_key)
        for query in pending_queries:
            with document_lock:
                if stop_requested.is_set():
                    return
                _interrupt_at_checkpoint(document, settings)
                pending = document["pending_by_context"].get(context_key)
            formatted_query = task.format_query(query.question)
            benchmark_query_id = _benchmark_query_id(context, query.qa_pair_id)
            started = time.monotonic()
            if pending is not None:
                if pending.get("benchmark_query_id") != benchmark_query_id:
                    raise ValueError(
                        "Pending retrieval does not match the next benchmark query"
                    )
                wrapped = MemoryWrapResult(
                    prompt=pending["wrapped_prompt"],
                    operator_experiment=pending["operator_experiment"],
                    retrieval_model=pending.get("retrieval_model"),
                )
                evolution_snapshot = pending.get("evolution_snapshot")
            else:
                if not memory_ready:
                    with document_lock:
                        timestamps = document["context_ingestion_timestamps"]
                        timestamp = timestamps.get(context_key)
                        if timestamp is None:
                            timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
                            timestamps[context_key] = timestamp
                            persist_locked()
                    memory.initialize(user_id)
                    for append in _memory_appends(
                        task, context, timestamp, chunker
                    ):
                        retry_ingestion_add(
                            lambda append=append: _add_memory(
                                memory, user_id, append
                            ),
                            benchmark_query_id,
                        )
                    with document_lock:
                        document["context_ingestion_users"][context_key] = user_id
                        memory_ready = True
                        persist_locked()
                        _interrupt_at_checkpoint(document, settings)
                try:
                    wrapped = provider_operation(
                        lambda: memory.wrap(
                            user_id,
                            formatted_query,
                            question_id=benchmark_query_id,
                            operator_mode=settings.operator_mode,
                            max_search_calls=settings.max_search_calls,
                            evolution_snapshot=(
                                evolution_snapshot
                                if settings.operator_mode == "cumulative"
                                else None
                            ),
                        ),
                        "retrieval",
                    )
                except RemoteError as error:
                    if (
                        error.retryable is True
                        and not _retryable_infrastructure_failure(error)
                    ):
                        raise
                    with document_lock:
                        _interrupt_at_checkpoint(document, settings)
                        if _retryable_infrastructure_failure(error):
                            stop_requested.set()
                            sync_adaptive_state()
                            _pause_for_retryable_failure(
                                document,
                                settings,
                                benchmark_query_id,
                                "retrieval",
                                error,
                            )
                        failure = _failure_record(
                            document,
                            benchmark_query_id,
                            "retrieval",
                            error,
                        )
                        document["data"].append(
                            _outcome_row(
                                task,
                                context,
                                query,
                                benchmark_query_id,
                                formatted_query,
                                "",
                                time.monotonic() - started,
                                None,
                                None,
                                failure,
                            )
                        )
                        completed.add(benchmark_query_id)
                        persist_locked()
                    continue
                experiment = wrapped.operator_experiment or {}
                with document_lock:
                    _validate_retrieval_model_consistency(
                        document, wrapped.retrieval_model
                    )
                    document.pop("last_retryable_failure", None)
                    next_snapshot = experiment.get("evolutionSnapshot")
                    if settings.operator_mode == "cumulative":
                        if not isinstance(next_snapshot, dict):
                            raise ValueError("Cumulative retrieval omitted its next state")
                        evolution_snapshot = next_snapshot
                        document["operator_evolution_states"][context_key] = next_snapshot
                    document["pending_by_context"][context_key] = {
                        "benchmark_query_id": benchmark_query_id,
                        "context_id": context.ordinal,
                        "wrapped_prompt": wrapped.prompt,
                        "operator_experiment": wrapped.operator_experiment,
                        "retrieval_model": wrapped.retrieval_model,
                        "evolution_snapshot": evolution_snapshot,
                    }
                    persist_locked()
                    _interrupt_at_checkpoint(document, settings)
            try:
                prediction = provider_operation(
                    lambda: chat.complete(
                        SYSTEM_PROMPT,
                        wrapped.prompt,
                        task.generation_max_tokens,
                    ),
                    "answer",
                )
            except RemoteError as error:
                if _checkpointable_untyped_answer_failure(error):
                    with document_lock:
                        stop_requested.set()
                        sync_adaptive_state()
                        _pause_for_retryable_failure(
                            document,
                            settings,
                            benchmark_query_id,
                            "answer",
                            error,
                        )
                if (
                    error.retryable is True
                    and not _retryable_infrastructure_failure(error)
                ):
                    raise
                with document_lock:
                    _interrupt_at_checkpoint(document, settings)
                    if _retryable_infrastructure_failure(error):
                        stop_requested.set()
                        sync_adaptive_state()
                        _pause_for_retryable_failure(
                            document,
                            settings,
                            benchmark_query_id,
                            "answer",
                            error,
                        )
                    failure = _failure_record(
                        document,
                        benchmark_query_id,
                        "answer",
                        error,
                    )
                    document["data"].append(
                        _outcome_row(
                            task,
                            context,
                            query,
                            benchmark_query_id,
                            formatted_query,
                            "",
                            time.monotonic() - started,
                            wrapped.operator_experiment,
                            wrapped.retrieval_model,
                            failure,
                        )
                    )
                    document["pending_by_context"].pop(context_key, None)
                    completed.add(benchmark_query_id)
                    persist_locked()
                    _interrupt_at_checkpoint(document, settings)
                continue
            elapsed = time.monotonic() - started
            row = _outcome_row(
                task,
                context,
                query,
                benchmark_query_id,
                formatted_query,
                prediction,
                elapsed,
                wrapped.operator_experiment,
                wrapped.retrieval_model,
            )
            with document_lock:
                document["data"].append(row)
                document["pending_by_context"].pop(context_key, None)
                document.pop("last_retryable_failure", None)
                completed.add(benchmark_query_id)
                persist_locked()
                _interrupt_at_checkpoint(document, settings)

    errors: list[BaseException] = []
    worker_count = min(
        settings.context_slots,
        (
            settings.context_slots
            if adaptive_stage_config is None
            else settings.query_slots
        ),
        max(len(selected_contexts), 1),
    )
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(run_context, context) for context in selected_contexts]
        for future in as_completed(futures):
            try:
                future.result()
            except BaseException as error:
                stop_requested.set()
                errors.append(error)
    if errors:
        raise errors[0]
    order = {
        _benchmark_query_id(context, query.qa_pair_id): index
        for index, (context, query) in enumerate(
            (context, query)
            for context in contexts
            for query in context.queries
        )
    }
    with document_lock:
        document["data"].sort(key=lambda row: order[row["benchmark_query_id"]])
        persist_locked()
    return document
