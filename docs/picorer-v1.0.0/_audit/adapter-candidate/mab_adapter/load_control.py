from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class AdaptiveConcurrencyConfig:
    """A small AIMD policy for one provider request lane."""

    minimum: int
    initial: int
    maximum: int
    successes_per_increase: int = 8

    def __post_init__(self) -> None:
        if self.minimum < 1:
            raise ValueError("adaptive concurrency minimum must be positive")
        if not self.minimum <= self.initial <= self.maximum:
            raise ValueError(
                "adaptive concurrency must satisfy minimum <= initial <= maximum"
            )
        if self.successes_per_increase < 1:
            raise ValueError("successes_per_increase must be positive")


@dataclass(frozen=True)
class AdaptiveStageConcurrencyConfig:
    """Independent AIMD policies for retrieval and answer requests."""

    retrieval: AdaptiveConcurrencyConfig
    answer: AdaptiveConcurrencyConfig


class AdaptiveConcurrencyController:
    """Thread-safe additive-increase/multiplicative-decrease admission.

    A lease covers one complete retrieval wrap or answer request. Retryable
    provider failures halve the current limit; sustained successes add one
    slot. Existing requests are never cancelled when the limit falls.
    """

    SCHEMA_VERSION = 2

    def __init__(
        self,
        config: AdaptiveConcurrencyConfig,
        restored: dict[str, Any] | None = None,
    ) -> None:
        self.config = config
        self._condition = threading.Condition()
        self._in_flight = 0
        self._current = config.initial
        self._peak_limit = config.initial
        self._peak_in_flight = 0
        self._success_streak = 0
        self._successful_operations = 0
        self._retryable_failures = 0
        self._coalesced_retryable_failures = 0
        self._congestion_epoch = 0
        self._next_lease_id = 1
        self._lease_epochs: dict[int, int] = {}
        self._changes: list[dict[str, Any]] = []
        if self.compatible_snapshot(config, restored):
            assert restored is not None
            self._current = int(restored["current_limit"])
            self._peak_limit = max(
                self._current,
                int(restored.get("peak_limit", self._current)),
            )
            self._peak_in_flight = int(restored.get("peak_in_flight", 0))
            self._success_streak = int(restored.get("success_streak", 0))
            self._successful_operations = int(
                restored.get("successful_operations", 0)
            )
            self._retryable_failures = int(restored.get("retryable_failures", 0))
            self._coalesced_retryable_failures = int(
                restored.get("coalesced_retryable_failures", 0)
            )
            changes = restored.get("changes")
            if isinstance(changes, list):
                self._changes = [dict(change) for change in changes if isinstance(change, dict)]

    @classmethod
    def compatible_snapshot(
        cls,
        config: AdaptiveConcurrencyConfig,
        value: dict[str, Any] | None,
    ) -> bool:
        return isinstance(value, dict) and all(
            value.get(field) == expected
            for field, expected in (
                ("schema_version", cls.SCHEMA_VERSION),
                ("minimum", config.minimum),
                ("initial", config.initial),
                ("maximum", config.maximum),
                (
                    "successes_per_increase",
                    config.successes_per_increase,
                ),
            )
        ) and isinstance(value.get("current_limit"), int) and (
            config.minimum
            <= int(value["current_limit"])
            <= config.maximum
        )

    def acquire(self, cancelled: Callable[[], bool] | None = None) -> int | None:
        with self._condition:
            while self._in_flight >= self._current:
                if cancelled is not None and cancelled():
                    return None
                self._condition.wait(timeout=0.25)
            if cancelled is not None and cancelled():
                return None
            lease_id = self._next_lease_id
            self._next_lease_id += 1
            self._lease_epochs[lease_id] = self._congestion_epoch
            self._in_flight += 1
            self._peak_in_flight = max(self._peak_in_flight, self._in_flight)
            return lease_id

    def succeeded(self, lease_id: int, stage: str) -> None:
        with self._condition:
            self._release_one(lease_id)
            self._successful_operations += 1
            self._success_streak += 1
            if (
                self._success_streak >= self.config.successes_per_increase
                and self._current < self.config.maximum
            ):
                previous = self._current
                self._current += 1
                self._peak_limit = max(self._peak_limit, self._current)
                self._success_streak = 0
                self._record_change(previous, self._current, "sustained_success", stage)
            self._condition.notify_all()

    def failed(
        self,
        lease_id: int,
        stage: str,
        *,
        retryable: bool,
        http_status: int | None = None,
        error_code: str | None = None,
    ) -> None:
        with self._condition:
            lease_epoch = self._release_one(lease_id)
            if retryable:
                self._retryable_failures += 1
                self._success_streak = 0
                if lease_epoch == self._congestion_epoch:
                    previous = self._current
                    self._current = max(self.config.minimum, self._current // 2)
                    if self._current != previous:
                        self._congestion_epoch += 1
                        self._record_change(
                            previous,
                            self._current,
                            "retryable_failure",
                            stage,
                            http_status=http_status,
                            error_code=error_code,
                        )
                else:
                    # Concurrent failures from leases admitted before the same
                    # congestion signal describe one overload wave. Counting
                    # each of them as a fresh signal would collapse N -> 1.
                    self._coalesced_retryable_failures += 1
            self._condition.notify_all()

    def cancelled(self, lease_id: int) -> None:
        """Release a lease after a non-provider exception or cancellation."""
        with self._condition:
            self._release_one(lease_id)
            self._condition.notify_all()

    def _release_one(self, lease_id: int) -> int:
        if self._in_flight < 1:
            raise RuntimeError("adaptive concurrency lease was not acquired")
        try:
            lease_epoch = self._lease_epochs.pop(lease_id)
        except KeyError as error:
            raise RuntimeError("adaptive concurrency lease is not active") from error
        self._in_flight -= 1
        return lease_epoch

    def _record_change(
        self,
        previous: int,
        current: int,
        reason: str,
        stage: str,
        *,
        http_status: int | None = None,
        error_code: str | None = None,
    ) -> None:
        self._changes.append(
            {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "previous_limit": previous,
                "current_limit": current,
                "reason": reason,
                "stage": stage,
                **({"http_status": http_status} if http_status is not None else {}),
                **({"error_code": error_code} if error_code is not None else {}),
            }
        )

    def snapshot(self) -> dict[str, Any]:
        with self._condition:
            return {
                "schema_version": self.SCHEMA_VERSION,
                "minimum": self.config.minimum,
                "initial": self.config.initial,
                "maximum": self.config.maximum,
                "successes_per_increase": self.config.successes_per_increase,
                "current_limit": self._current,
                "peak_limit": self._peak_limit,
                "in_flight": self._in_flight,
                "peak_in_flight": self._peak_in_flight,
                "success_streak": self._success_streak,
                "successful_operations": self._successful_operations,
                "retryable_failures": self._retryable_failures,
                "coalesced_retryable_failures": (
                    self._coalesced_retryable_failures
                ),
                "changes": [dict(change) for change in self._changes],
            }
