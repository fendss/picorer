#!/usr/bin/env python3
"""Materialize one fixed-denominator ReFind comparison run.

Successful Picorer predictions are preserved verbatim. Terminal method failures
are represented by an empty response so the unchanged judge scores them wrong.
Infrastructure/provider failures fail closed and must be resumed instead.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any


INFRASTRUCTURE_FAILURE = re.compile(
    r"(?:HTTP\s+(?:408|425|429|5\d\d)|status code\s+(?:408|425|429|5\d\d)|"
    r"API error\s*\((?:401|403|408|425|429|5\d\d)\)|rate limit|"
    r"fetch failed|ECONN|ETIMEDOUT|invalid_encrypted_content)",
    re.IGNORECASE,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number} must contain an object")
        records.append(value)
    return records


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--failure-records", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    questions = read_jsonl(args.questions)
    predictions = read_jsonl(args.predictions)
    ordered_ids = [item.get("questionId") for item in questions]
    if any(not isinstance(question_id, str) for question_id in ordered_ids):
        raise ValueError("Every private question must have a string questionId")
    if len(set(ordered_ids)) != len(ordered_ids):
        raise ValueError("Private question IDs must be unique")

    prediction_by_id: dict[str, dict[str, Any]] = {}
    for prediction in predictions:
        question_id = prediction.get("question_id")
        if not isinstance(question_id, str) or question_id in prediction_by_id:
            raise ValueError("Prediction question IDs must be unique strings")
        prediction_by_id[question_id] = prediction

    failure_by_id: dict[str, tuple[dict[str, Any], Path]] = {}
    for path in sorted(args.failure_records.glob("*.json")):
        failure = json.loads(path.read_text(encoding="utf-8"))
        question_id = failure.get("question_id")
        if not isinstance(question_id, str) or question_id in failure_by_id:
            raise ValueError("Failure question IDs must be unique strings")
        failure_by_id[question_id] = (failure, path)

    expected = set(ordered_ids)
    unknown = (set(prediction_by_id) | set(failure_by_id)) - expected
    if unknown:
        raise ValueError(f"Unknown question IDs: {sorted(unknown)}")

    materialized: list[dict[str, Any]] = []
    terminal_failures: list[dict[str, str]] = []
    for question_id in ordered_ids:
        prediction = prediction_by_id.get(question_id)
        if prediction is not None:
            materialized.append(prediction)
            continue
        failure_pair = failure_by_id.get(question_id)
        if failure_pair is None:
            raise ValueError(f"Question has neither prediction nor failure: {question_id}")
        failure, failure_path = failure_pair
        error = failure.get("error")
        if not isinstance(error, str):
            raise ValueError(f"Failure has no string error: {question_id}")
        if INFRASTRUCTURE_FAILURE.search(error):
            raise ValueError(
                f"Infrastructure failure must be resumed, not scored: {question_id}"
            )
        materialized.append(
            {
                "question_id": question_id,
                "response": "",
                "abstention": False,
                "retrieval_status": "terminal_method_failure",
                "citations": [],
            }
        )
        terminal_failures.append(
            {
                "question_id": question_id,
                "failure_record_sha256": sha256(failure_path),
            }
        )

    serialized = "".join(
        json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n"
        for item in materialized
    )
    atomic_write(args.output, serialized)
    manifest_path = args.output.with_suffix(args.output.suffix + ".manifest.json")
    manifest = {
        "schema_version": 1,
        "question_count": len(ordered_ids),
        "success_count": len(prediction_by_id),
        "terminal_method_failure_count": len(terminal_failures),
        "question_file_sha256": sha256(args.questions),
        "source_predictions_sha256": sha256(args.predictions),
        "output_sha256": sha256(args.output),
        "terminal_method_failures": terminal_failures,
    }
    atomic_write(
        manifest_path,
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
