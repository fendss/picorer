from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict, deque
from pathlib import Path

from .artifacts import atomic_json


def combine(manifests: list[dict], expected: int | None = None) -> dict:
    questions = []
    for value in manifests:
        if value.get("schema_version") != 2:
            raise ValueError("unsupported manifest schema")
        questions.extend(value["questions"])
    ids = [question["id"] for question in questions]
    duplicates = [key for key, count in Counter(ids).items() if count > 1]
    if duplicates:
        raise ValueError(f"duplicate question ids: {duplicates[:10]}")
    if expected is not None and len(questions) != expected:
        raise ValueError(
            f"expected {expected} questions, found {len(questions)}"
        )
    grouped = defaultdict(list)
    for question in questions:
        grouped[question["benchmark"]].append(question)
    lanes = [
        deque(sorted(values, key=lambda question: (question["ordinal"], question["id"])))
        for _benchmark, values in sorted(grouped.items())
    ]
    interleaved = []
    while lanes:
        remaining = []
        for lane in lanes:
            interleaved.append(lane.popleft())
            if lane:
                remaining.append(lane)
        lanes = remaining
    for ordinal, question in enumerate(interleaved):
        question["ordinal"] = ordinal
    return {"schema_version": 2, "questions": interleaved}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected", type=int)
    args = parser.parse_args(argv)
    manifest = combine(
        [json.loads(path.read_text()) for path in args.input], args.expected,
    )
    atomic_json(args.output, manifest)
    print(json.dumps({
        "questions": len(manifest["questions"]),
        "benchmarks": dict(sorted(Counter(
            question["benchmark"] for question in manifest["questions"]
        ).items())),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
