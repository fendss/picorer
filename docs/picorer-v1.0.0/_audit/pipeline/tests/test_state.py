from __future__ import annotations

import pytest

from question_pipeline.state import PipelineState


def question(value="a"):
    return {
        "id": f"q:{value}",
        "benchmark": "fake",
        "adapter": "tests.fake_adapter:FakeAdapter",
        "payload": {"value": value},
    }


def status(state, question_id, stage):
    with state.connection() as db:
        return db.execute(
            "SELECT status FROM question_stages WHERE question_id=? AND stage=?",
            (question_id, stage),
        ).fetchone()[0]


def test_initialization_and_identity_drift(tmp_path):
    state = PipelineState(tmp_path / "state.sqlite")
    assert state.initialize([question()]) == 1
    assert state.initialize([question()]) == 0
    changed = question()
    changed["payload"] = {"value": "changed"}
    with pytest.raises(ValueError, match="identity drift"):
        state.initialize([changed])
    assert status(state, "q:a", "retrieval") == "ready"
    assert status(state, "q:a", "answer") == "blocked"


def test_stage_completion_releases_only_next_stage(tmp_path):
    state = PipelineState(tmp_path / "state.sqlite")
    state.initialize([question()])
    assert state.queue_one("q:a", "retrieval")
    assert state.claim("q:a", "retrieval", "worker")
    assert state.complete("q:a", "retrieval", "worker", "completed", "r.json", "abc", 1.0) == "answer"
    assert status(state, "q:a", "answer") == "ready"
    assert status(state, "q:a", "evaluation") == "blocked"


def test_retry_budget_is_per_question_stage(tmp_path):
    state = PipelineState(tmp_path / "state.sqlite")
    item = question()
    item["max_attempts"] = {"retrieval": 2}
    state.initialize([item])
    state.queue_one("q:a", "retrieval")
    state.claim("q:a", "retrieval", "worker")
    assert state.fail("q:a", "retrieval", "worker", "temporary", True) == "ready"
    state.queue_one("q:a", "retrieval")
    state.claim("q:a", "retrieval", "worker")
    assert state.fail("q:a", "retrieval", "worker", "temporary", True) == "failed"


def test_seeded_retrieval_releases_answer(tmp_path):
    state = PipelineState(tmp_path / "state.sqlite")
    state.initialize([question()])
    assert state.seed_stage("q:a", "retrieval", "completed", "r.json", "abc", 2.0)
    assert status(state, "q:a", "retrieval") == "completed"
    assert status(state, "q:a", "answer") == "ready"
    assert state.seed_stage("q:a", "retrieval", "completed", "r.json", "abc", 2.0) is False


def test_failed_upstream_makes_pipeline_settled(tmp_path):
    state = PipelineState(tmp_path / "state.sqlite")
    state.initialize([question()])
    state.queue_one("q:a", "retrieval")
    state.claim("q:a", "retrieval", "worker")
    state.fail("q:a", "retrieval", "worker", "method failure", False)
    assert state.settled()
