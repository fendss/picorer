from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from .artifacts import atomic_json, canonical_json, safe_component
from .state import PipelineState


def _write_seed(
    state: PipelineState,
    artifacts: Path,
    question_id: str,
    benchmark: str,
    adapter: str,
    stage: str,
    output: dict[str, Any],
    duration: float | None,
    status: str = "completed",
) -> bool:
    value = {
        "schema_version": 1,
        "question_id": question_id,
        "benchmark": benchmark,
        "adapter": adapter,
        "stage": stage,
        "attempt": 0,
        "duration_seconds": duration,
        "seeded_from_prior_run": True,
        "output": output,
    }
    path = artifacts / safe_component(question_id) / f"{stage}.json"
    atomic_json(path, value)
    digest = hashlib.sha256(canonical_json(value)).hexdigest()
    return state.seed_stage(
        question_id, stage, status, str(path), digest, duration,
    )


def migrate(
    state_path: Path,
    manifest_path: Path,
    source_root: Path,
    artifacts: Path,
    adapter_root: Path,
) -> dict[str, int]:
    if str(adapter_root) not in sys.path:
        sys.path.insert(0, str(adapter_root))
    from mab_adapter.config import task_config

    manifest = json.loads(manifest_path.read_text())
    state = PipelineState(state_path)
    state.initialize(manifest["questions"])
    indexed = {question["id"]: question for question in manifest["questions"]}
    counts = {"retrieval": 0, "answer": 0, "evaluation": 0, "pending": 0}
    for source in sorted(source_root.rglob("*-static.json")):
        try:
            document = json.loads(source.read_text())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        task_id = document.get("task")
        if not isinstance(task_id, str):
            continue
        try:
            task = task_config(task_id)
        except (KeyError, ValueError):
            continue
        for benchmark_query_id, pending in document.get("pending_by_query", {}).items():
            question_id = f"agentmemorybench:{task_id}:{benchmark_query_id}"
            item = indexed.get(question_id)
            if item is None:
                continue
            payload = item["payload"]
            if _write_seed(
                state, artifacts, question_id, item["benchmark"], item["adapter"],
                "retrieval",
                {
                    "formatted_query": task.format_query(payload["question"]),
                    "wrapped_prompt": pending["wrapped_prompt"],
                    "operator_experiment": pending.get("operator_experiment"),
                    "retrieval_model": pending.get("retrieval_model"),
                },
                None,
            ):
                counts["retrieval"] += 1
                counts["pending"] += 1
        for row in document.get("data", []):
            benchmark_query_id = row.get("benchmark_query_id")
            if not benchmark_query_id or row.get("failure"):
                continue
            question_id = f"agentmemorybench:{task_id}:{benchmark_query_id}"
            item = indexed.get(question_id)
            if item is None:
                continue
            if _write_seed(
                state, artifacts, question_id, item["benchmark"], item["adapter"],
                "retrieval",
                {
                    "formatted_query": row.get("query") or task.format_query(item["payload"]["question"]),
                    "operator_experiment": row.get("operator_experiment"),
                    "retrieval_model": row.get("retrieval_model"),
                    "wrapped_prompt_unavailable": True,
                },
                None,
            ):
                counts["retrieval"] += 1
            if _write_seed(
                state, artifacts, question_id, item["benchmark"], item["adapter"],
                "answer", {"prediction": row.get("output", "")},
                row.get("query_time_seconds"),
            ):
                counts["answer"] += 1
            metrics = row.get("metrics") or {}
            evaluation_status = (
                "waiting_external"
                if item["payload"].get("external_judge")
                else "completed"
            )
            if _write_seed(
                state, artifacts, question_id, item["benchmark"], item["adapter"],
                "evaluation",
                (
                    {
                        "reason": "benchmark requires an external LLM judge",
                        "prior_metrics": metrics,
                    }
                    if evaluation_status == "waiting_external"
                    else {"metrics": metrics}
                ),
                None,
                evaluation_status,
            ):
                counts["evaluation"] += 1
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--adapter-root", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(migrate(
        args.state, args.manifest, args.source_root, args.artifacts,
        args.adapter_root,
    ), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
