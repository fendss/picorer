from __future__ import annotations

from typing import ClassVar

from question_pipeline.contracts import RetryableStageError, StageResult


class FakeAdapter:
    attempts: ClassVar[dict[tuple[str, str], int]] = {}

    def run(self, stage, payload, prior):
        key = (payload["value"], stage)
        self.attempts[key] = self.attempts.get(key, 0) + 1
        if payload.get("retry_once") == stage and self.attempts[key] == 1:
            raise RetryableStageError("temporary")
        if stage == "retrieval":
            return StageResult({"evidence": f"evidence:{payload['value']}"})
        if stage == "answer":
            assert prior["retrieval"]["evidence"] == f"evidence:{payload['value']}"
            return StageResult({"answer": f"answer:{payload['value']}"})
        assert prior["answer"]["answer"] == f"answer:{payload['value']}"
        if payload.get("external"):
            return StageResult({"reason": "judge offline"}, "waiting_external")
        return StageResult({"score": 1})
