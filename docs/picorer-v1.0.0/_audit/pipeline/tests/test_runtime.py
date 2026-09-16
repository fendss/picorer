from __future__ import annotations

import sys
from pathlib import Path

from question_pipeline.adapters import load_adapter
from question_pipeline.runtime import Worker
from question_pipeline.state import PipelineState


class FakeTransport:
    def __init__(self):
        self.enqueued = []
        self.acked = []

    def enqueue(self, question_id, stage):
        self.enqueued.append((question_id, stage))

    def acknowledge(self, stage, message_id):
        self.acked.append((stage, message_id))


def manifest_item(value="a", **payload):
    return {
        "id": f"q:{value}",
        "benchmark": "fake",
        "adapter": "tests.fake_adapter:FakeAdapter",
        "payload": {"value": value, **payload},
    }


def run_stage(state, transport, artifacts, question_id, stage, message):
    worker = Worker(state, transport, stage, artifacts, 1, 60)
    worker._process(message, question_id)


def test_question_flows_before_other_retrieval_finishes(tmp_path):
    sys.path.insert(0, str(Path(__file__).parent.parent))
    load_adapter.cache_clear()
    state = PipelineState(tmp_path / "state.sqlite")
    state.initialize([manifest_item("a"), manifest_item("b")])
    for question_id, stage in state.queue_ready("retrieval"):
        assert stage == "retrieval"
    transport = FakeTransport()

    run_stage(state, transport, tmp_path / "artifacts", "q:a", "retrieval", "m1")
    assert ("q:a", "answer") in transport.enqueued
    with state.connection() as db:
        second = db.execute(
            "SELECT status FROM question_stages WHERE question_id='q:b' AND stage='retrieval'"
        ).fetchone()[0]
    assert second == "queued"

    run_stage(state, transport, tmp_path / "artifacts", "q:a", "answer", "m2")
    assert ("q:a", "evaluation") in transport.enqueued
    run_stage(state, transport, tmp_path / "artifacts", "q:a", "evaluation", "m3")
    assert len(list((tmp_path / "artifacts").rglob("*.json"))) == 3


def test_retry_does_not_restart_prior_stage(tmp_path):
    sys.path.insert(0, str(Path(__file__).parent.parent))
    load_adapter.cache_clear()
    state = PipelineState(tmp_path / "state.sqlite")
    state.initialize([manifest_item("retry", retry_once="answer")])
    state.queue_ready("retrieval")
    transport = FakeTransport()
    run_stage(state, transport, tmp_path / "artifacts", "q:retry", "retrieval", "m1")
    run_stage(state, transport, tmp_path / "artifacts", "q:retry", "answer", "m2")
    with state.connection() as db:
        statuses = dict(db.execute(
            "SELECT stage, status FROM question_stages WHERE question_id='q:retry'"
        ).fetchall())
    assert statuses["retrieval"] == "completed"
    assert statuses["answer"] == "queued"


def test_worker_periodically_recovers_stale_stage(tmp_path):
    state = PipelineState(tmp_path / "state.sqlite")
    state.initialize([manifest_item("stale")])
    state.queue_ready("retrieval")
    assert state.claim("q:stale", "retrieval", "dead-worker") is not None
    with state.connection() as db:
        db.execute(
            "UPDATE question_stages SET heartbeat_at=0 "
            "WHERE question_id='q:stale' AND stage='retrieval'"
        )
    transport = FakeTransport()
    worker = Worker(state, transport, "retrieval", tmp_path / "artifacts", 1, 1)
    worker._recover_and_emit_ready()
    assert transport.enqueued == [("q:stale", "retrieval")]
    with state.connection() as db:
        status = db.execute(
            "SELECT status FROM question_stages "
            "WHERE question_id='q:stale' AND stage='retrieval'"
        ).fetchone()[0]
    assert status == "queued"
