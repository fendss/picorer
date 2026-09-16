from __future__ import annotations

import contextlib
import json
import sqlite3
import statistics
import time
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

from .contracts import STAGES


def now() -> float:
    return time.time()


class PipelineState:
    """Authoritative state for question and stage leases.

    Redis messages are disposable notifications. Every transition is guarded by
    the current SQLite status, so duplicate or stale stream messages are safe.
    """

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS questions (
                    id TEXT PRIMARY KEY,
                    benchmark TEXT NOT NULL,
                    adapter TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    payload_sha256 TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS question_stages (
                    question_id TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL,
                    queued_at REAL,
                    started_at REAL,
                    heartbeat_at REAL,
                    finished_at REAL,
                    worker TEXT,
                    error TEXT,
                    artifact_path TEXT,
                    artifact_sha256 TEXT,
                    duration_seconds REAL,
                    PRIMARY KEY (question_id, stage),
                    FOREIGN KEY (question_id) REFERENCES questions(id)
                );
                CREATE INDEX IF NOT EXISTS stages_status_stage
                    ON question_stages(status, stage);
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    at REAL NOT NULL,
                    question_id TEXT,
                    stage TEXT,
                    event TEXT NOT NULL,
                    detail TEXT
                );
                """
            )

    @contextlib.contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=30000")
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def initialize(self, questions: Sequence[Mapping[str, Any]]) -> int:
        from .artifacts import sha256_json

        inserted = 0
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            for ordinal, question in enumerate(questions):
                question_id = str(question["id"])
                payload = dict(question["payload"])
                payload_text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
                payload_sha = sha256_json(payload)
                existing = db.execute(
                    "SELECT benchmark, adapter, payload_sha256 FROM questions WHERE id=?",
                    (question_id,),
                ).fetchone()
                if existing is not None:
                    if (
                        existing["benchmark"] != question["benchmark"]
                        or existing["adapter"] != question["adapter"]
                        or existing["payload_sha256"] != payload_sha
                    ):
                        raise ValueError(f"question identity drift: {question_id}")
                    db.execute(
                        "UPDATE questions SET ordinal=? WHERE id=?",
                        (int(question.get("ordinal", ordinal)), question_id),
                    )
                    continue
                db.execute(
                    """INSERT INTO questions
                    (id, benchmark, adapter, ordinal, payload, payload_sha256, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        question_id,
                        str(question["benchmark"]),
                        str(question["adapter"]),
                        int(question.get("ordinal", ordinal)),
                        payload_text,
                        payload_sha,
                        now(),
                    ),
                )
                attempts = question.get("max_attempts", {})
                for stage_index, stage in enumerate(STAGES):
                    enabled = stage in question.get("stages", STAGES)
                    status = "blocked" if enabled else "skipped"
                    if stage_index == 0 and enabled:
                        status = "ready"
                    db.execute(
                        """INSERT INTO question_stages
                        (question_id, stage, status, max_attempts, finished_at)
                        VALUES (?, ?, ?, ?, ?)""",
                        (
                            question_id,
                            stage,
                            status,
                            int(attempts.get(stage, 3 if stage != "evaluation" else 2)),
                            now() if status == "skipped" else None,
                        ),
                    )
                inserted += 1
            db.execute(
                "INSERT INTO events(at, event, detail) VALUES (?, 'initialized', ?)",
                (now(), json.dumps({"inserted": inserted})),
            )
        return inserted

    def queue_ready(self, stage: str | None = None) -> list[tuple[str, str]]:
        where = "s.status='ready'"
        parameters: list[Any] = []
        if stage is not None:
            where += " AND s.stage=?"
            parameters.append(stage)
        queued: list[tuple[str, str]] = []
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                f"""SELECT s.question_id, s.stage FROM question_stages s
                JOIN questions q ON q.id=s.question_id WHERE {where}
                ORDER BY q.ordinal, s.stage""",
                parameters,
            ).fetchall()
            timestamp = now()
            for row in rows:
                changed = db.execute(
                    """UPDATE question_stages SET status='queued', queued_at=?, error=NULL
                    WHERE question_id=? AND stage=? AND status='ready'""",
                    (timestamp, row["question_id"], row["stage"]),
                ).rowcount
                if changed:
                    queued.append((row["question_id"], row["stage"]))
                    db.execute(
                        """INSERT INTO events(at, question_id, stage, event)
                        VALUES (?, ?, ?, 'queued')""",
                        (timestamp, row["question_id"], row["stage"]),
                    )
        return queued

    def queue_one(self, question_id: str, stage: str) -> bool:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            timestamp = now()
            changed = db.execute(
                """UPDATE question_stages SET status='queued', queued_at=?, error=NULL
                WHERE question_id=? AND stage=? AND status='ready'""",
                (timestamp, question_id, stage),
            ).rowcount
            if changed:
                db.execute(
                    """INSERT INTO events(at, question_id, stage, event)
                    VALUES (?, ?, ?, 'queued')""",
                    (timestamp, question_id, stage),
                )
            return bool(changed)

    def queued(self, stage: str) -> list[str]:
        with self.connection() as db:
            return [
                row["question_id"]
                for row in db.execute(
                    """SELECT s.question_id FROM question_stages s
                    JOIN questions q ON q.id=s.question_id
                    WHERE s.stage=? AND s.status='queued' ORDER BY q.ordinal""",
                    (stage,),
                )
            ]

    def claim(self, question_id: str, stage: str, worker: str) -> dict[str, Any] | None:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            timestamp = now()
            changed = db.execute(
                """UPDATE question_stages SET status='running', attempt=attempt+1,
                started_at=?, heartbeat_at=?, worker=?, finished_at=NULL, error=NULL
                WHERE question_id=? AND stage=? AND status='queued'""",
                (timestamp, timestamp, worker, question_id, stage),
            ).rowcount
            if not changed:
                return None
            row = db.execute(
                """SELECT q.*, s.attempt, s.max_attempts
                FROM questions q JOIN question_stages s ON s.question_id=q.id
                WHERE q.id=? AND s.stage=?""",
                (question_id, stage),
            ).fetchone()
            db.execute(
                """INSERT INTO events(at, question_id, stage, event, detail)
                VALUES (?, ?, ?, 'started', ?)""",
                (timestamp, question_id, stage, json.dumps({"worker": worker, "attempt": row["attempt"]})),
            )
            result = dict(row)
            result["payload"] = json.loads(result["payload"])
            return result

    def heartbeat(self, question_id: str, stage: str, worker: str) -> None:
        with self.connection() as db:
            db.execute(
                """UPDATE question_stages SET heartbeat_at=?
                WHERE question_id=? AND stage=? AND status='running' AND worker=?""",
                (now(), question_id, stage, worker),
            )

    def complete(
        self,
        question_id: str,
        stage: str,
        worker: str,
        status: str,
        artifact_path: str,
        artifact_sha256: str,
        duration_seconds: float,
    ) -> str | None:
        if status not in {"completed", "waiting_external", "skipped"}:
            raise ValueError(status)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            timestamp = now()
            changed = db.execute(
                """UPDATE question_stages SET status=?, finished_at=?, worker=NULL,
                artifact_path=?, artifact_sha256=?, duration_seconds=?
                WHERE question_id=? AND stage=? AND status='running' AND worker=?""",
                (
                    status, timestamp, artifact_path, artifact_sha256,
                    duration_seconds, question_id, stage, worker,
                ),
            ).rowcount
            if not changed:
                raise RuntimeError(f"lost stage lease: {question_id} {stage}")
            db.execute(
                """INSERT INTO events(at, question_id, stage, event)
                VALUES (?, ?, ?, ?)""",
                (timestamp, question_id, stage, status),
            )
            if status != "completed":
                return None
            index = STAGES.index(stage)
            for next_stage in STAGES[index + 1:]:
                row = db.execute(
                    "SELECT status FROM question_stages WHERE question_id=? AND stage=?",
                    (question_id, next_stage),
                ).fetchone()
                if row is None or row["status"] == "skipped":
                    continue
                changed = db.execute(
                    """UPDATE question_stages SET status='ready'
                    WHERE question_id=? AND stage=? AND status='blocked'""",
                    (question_id, next_stage),
                ).rowcount
                return next_stage if changed else None
            return None

    def seed_stage(
        self,
        question_id: str,
        stage: str,
        status: str,
        artifact_path: str,
        artifact_sha256: str,
        duration_seconds: float | None,
    ) -> bool:
        """Import a completed immutable artifact from a prior compatible run."""
        if status not in {"completed", "waiting_external", "skipped"}:
            raise ValueError(status)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """SELECT status, artifact_sha256 FROM question_stages
                WHERE question_id=? AND stage=?""",
                (question_id, stage),
            ).fetchone()
            if row is None:
                raise KeyError((question_id, stage))
            if row["status"] in {"completed", "waiting_external", "skipped"}:
                if row["artifact_sha256"] == artifact_sha256:
                    return False
                raise ValueError(f"seed artifact drift: {question_id} {stage}")
            timestamp = now()
            db.execute(
                """UPDATE question_stages SET status=?, finished_at=?, worker=NULL,
                artifact_path=?, artifact_sha256=?, duration_seconds=?, error=NULL
                WHERE question_id=? AND stage=?""",
                (
                    status, timestamp, artifact_path, artifact_sha256,
                    duration_seconds, question_id, stage,
                ),
            )
            db.execute(
                """INSERT INTO events(at, question_id, stage, event, detail)
                VALUES (?, ?, ?, 'seeded', ?)""",
                (timestamp, question_id, stage, json.dumps({"status": status})),
            )
            if status == "completed":
                index = STAGES.index(stage)
                for next_stage in STAGES[index + 1:]:
                    next_row = db.execute(
                        """SELECT status FROM question_stages
                        WHERE question_id=? AND stage=?""",
                        (question_id, next_stage),
                    ).fetchone()
                    if next_row is None or next_row["status"] == "skipped":
                        continue
                    db.execute(
                        """UPDATE question_stages SET status='ready'
                        WHERE question_id=? AND stage=? AND status='blocked'""",
                        (question_id, next_stage),
                    )
                    break
            return True

    def fail(
        self,
        question_id: str,
        stage: str,
        worker: str,
        error: str,
        retryable: bool,
    ) -> str:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """SELECT attempt, max_attempts FROM question_stages
                WHERE question_id=? AND stage=? AND status='running' AND worker=?""",
                (question_id, stage, worker),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"lost stage lease: {question_id} {stage}")
            status = "ready" if retryable and row["attempt"] < row["max_attempts"] else "failed"
            timestamp = now()
            db.execute(
                """UPDATE question_stages SET status=?, finished_at=?, worker=NULL, error=?
                WHERE question_id=? AND stage=?""",
                (status, timestamp, error[-8000:], question_id, stage),
            )
            db.execute(
                """INSERT INTO events(at, question_id, stage, event, detail)
                VALUES (?, ?, ?, ?, ?)""",
                (timestamp, question_id, stage, "retry" if status == "ready" else "failed", error[-2000:]),
            )
            return status

    def recover_stale(self, stale_seconds: float, stage: str | None = None) -> int:
        cutoff = now() - stale_seconds
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            stage_filter = ""
            parameters: list[Any] = [cutoff]
            if stage is not None:
                stage_filter = " AND stage=?"
                parameters.append(stage)
            rows = db.execute(
                """SELECT question_id, stage FROM question_stages
                WHERE status='running' AND heartbeat_at<?""" + stage_filter,
                parameters,
            ).fetchall()
            for row in rows:
                db.execute(
                    """UPDATE question_stages SET status='ready', worker=NULL,
                    error='stale lease recovered' WHERE question_id=? AND stage=?""",
                    (row["question_id"], row["stage"]),
                )
                db.execute(
                    """INSERT INTO events(at, question_id, stage, event)
                    VALUES (?, ?, ?, 'stale_recovered')""",
                    (now(), row["question_id"], row["stage"]),
                )
            return len(rows)

    def artifacts(self, question_id: str, before_stage: str) -> dict[str, str]:
        limit = STAGES.index(before_stage)
        wanted = STAGES[:limit]
        if not wanted:
            return {}
        placeholders = ",".join("?" for _ in wanted)
        with self.connection() as db:
            rows = db.execute(
                f"""SELECT stage, artifact_path FROM question_stages
                WHERE question_id=? AND stage IN ({placeholders}) AND status='completed'""",
                (question_id, *wanted),
            ).fetchall()
        return {row["stage"]: row["artifact_path"] for row in rows}

    def counts(self) -> list[dict[str, Any]]:
        with self.connection() as db:
            return [dict(row) for row in db.execute(
                """SELECT stage, status, COUNT(*) AS count
                FROM question_stages GROUP BY stage, status ORDER BY stage, status"""
            )]

    def snapshot(self) -> dict[str, Any]:
        timestamp = now()
        with self.connection() as db:
            counts = [dict(row) for row in db.execute(
                """SELECT stage, status, COUNT(*) AS count
                FROM question_stages GROUP BY stage, status ORDER BY stage, status"""
            )]
            active = [dict(row) for row in db.execute(
                """SELECT question_id, stage, status, attempt, queued_at,
                started_at, heartbeat_at, worker
                FROM question_stages
                WHERE status IN ('ready','queued','running')
                ORDER BY COALESCE(started_at, queued_at, 0) LIMIT 20"""
            )]
            duration_rows = db.execute(
                """SELECT stage, duration_seconds FROM question_stages
                WHERE duration_seconds IS NOT NULL AND status IN ('completed','waiting_external')"""
            ).fetchall()
            recent = {
                row["stage"]: row["count"]
                for row in db.execute(
                    """SELECT stage, COUNT(*) AS count FROM question_stages
                    WHERE finished_at>=? AND status IN ('completed','waiting_external')
                    GROUP BY stage""",
                    (timestamp - 300,),
                )
            }
        durations: dict[str, list[float]] = {stage: [] for stage in STAGES}
        for row in duration_rows:
            durations[row["stage"]].append(float(row["duration_seconds"]))
        timing = {}
        for stage, values in durations.items():
            if not values:
                continue
            ordered = sorted(values)
            timing[stage] = {
                "count": len(values),
                "mean_seconds": statistics.fmean(values),
                "p50_seconds": statistics.median(values),
                "p95_seconds": ordered[min(int(len(ordered) * 0.95), len(ordered) - 1)],
            }
        for row in active:
            anchor = row["started_at"] or row["queued_at"]
            row["age_seconds"] = None if anchor is None else timestamp - anchor
        return {
            "at": timestamp,
            "settled": self.settled(),
            "counts": counts,
            "completed_last_5m": recent,
            "timing": timing,
            "active_oldest": active,
        }

    def backlog(self, stage: str) -> int:
        with self.connection() as db:
            row = db.execute(
                """SELECT COUNT(*) AS n FROM question_stages
                WHERE stage=? AND status IN ('ready','queued','running')""",
                (stage,),
            ).fetchone()
            return int(row["n"])

    def settled(self) -> bool:
        with self.connection() as db:
            active = db.execute(
                """SELECT COUNT(*) AS n FROM question_stages
                WHERE status IN ('ready','queued','running')"""
            ).fetchone()["n"]
            if active:
                return False
            # A blocked stage is expected only when an earlier stage failed or
            # was deliberately left for an external judge.
            invalid = db.execute(
                """SELECT COUNT(*) AS n
                FROM question_stages current
                WHERE current.status='blocked'
                  AND NOT EXISTS (
                    SELECT 1 FROM question_stages prior
                    WHERE prior.question_id=current.question_id
                      AND CASE prior.stage
                        WHEN 'retrieval' THEN 0 WHEN 'answer' THEN 1 ELSE 2 END
                        < CASE current.stage
                        WHEN 'retrieval' THEN 0 WHEN 'answer' THEN 1 ELSE 2 END
                      AND prior.status IN ('failed','waiting_external','skipped')
                  )"""
            ).fetchone()["n"]
            return invalid == 0

    def checkpoint(self) -> None:
        with self.connection() as db:
            db.execute("PRAGMA wal_checkpoint(FULL)")
