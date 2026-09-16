from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from .artifacts import atomic_json, read_json
from .state import PipelineState


def export(state_path: Path, output_dir: Path) -> dict[str, int]:
    state = PipelineState(state_path)
    beam_search: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    beam_answers: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    locomo_search: dict[str, list[dict[str, Any]]] = defaultdict(list)
    locomo_answers: dict[str, list[dict[str, Any]]] = defaultdict(list)
    with state.connection() as db:
        rows = db.execute(
            """SELECT q.payload, q.ordinal,
            r.status AS retrieval_status, r.artifact_path AS retrieval_path,
            a.status AS answer_status, a.artifact_path AS answer_path
            FROM questions q
            JOIN question_stages r ON r.question_id=q.id AND r.stage='retrieval'
            JOIN question_stages a ON a.question_id=q.id AND a.stage='answer'
            WHERE q.adapter LIKE '%OmniMemEvalAdapter'
            ORDER BY q.ordinal"""
        ).fetchall()
    counts = {"beam_search": 0, "beam_answer": 0, "locomo_search": 0, "locomo_answer": 0}
    for row in rows:
        payload = json.loads(row["payload"])
        search_record = None
        if row["retrieval_status"] == "completed" and row["retrieval_path"]:
            search_record = read_json(Path(row["retrieval_path"]))["output"]["search_record"]
        answer_record = None
        if row["answer_status"] == "completed" and row["answer_path"]:
            answer_record = read_json(Path(row["answer_path"]))["output"]["response_record"]
        if payload["suite"] == "beam":
            scale = payload["scale"]
            user_id = payload["user_id"]
            if search_record is not None:
                beam_search[scale][user_id].append(search_record)
                counts["beam_search"] += 1
            if answer_record is not None:
                beam_answers[scale][user_id].append(answer_record)
                counts["beam_answer"] += 1
        else:
            group_id = f"locomo_exp_user_{payload['group_index']}"
            if search_record is not None:
                locomo_search[group_id].append(search_record)
                counts["locomo_search"] += 1
            if answer_record is not None:
                locomo_answers[group_id].append(answer_record)
                counts["locomo_answer"] += 1
    for scale, records in beam_search.items():
        root = output_dir / f"beam-{scale}"
        atomic_json(root / "picorer_beam_search_results.json", records)
        atomic_json(root / "picorer_beam_responses.json", beam_answers[scale])
    if locomo_search:
        root = output_dir / "locomo"
        atomic_json(root / "picorer_locomo_search_results.json", locomo_search)
        atomic_json(root / "picorer_locomo_responses.json", locomo_answers)
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

