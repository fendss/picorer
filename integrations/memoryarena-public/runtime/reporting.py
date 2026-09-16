from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, Mapping

from .artifacts import (
    canonical_sha256,
    file_sha256,
    read_json,
    utc_now,
    write_json_atomic,
)

if TYPE_CHECKING:
    from .artifacts import ArtifactStore


_FAILED_ATTEMPT_STATUSES = {"failed-retryable", "blocked"}


def _coverage_status(payload: Mapping[str, Any]) -> str:
    explicit = str(payload.get("status", "")).casefold()
    if explicit in {"complete", "partial", "unknown"}:
        return explicit
    if payload.get("gaps"):
        return "partial"

    statuses: list[str] = []
    for value in payload.values():
        if not isinstance(value, str):
            continue
        normalized = value.casefold()
        if "unknown" in normalized or "missing" in normalized:
            statuses.append("unknown")
        elif "partial" in normalized:
            statuses.append("partial")
        elif "observed" in normalized or "complete" in normalized or "not called" in normalized:
            statuses.append("complete")
    if not statuses:
        return "unknown"
    if all(status == "complete" for status in statuses):
        return "complete"
    if all(status == "unknown" for status in statuses):
        return "unknown"
    return "partial"


def _summarize_coverage(observations: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = [str(item["status"]) for item in observations]
    if not statuses:
        status = "unobserved"
    elif all(item == "complete" for item in statuses):
        status = "complete"
    elif all(item == "unknown" for item in statuses):
        status = "unknown"
    else:
        status = "partial"
    return {
        "status": status,
        "observation_count": len(observations),
        "complete_observations": sum(item == "complete" for item in statuses),
        "partial_observations": sum(item == "partial" for item in statuses),
        "unknown_observations": sum(item == "unknown" for item in statuses),
        "observations": observations,
    }


def summarize_usage(store: "ArtifactStore") -> dict[str, Any]:
    accepted_attempts = {
        record["accepted_attempt_id"]
        for path in store.records_dir.glob("*.json")
        for record in (read_json(path),)
    }
    buckets: dict[str, dict[str, Any]] = {}
    task_domains: dict[str, str] = {}
    if store.task_manifest_path.exists():
        task_manifest = read_json(store.task_manifest_path)
        task_domains = {
            str(task["task_key"]): str(task["domain"])
            for task in task_manifest.get("tasks", [])
            if isinstance(task, Mapping)
            and task.get("task_key") is not None
            and task.get("domain") is not None
        }

    def add(bucket_name: str, event: Mapping[str, Any]) -> None:
        usage = event["usage"]
        bucket = buckets.setdefault(
            bucket_name,
            {
                "events": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cached_input_tokens": 0,
                "cache_write_tokens": 0,
                "reasoning_tokens": 0,
                "total_tokens": 0,
                "known_cost_usd": 0.0,
                "estimated_cost_usd": 0.0,
                "provider_reported_cost_usd": 0.0,
                "other_known_cost_usd": 0.0,
                "unknown_cost_events": 0,
                "by_stage": {},
                "by_model": {},
                "by_domain": {},
                "by_task": {},
            },
        )
        bucket["events"] += 1
        for key in (
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "cache_write_tokens",
            "reasoning_tokens",
        ):
            bucket[key] += int(usage.get(key, 0))
        tokens = int(
            usage.get("effective_total_tokens", usage.get("total_tokens", 0))
        )
        bucket["total_tokens"] += tokens
        if usage.get("cost_usd") is None:
            bucket["unknown_cost_events"] += 1
        else:
            cost = float(usage["cost_usd"])
            bucket["known_cost_usd"] += cost
            price_source = str(usage.get("price_source") or "")
            if price_source.startswith("price-table:"):
                bucket["estimated_cost_usd"] += cost
            elif price_source == "provider-reported":
                bucket["provider_reported_cost_usd"] += cost
            else:
                bucket["other_known_cost_usd"] += cost
        stage = str(event.get("stage") or "unknown")
        model = str(
            event.get("response_model")
            or event.get("requested_model")
            or "unknown"
        )
        bucket["by_stage"][stage] = bucket["by_stage"].get(stage, 0) + tokens
        bucket["by_model"][model] = bucket["by_model"].get(model, 0) + tokens
        task_key = str(event.get("task_key") or "unscoped")
        domain = task_domains.get(task_key, "unscoped")
        bucket["by_domain"][domain] = bucket["by_domain"].get(domain, 0) + tokens
        bucket["by_task"][task_key] = bucket["by_task"].get(task_key, 0) + tokens

    events_path = store.usage_dir / "events.jsonl"
    usage_attempt_ids: set[str] = set()
    if events_path.exists():
        with events_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                event = json.loads(line)
                if isinstance(event.get("attempt_id"), str):
                    usage_attempt_ids.add(event["attempt_id"])
                disposition = event.get("disposition_hint") or (
                    "accepted_evaluation"
                    if event.get("attempt_id") in accepted_attempts
                    else "retry_overhead"
                )
                add(disposition, event)
                add("all_billed", event)
    for bucket in buckets.values():
        unknown = int(bucket["unknown_cost_events"])
        if unknown == 0:
            bucket["cost_status"] = "complete"
        elif unknown == int(bucket["events"]):
            bucket["cost_status"] = "unknown"
        else:
            bucket["cost_status"] = "partial"

    coverage_observations: dict[str, list[dict[str, Any]]] = {
        "accepted_evaluation": [],
        "retry_overhead": [],
    }
    for attempt_path in sorted(store.attempts_dir.glob("*/*/attempt.json")):
        attempt = read_json(attempt_path)
        attempt_id = str(attempt.get("attempt_id") or attempt_path.parent.name)
        task_key = str(attempt.get("task_key") or "unknown")
        disposition = (
            "accepted_evaluation"
            if attempt_id in accepted_attempts
            else "retry_overhead"
        )
        trajectory_path = attempt_path.parent / "trajectory.jsonl"
        if trajectory_path.exists():
            with trajectory_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    if event.get("kind") != "usage-coverage":
                        continue
                    payload = event.get("payload")
                    if not isinstance(payload, Mapping):
                        payload = {}
                    observation = {
                        "source": "trajectory",
                        "task_key": task_key,
                        "attempt_id": attempt_id,
                        "domain": str(attempt.get("domain") or task_domains.get(task_key, "unknown")),
                        "component": str(event.get("component") or "unknown"),
                        "status": _coverage_status(payload),
                        "details": dict(payload),
                    }
                    coverage_observations[disposition].append(observation)
        if (
            attempt.get("status") in _FAILED_ATTEMPT_STATUSES
            and attempt_id not in usage_attempt_ids
        ):
            coverage_observations[disposition].append(
                {
                    "source": "failed-attempt-without-usage",
                    "task_key": task_key,
                    "attempt_id": attempt_id,
                    "domain": str(attempt.get("domain") or task_domains.get(task_key, "unknown")),
                    "component": "task-supervisor",
                    "status": "unknown",
                    "details": {
                        "attempt_status": attempt.get("status"),
                        "failure": attempt.get("failure"),
                        "reason": "failed attempt emitted no normalized usage event",
                    },
                }
            )
    all_observations = [
        *coverage_observations["accepted_evaluation"],
        *coverage_observations["retry_overhead"],
    ]
    coverage = {
        "accepted_evaluation": _summarize_coverage(
            coverage_observations["accepted_evaluation"]
        ),
        "retry_overhead": _summarize_coverage(
            coverage_observations["retry_overhead"]
        ),
        "all_billed": _summarize_coverage(all_observations),
    }
    for name, bucket in buckets.items():
        bucket["coverage_status"] = coverage[name]["status"]
    summary = {
        "schema_version": 1,
        "run_id": store.run_id,
        "generated_at": utc_now(),
        "buckets": buckets,
        "coverage": coverage,
        "coverage_status": coverage["all_billed"]["status"],
    }
    write_json_atomic(store.usage_dir / "summary.json", summary)
    return summary


def _jsonl_count(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open("rb") as handle:
        return sum(1 for line in handle if line.strip())


def _index_document(value: Mapping[str, Any]) -> dict[str, Any]:
    body = dict(value)
    body.pop("index_sha256", None)
    body["index_sha256"] = canonical_sha256(body)
    return body


def generate_indexes(store: "ArtifactStore") -> dict[str, Any]:
    run_manifest, task_manifest = store.load_manifests()
    task_entries: list[dict[str, Any]] = []
    trajectory_entries: list[dict[str, Any]] = []
    for raw_task in task_manifest.get("tasks", []):
        task_key = str(raw_task["task_key"])
        record_path = store.record_path(task_key)
        attempts = store.list_attempts(task_key)
        task_entries.append(
            {
                "task_key": task_key,
                "domain": raw_task["domain"],
                "source_record_hash": raw_task["source_record_hash"],
                "record": (
                    {
                        "path": str(record_path.relative_to(store.run_dir)),
                        "sha256": file_sha256(record_path),
                    }
                    if record_path.exists()
                    else None
                ),
                "attempt_ids": [attempt["attempt_id"] for attempt in attempts],
            }
        )
        accepted = store.load_success(task_key)
        accepted_id = accepted.get("accepted_attempt_id") if accepted else None
        for attempt in attempts:
            attempt_dir = Path(attempt["_attempt_dir"])
            attempt_path = attempt_dir / "attempt.json"
            trajectory_path = attempt_dir / "trajectory.jsonl"
            trajectory_entries.append(
                {
                    "task_key": task_key,
                    "attempt_id": attempt["attempt_id"],
                    "status": attempt["status"],
                    "accepted": attempt["attempt_id"] == accepted_id,
                    "attempt": {
                        "path": str(attempt_path.relative_to(store.run_dir)),
                        "sha256": file_sha256(attempt_path),
                    },
                    "trajectory": (
                        {
                            "path": str(trajectory_path.relative_to(store.run_dir)),
                            "sha256": file_sha256(trajectory_path),
                            "events": _jsonl_count(trajectory_path),
                        }
                        if trajectory_path.exists()
                        else None
                    ),
                }
            )

    judge_entries: list[dict[str, Any]] = []
    for path in sorted(store.judge_cache_dir.glob("*.json")):
        value = read_json(path)
        cache_key = value.get("cache_key")
        if (
            path.stem != cache_key
            or canonical_sha256(value.get("key_payload")) != cache_key
            or value.get("status") != "succeeded"
            or value.get("parse_valid") is not True
        ):
            raise ValueError(f"invalid judge cache entry: {path}")
        judge_entries.append(
            {
                "cache_key": cache_key,
                "path": str(path.relative_to(store.run_dir)),
                "sha256": file_sha256(path),
                "model": value.get("response_model"),
                "usage": value.get("usage"),
            }
        )

    events_path = store.usage_dir / "events.jsonl"
    summary_path = store.usage_dir / "summary.json"
    usage_summary = summarize_usage(store)
    index_documents = {
        "tasks": _index_document(
            {
                "schema_version": 1,
                "generated_at": utc_now(),
                "task_manifest_sha256": task_manifest["manifest_sha256"],
                "expected_tasks": len(task_entries),
                "tasks": task_entries,
            }
        ),
        "trajectories": _index_document(
            {
                "schema_version": 1,
                "generated_at": utc_now(),
                "attempts": len(trajectory_entries),
                "trajectories": trajectory_entries,
            }
        ),
        "judge-cache": _index_document(
            {
                "schema_version": 1,
                "generated_at": utc_now(),
                "entries": len(judge_entries),
                "judge_cache": judge_entries,
            }
        ),
        "usage-cost": _index_document(
            {
                "schema_version": 1,
                "generated_at": utc_now(),
                "events": {
                    "path": str(events_path.relative_to(store.run_dir)),
                    "sha256": file_sha256(events_path) if events_path.exists() else None,
                    "count": _jsonl_count(events_path),
                },
                "summary": {
                    "path": str(summary_path.relative_to(store.run_dir)),
                    "sha256": file_sha256(summary_path),
                    "buckets": usage_summary["buckets"],
                },
            }
        ),
    }
    for name, document in index_documents.items():
        write_json_atomic(store.indexes_dir / f"{name}.json", document)
    root_index = _index_document(
        {
            "schema_version": 1,
            "generated_at": utc_now(),
            "run_id": store.run_id,
            "run_manifest_sha256": run_manifest["manifest_sha256"],
            "task_manifest_sha256": task_manifest["manifest_sha256"],
            "indexes": {
                name: {
                    "path": f"indexes/{name}.json",
                    "sha256": file_sha256(store.indexes_dir / f"{name}.json"),
                }
                for name in index_documents
            },
        }
    )
    write_json_atomic(store.indexes_dir / "artifacts.json", root_index)
    return root_index
