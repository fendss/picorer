from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

STAGES = ("retrieval", "answer", "evaluation")
TERMINAL_STATUSES = {"completed", "failed", "waiting_external", "skipped"}


class RetryableStageError(RuntimeError):
    """A transport failure for which repeating this stage is semantically safe."""


@dataclass(frozen=True)
class StageResult:
    output: Mapping[str, Any]
    status: str = "completed"

    def __post_init__(self) -> None:
        if self.status not in {"completed", "waiting_external", "skipped"}:
            raise ValueError(f"invalid successful stage status: {self.status}")


class QuestionAdapter(Protocol):
    def run(
        self,
        stage: str,
        payload: Mapping[str, Any],
        prior: Mapping[str, Mapping[str, Any]],
    ) -> StageResult: ...
