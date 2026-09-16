#!/usr/bin/env python3
"""Prepare retrieval-only Fact-MH manifests for sufficiency acquisition."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import yaml


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-config", type=Path, required=True)
    parser.add_argument("--baseline-manifest", type=Path, required=True)
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--service-port", type=int, default=3220)
    parser.add_argument("--capture-port", type=int, default=18193)
    parser.add_argument("--canary-size", type=int, default=8)
    parser.add_argument("--j-samples", type=int, default=101)
    parser.add_argument("--max-concurrent-wraps", type=int, default=32)
    parser.add_argument("--run-label", default="qwen36-v100-sufficiency-dynamics")
    parser.add_argument(
        "--generation-upstream", default="https://127.0.0.1:18192/v1"
    )
    parser.add_argument("--ca-bundle", type=Path)
    args = parser.parse_args()

    if not 0 <= args.canary_size <= 100:
        raise ValueError("--canary-size must be between 0 and 100")
    if args.j_samples < 1:
        raise ValueError("--j-samples must be positive")
    if args.max_concurrent_wraps < 1:
        raise ValueError("--max-concurrent-wraps must be positive")

    root = args.experiment_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    for child in (
        "artifacts-canary",
        "artifacts-main",
        "artifacts-full",
        "captures",
        "logs",
        "runtime",
    ):
        (root / child).mkdir(exist_ok=True)

    config = yaml.safe_load(args.baseline_config.read_text(encoding="utf-8"))
    config["paths"]["root"] = str(root)
    config["paths"]["output_dir"] = str(root / "results")
    config["paths"]["runtime_dir"] = str(root / "runtime")
    config["credentials"]["generation"]["base_url"] = (
        f"https://127.0.0.1:{args.capture_port}/v1"
    )
    if args.ca_bundle is not None:
        config["credentials"]["generation"]["ca_bundle"] = str(
            args.ca_bundle.resolve()
        )
    config["service"]["port"] = args.service_port
    config["service"]["max_concurrent_wraps"] = args.max_concurrent_wraps
    config["run"]["tasks"] = ["fact-mh-262k"]
    config["run"]["reuse_ingestion_from"] = {
        "fact-mh-262k": config["run"]["reuse_ingestion_from"]["fact-mh-262k"]
    }
    config["run"]["label"] = args.run_label
    config["run"]["context_slots"] = args.max_concurrent_wraps
    config["run"]["query_slots"] = args.max_concurrent_wraps
    config["run"]["adaptive_query_slots"]["retrieval"] = {
        "minimum": min(8, args.max_concurrent_wraps),
        "initial": min(16, args.max_concurrent_wraps),
        "maximum": args.max_concurrent_wraps,
        "successes_per_increase": 8,
    }
    config_path = root / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )

    baseline_manifest = json.loads(
        args.baseline_manifest.read_text(encoding="utf-8")
    )
    fact_questions = [
        question
        for question in baseline_manifest["questions"]
        if question["payload"].get("task_id") == "fact-mh-262k"
    ]
    if len(fact_questions) != 100:
        raise RuntimeError(f"expected 100 Fact-MH questions, found {len(fact_questions)}")

    rewritten = []
    for question in fact_questions:
        question = json.loads(json.dumps(question))
        question["stages"] = ["retrieval"]
        question["max_attempts"] = {"retrieval": 2}
        question["payload"]["config_path"] = str(config_path)
        rewritten.append(question)

    canary = {"schema_version": baseline_manifest["schema_version"], "questions": rewritten[: args.canary_size]}
    main_shard = {
        "schema_version": baseline_manifest["schema_version"],
        "questions": rewritten[args.canary_size :],
    }
    full = {"schema_version": baseline_manifest["schema_version"], "questions": rewritten}
    canary_path = root / "manifest-canary.json"
    main_path = root / "manifest-main.json"
    full_path = root / "manifest-full.json"
    write_json(canary_path, canary)
    write_json(main_path, main_shard)
    write_json(full_path, full)

    provenance = {
        "schema_version": 1,
        "purpose": "Picorer v1.0.0 sufficiency dynamics acquisition",
        "decision_state_policy": "capture every real retrieval model request",
        "probe_state_policy": "all captured real decision states",
        "j_target_samples_per_state": args.j_samples,
        "dataset": "Fact-MH 262K",
        "question_count": 100,
        "canary_question_count": args.canary_size,
        "main_question_count": len(main_shard["questions"]),
        "acquisition_shards": {
            "canary": (
                f"ordinals 0 through {args.canary_size - 1}"
                if args.canary_size
                else "empty"
            ),
            "main": f"ordinals {args.canary_size} through 99",
        },
        "acquisition_model": "qwen3.6-27b",
        "acquisition_interface_mode": config["service"]["interface_mode"],
        "acquisition_skill": config["service"]["skill"],
        "acquisition_source_identity": config["service"]["source_identity"],
        "capture_proxy": f"https://127.0.0.1:{args.capture_port}",
        "generation_upstream": args.generation_upstream,
        "sampling_note": "temperature/top_p/seed remain omitted exactly as in the v1.0.0 baseline transport",
        "baseline_config": str(args.baseline_config.resolve()),
        "baseline_config_sha256": digest(args.baseline_config),
        "baseline_manifest": str(args.baseline_manifest.resolve()),
        "baseline_manifest_sha256": digest(args.baseline_manifest),
        "generated_config_sha256": digest(config_path),
        "canary_manifest_sha256": digest(canary_path),
        "main_manifest_sha256": digest(main_path),
        "full_manifest_sha256": digest(full_path),
    }
    write_json(root / "experiment.json", provenance)


if __name__ == "__main__":
    main()
