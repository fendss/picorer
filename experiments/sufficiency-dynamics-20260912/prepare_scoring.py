#!/usr/bin/env python3
"""Prepare answer/evaluation state while reusing frozen retrieval artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import yaml

from question_pipeline.artifacts import atomic_json, canonical_json
from question_pipeline.state import PipelineState


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def retrieval_index(roots: list[Path]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for root in roots:
        for path in sorted(root.glob("*/retrieval.json")):
            artifact = read_json(path)
            question_id = str(artifact["question_id"])
            if artifact.get("stage") != "retrieval":
                raise ValueError(f"not a retrieval artifact: {path}")
            if question_id in result:
                raise ValueError(f"duplicate retrieval artifact: {question_id}")
            result[question_id] = path.resolve()
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-manifest", type=Path, required=True)
    parser.add_argument("--source-config", type=Path, required=True)
    parser.add_argument("--scoring-config", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--retrieval-artifacts", type=Path, action="append", required=True)
    parser.add_argument("--generation-base-url", required=True)
    parser.add_argument("--ca-bundle", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    config = yaml.safe_load(args.source_config.read_text(encoding="utf-8"))
    config["credentials"]["generation"]["base_url"] = args.generation_base_url
    config["credentials"]["generation"]["ca_bundle"] = str(args.ca_bundle.resolve())
    config["run"]["label"] = "qwen36-v100-sufficiency-dynamics-scoring"
    args.scoring_config.parent.mkdir(parents=True, exist_ok=True)
    args.scoring_config.write_text(
        yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )

    source = read_json(args.source_manifest)
    questions = list(source["questions"])
    if args.limit is not None:
        questions = questions[: args.limit]
    for question in questions:
        question["stages"] = ["retrieval", "answer", "evaluation"]
        question["max_attempts"] = {
            "retrieval": 2,
            "answer": 3,
            "evaluation": 1,
        }
        question["payload"]["config_path"] = str(args.scoring_config.resolve())
    manifest = {"schema_version": 2, "questions": questions}
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(args.manifest, manifest)

    indexed = retrieval_index(args.retrieval_artifacts)
    expected_ids = {str(question["id"]) for question in questions}
    missing = sorted(expected_ids - set(indexed))
    if missing:
        raise ValueError(f"missing retrieval artifacts: {missing[:10]}")

    state = PipelineState(args.state)
    inserted = state.initialize(questions)
    seeded = 0
    for question in questions:
        question_id = str(question["id"])
        path = indexed[question_id]
        artifact = read_json(path)
        digest = hashlib.sha256(canonical_json(artifact)).hexdigest()
        if state.seed_stage(
            question_id,
            "retrieval",
            "completed",
            str(path),
            digest,
            artifact.get("duration_seconds"),
        ):
            seeded += 1
    print(
        json.dumps(
            {
                "questions": len(questions),
                "inserted": inserted,
                "retrieval_seeded": seeded,
                "counts": state.counts(),
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
