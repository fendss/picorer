from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import yaml

from .artifacts import atomic_json
from .eval_config import bind as bind_eval_config

EXTERNAL_JUDGE_TASKS = {"longmemeval-s", "infbench-sum"}


def _result_path(config: dict[str, Any], task_id: str) -> Path:
    output = Path(config["paths"]["output_dir"])
    return output / str(config["run"]["label"]) / f"{task_id}-static.json"


def _load_users(config: dict[str, Any], task_id: str) -> dict[str, str]:
    candidates = [
        _result_path(config, task_id),
        Path(config["paths"]["root"]) / "pipeline-ingestion" / f"{task_id}.json",
    ]
    reused = config["run"].get("reuse_ingestion_from", {}).get(task_id)
    if reused:
        candidates.append(Path(reused))
    for candidate in candidates:
        if not candidate.is_file():
            continue
        value = json.loads(candidate.read_text())
        users = value.get("context_ingestion_users")
        if isinstance(users, dict) and users:
            return {str(key): str(user) for key, user in users.items()}
    raise ValueError(f"{task_id} has no reusable context ingestion checkpoint")


def build(
    config_paths: list[Path],
    adapter_root: Path,
    limit: int | None = None,
    selected_tasks: set[str] | None = None,
    eval_config_path: Path | None = None,
) -> dict:
    if str(adapter_root) not in sys.path:
        sys.path.insert(0, str(adapter_root))
    from mab_adapter.config import task_config
    from mab_adapter.dataset import load_contexts

    questions: list[dict[str, Any]] = []
    ordinal = 0
    for config_path in config_paths:
        config = yaml.safe_load(config_path.read_text())
        for task_id in config["run"]["tasks"]:
            if selected_tasks is not None and task_id not in selected_tasks:
                continue
            task = task_config(task_id)
            eval_binding = (
                None
                if eval_config_path is None
                else bind_eval_config(
                    eval_config_path, f"agentmemorybench/{task_id}"
                )
            )
            contexts = load_contexts(Path(config["paths"]["data_dir"]), task)
            users = _load_users(config, task_id)
            for context in contexts:
                user_id = users.get(str(context.ordinal))
                if not user_id:
                    raise ValueError(
                        f"{task_id} context {context.ordinal} is not ingested"
                    )
                for query in context.queries:
                    benchmark_query_id = f"context-{context.ordinal}/{query.qa_pair_id}"
                    global_id = f"agentmemorybench:{task_id}:{benchmark_query_id}"
                    questions.append({
                        "id": global_id,
                        "benchmark": f"AgentMemoryBench {task_id}",
                        "adapter": (
                            "question_pipeline.adapters.memoryagentbench:"
                            "MemoryAgentBenchAdapter"
                        ),
                        "ordinal": ordinal,
                        "stages": ["retrieval", "answer", "evaluation"],
                        "max_attempts": {
                            "retrieval": 2,
                            "answer": 3,
                            "evaluation": 3 if eval_binding is not None else 1,
                        },
                        "payload": {
                            "adapter_root": str(adapter_root),
                            "config_path": str(config_path),
                            "data_dir": str(config["paths"]["data_dir"]),
                            "task_id": task_id,
                            "context_id": context.ordinal,
                            "user_id": user_id,
                            "benchmark_query_id": benchmark_query_id,
                            "qa_pair_id": query.qa_pair_id,
                            "question_id": query.question_id,
                            "question_type": query.question_type,
                            "question": query.question,
                            "answers": list(query.answers),
                            "keypoints": list(query.keypoints),
                            "operator_mode": "static",
                            "max_search_calls": int(config["run"]["max_search_calls"]),
                            "external_judge": task_id in EXTERNAL_JUDGE_TASKS,
                        },
                    })
                    if eval_binding is not None:
                        questions[-1]["payload"]["eval_config"] = eval_binding
                    ordinal += 1
                    if limit is not None and len(questions) >= limit:
                        return {"schema_version": 2, "questions": questions}
    return {"schema_version": 2, "questions": questions}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, action="append", required=True)
    parser.add_argument("--adapter-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--task", action="append")
    parser.add_argument("--eval-config", type=Path)
    args = parser.parse_args(argv)
    manifest = build(
        args.config, args.adapter_root, args.limit,
        None if not args.task else set(args.task),
        args.eval_config,
    )
    atomic_json(args.output, manifest)
    print(json.dumps({"questions": len(manifest["questions"]), "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
