#!/usr/bin/env python3
"""Requeue only terminal answer failures caused by infrastructure timeouts."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

from question_pipeline.state import PipelineState
from question_pipeline.transport import RedisTransport


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--redis-url", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--expected-failures", type=int, required=True)
    parser.add_argument("--audit-output", type=Path, required=True)
    args = parser.parse_args()

    state = PipelineState(args.state)
    recovered: list[dict[str, object]] = []
    with state.connection() as database:
        database.execute("BEGIN IMMEDIATE")
        rows = database.execute(
            """SELECT question_id, attempt, max_attempts, error
            FROM question_stages
            WHERE stage='answer' AND status='failed'
            ORDER BY question_id"""
        ).fetchall()
        if len(rows) != args.expected_failures:
            raise RuntimeError(
                f"expected {args.expected_failures} failed answers, found {len(rows)}"
            )
        for row in rows:
            error = str(row["error"] or "")
            if "timed out" not in error and "TimeoutError" not in error:
                raise RuntimeError(
                    f"refusing to requeue non-timeout failure: {row['question_id']}"
                )
            recovered.append(
                {
                    "question_id": row["question_id"],
                    "previous_attempt": row["attempt"],
                    "max_attempts": row["max_attempts"],
                    "previous_error_sha256": hashlib.sha256(error.encode()).hexdigest(),
                }
            )
            database.execute(
                """UPDATE question_stages
                SET status='ready', attempt=0, queued_at=NULL, started_at=NULL,
                    heartbeat_at=NULL, finished_at=NULL, worker=NULL,
                    artifact_path=NULL, artifact_sha256=NULL, duration_seconds=NULL
                WHERE question_id=? AND stage='answer' AND status='failed'""",
                (row["question_id"],),
            )
            database.execute(
                """INSERT INTO events(at, question_id, stage, event, detail)
                VALUES (?, ?, 'answer', 'manual_infrastructure_retry', ?)""",
                (
                    time.time(),
                    row["question_id"],
                    json.dumps(
                        {
                            "reason": "read timeout under model queue saturation",
                            "previous_attempt": row["attempt"],
                            "previous_error_sha256": recovered[-1][
                                "previous_error_sha256"
                            ],
                        },
                        sort_keys=True,
                    ),
                ),
            )

    transport = RedisTransport(args.redis_url, args.namespace)
    queued = state.queue_ready("answer")
    for question_id, stage in queued:
        transport.ensure_group(stage)
        transport.enqueue(question_id, stage)
    if len(queued) != len(recovered):
        raise RuntimeError(
            f"requeued {len(queued)} stages after recovering {len(recovered)} failures"
        )
    audit = {
        "schema_version": 1,
        "at": time.time(),
        "state": str(args.state.resolve()),
        "namespace": args.namespace,
        "reason": "recover answer-only infrastructure timeouts after model queue drained",
        "recovered": recovered,
        "queued": [question_id for question_id, _ in queued],
        "counts": state.counts(),
    }
    args.audit_output.parent.mkdir(parents=True, exist_ok=True)
    args.audit_output.write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(audit, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
