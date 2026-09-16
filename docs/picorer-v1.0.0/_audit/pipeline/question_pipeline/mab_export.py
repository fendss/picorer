from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .artifacts import atomic_json, read_json
from .state import PipelineState


def export(state_path: Path, output_dir: Path) -> dict[str, int]:
    state = PipelineState(state_path)
    by_task: dict[str, list[dict[str, Any]]] = defaultdict(list)
    with state.connection() as db:
        rows = db.execute(
            """SELECT q.id, q.ordinal, q.payload,
            r.artifact_path AS retrieval_path,
            a.artifact_path AS answer_path,
            e.artifact_path AS evaluation_path,
            e.status AS evaluation_status,
            r.duration_seconds AS retrieval_seconds,
            a.duration_seconds AS answer_seconds
            FROM questions q
            JOIN question_stages r ON r.question_id=q.id AND r.stage='retrieval'
            JOIN question_stages a ON a.question_id=q.id AND a.stage='answer'
            JOIN question_stages e ON e.question_id=q.id AND e.stage='evaluation'
            WHERE a.status='completed'
              AND q.adapter LIKE '%MemoryAgentBenchAdapter'
            ORDER BY q.ordinal"""
        ).fetchall()
    for row in rows:
        payload = json.loads(row["payload"])
        retrieval = read_json(Path(row["retrieval_path"]))["output"]
        answer = read_json(Path(row["answer_path"]))["output"]
        metrics = {}
        if row["evaluation_path"]:
            metrics = read_json(Path(row["evaluation_path"]))["output"].get("metrics", {})
        by_task[payload["task_id"]].append({
            "context_id": payload["context_id"],
            "benchmark_query_id": payload["benchmark_query_id"],
            "qa_pair_id": payload["qa_pair_id"],
            "question_id": payload.get("question_id"),
            "question_type": payload.get("question_type"),
            "query": retrieval["formatted_query"],
            "output": answer["prediction"],
            "answer": payload["answers"],
            "metrics": metrics,
            "evaluation_status": row["evaluation_status"],
            "query_time_seconds": (
                float(row["retrieval_seconds"] or 0)
                + float(row["answer_seconds"] or 0)
            ),
            "operator_experiment": retrieval.get("operator_experiment"),
            "retrieval_model": retrieval.get("retrieval_model"),
            **({"keypoints": payload["keypoints"]} if payload.get("keypoints") else {}),
        })
    counts = {}
    for task_id, data in by_task.items():
        metric_names = {name for row in data for name in row["metrics"]}
        metrics = {}
        for name in metric_names:
            values = [row["metrics"].get(name) for row in data]
            usable = [value for value in values if value is not None]
            metrics[name] = sum(usable) / len(usable) if usable else None
        target = output_dir / f"{task_id}-static.json"
        evaluation_statuses = Counter(row["evaluation_status"] for row in data)
        atomic_json(target, {
            "schema_version": 2,
            "benchmark": "MemoryAgentBench",
            "task": task_id,
            "completed_queries": len(data),
            "evaluated_queries": sum(bool(row["metrics"]) for row in data),
            "evaluation_statuses": dict(sorted(evaluation_statuses.items())),
            "metrics": metrics,
            "data": data,
        })
        counts[task_id] = len(data)
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(export(args.state, args.output_dir), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
