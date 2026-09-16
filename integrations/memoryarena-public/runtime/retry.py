from __future__ import annotations

import email.utils
import errno
import random
import re
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Optional, TypeVar

from .models import FailureClassification, FailureKind


T = TypeVar("T")


_SECRET_PATTERNS = (
    re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"(?i)(api[_-]?key\s*[:=]\s*)[^\s,;]+"),
)


def sanitize_error_message(error: BaseException) -> str:
    message = str(error)
    for pattern in _SECRET_PATTERNS:
        if pattern.pattern.startswith("\\bsk-"):
            message = pattern.sub("sk-[REDACTED]", message)
        else:
            message = pattern.sub(r"\1[REDACTED]", message)
    return message[:4000]


class ProviderRequestError(RuntimeError):
    """Typed provider failure raised by an adapter.

    Adapters should populate structured fields rather than relying on error
    message matching.  ``classify_provider_error`` also supports common SDK
    exception attributes for integration with the official code.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        provider_code: Optional[str] = None,
        retry_after: Optional[str | float] = None,
        stage: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.provider_code = provider_code
        self.retry_after = retry_after
        self.stage = stage
        self.request_id = request_id


class RetryExhaustedError(RuntimeError):
    def __init__(
        self,
        *,
        attempts: int,
        last_error: BaseException,
        classification: FailureClassification,
    ) -> None:
        super().__init__(
            f"transient provider failure remained after {attempts} attempts: "
            f"{sanitize_error_message(last_error)}"
        )
        self.attempts = attempts
        self.last_error = last_error
        self.classification = classification


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 5
    base_delay_seconds: float = 1.0
    max_delay_seconds: float = 60.0
    jitter: bool = True

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be at least one")
        if self.base_delay_seconds < 0 or self.max_delay_seconds < 0:
            raise ValueError("retry delays must be non-negative")
        if self.max_delay_seconds < self.base_delay_seconds:
            raise ValueError("max_delay_seconds must be >= base_delay_seconds")


def _get_attribute(error: BaseException, name: str) -> Any:
    value = getattr(error, name, None)
    if value is not None:
        return value
    response = getattr(error, "response", None)
    if response is not None:
        return getattr(response, name, None)
    return None


def _mapping_provider_code(value: Any) -> Optional[str]:
    if not isinstance(value, Mapping):
        return None
    direct = value.get("code")
    if direct is not None:
        return str(direct)
    error = value.get("error")
    if isinstance(error, Mapping) and error.get("code") is not None:
        return str(error["code"])
    return None


def _provider_code(error: BaseException) -> Optional[str]:
    direct = _get_attribute(error, "provider_code") or _get_attribute(error, "code")
    if direct is not None and not isinstance(direct, Mapping):
        return str(direct)
    for name in ("body", "error"):
        code = _mapping_provider_code(_get_attribute(error, name))
        if code:
            return code
    return None


def parse_retry_after(value: Any, *, now: Optional[datetime] = None) -> Optional[float]:
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(str(value))
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    reference = now or datetime.now(timezone.utc)
    return max(0.0, (parsed - reference).total_seconds())


def _retry_after(error: BaseException) -> Optional[float]:
    direct = _get_attribute(error, "retry_after")
    if direct is not None:
        return parse_retry_after(direct)
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if isinstance(headers, Mapping):
        return parse_retry_after(headers.get("retry-after") or headers.get("Retry-After"))
    headers = _get_attribute(error, "headers")
    if isinstance(headers, Mapping):
        return parse_retry_after(headers.get("retry-after") or headers.get("Retry-After"))
    return None


def classify_provider_error(error: BaseException) -> FailureClassification:
    if isinstance(error, KeyboardInterrupt):
        return FailureClassification(
            kind=FailureKind.INTERRUPTED, retryable=False, blocked=False
        )

    status_value = _get_attribute(error, "status_code") or _get_attribute(error, "status")
    try:
        status = int(status_value) if status_value is not None else None
    except (TypeError, ValueError):
        status = None
    code = _provider_code(error)
    normalized_code = (code or "").strip().lower()
    class_names = {
        cls.__name__.lower() for cls in type(error).__mro__ if cls is not object
    }
    stage = _get_attribute(error, "stage")
    retry_after = _retry_after(error)

    quota_codes = {
        "insufficient_quota",
        "billing_hard_limit_reached",
        "billing_not_active",
        "quota_exhausted",
    }
    if normalized_code in quota_codes:
        return FailureClassification(
            FailureKind.QUOTA_EXHAUSTED,
            retryable=False,
            blocked=True,
            status_code=status,
            provider_code=code,
            retry_after_seconds=retry_after,
            stage=stage,
        )
    if normalized_code in {
        "response_model_mismatch",
        "model_substitution",
        "unexpected_response_model",
    }:
        return FailureClassification(
            FailureKind.RESPONSE_MODEL_MISMATCH,
            retryable=False,
            blocked=True,
            status_code=status,
            provider_code=code,
            stage=stage,
        )
    if normalized_code in {"model_not_found", "unknown_model"} or status == 404:
        return FailureClassification(
            FailureKind.MODEL_NOT_FOUND,
            retryable=False,
            blocked=True,
            status_code=status,
            provider_code=code,
            stage=stage,
        )
    if status in (401, 403):
        return FailureClassification(
            FailureKind.AUTH,
            retryable=False,
            blocked=True,
            status_code=status,
            provider_code=code,
            stage=stage,
        )
    if status in (425, 429):
        return FailureClassification(
            FailureKind.RATE_LIMIT,
            retryable=True,
            blocked=False,
            status_code=status,
            provider_code=code,
            retry_after_seconds=retry_after,
            stage=stage,
        )
    if (
        status == 408
        or isinstance(error, (TimeoutError, socket.timeout))
        or any("timeout" in name for name in class_names)
    ):
        return FailureClassification(
            FailureKind.TIMEOUT,
            retryable=True,
            blocked=False,
            status_code=status,
            provider_code=code,
            retry_after_seconds=retry_after,
            stage=stage,
        )
    if status is not None and 500 <= status <= 599:
        return FailureClassification(
            FailureKind.PROVIDER_5XX,
            retryable=True,
            blocked=False,
            status_code=status,
            provider_code=code,
            retry_after_seconds=retry_after,
            stage=stage,
        )
    transient_errno = getattr(error, "errno", None) in {
        errno.ECONNABORTED,
        errno.ECONNREFUSED,
        errno.ECONNRESET,
        errno.EHOSTUNREACH,
        errno.ENETDOWN,
        errno.ENETUNREACH,
        errno.EPIPE,
        errno.ETIMEDOUT,
    }
    if (
        isinstance(error, (ConnectionError, ConnectionResetError, BrokenPipeError))
        or isinstance(error, socket.gaierror)
        or transient_errno
        or any(
            "connection" in name or "network" in name for name in class_names
        )
    ):
        return FailureClassification(
            FailureKind.NETWORK,
            retryable=True,
            blocked=False,
            status_code=status,
            provider_code=code,
            retry_after_seconds=retry_after,
            stage=stage,
        )
    if status is not None and 400 <= status <= 499:
        return FailureClassification(
            FailureKind.INVALID_REQUEST,
            retryable=False,
            blocked=True,
            status_code=status,
            provider_code=code,
            stage=stage,
        )
    return FailureClassification(
        FailureKind.UNKNOWN,
        retryable=False,
        blocked=True,
        status_code=status,
        provider_code=code,
        stage=stage,
    )


class CircuitBreaker:
    """Small shared breaker that pauses new requests after provider instability."""

    def __init__(self, failure_threshold: int = 4, cooldown_seconds: float = 30.0):
        if failure_threshold < 1 or cooldown_seconds < 0:
            raise ValueError("invalid circuit breaker configuration")
        self.failure_threshold = failure_threshold
        self.cooldown_seconds = cooldown_seconds
        self._failures = 0
        self._open_until = 0.0
        self._lock = threading.Lock()

    def wait_seconds(self, *, now: Optional[float] = None) -> float:
        with self._lock:
            reference = time.monotonic() if now is None else now
            return max(0.0, self._open_until - reference)

    def record_success(self) -> None:
        with self._lock:
            self._failures = 0
            self._open_until = 0.0

    def record_failure(
        self,
        classification: FailureClassification,
        *,
        now: Optional[float] = None,
    ) -> None:
        if not classification.retryable:
            return
        with self._lock:
            self._failures += 1
            if self._failures >= self.failure_threshold:
                reference = time.monotonic() if now is None else now
                provider_delay = classification.retry_after_seconds or 0.0
                self._open_until = max(
                    self._open_until,
                    reference + max(self.cooldown_seconds, provider_delay),
                )


def _abortable_sleep(
    seconds: float,
    *,
    sleep: Callable[[float], None],
    abort_event: Optional[threading.Event],
) -> None:
    if seconds <= 0:
        return
    if abort_event is not None and sleep is time.sleep:
        if abort_event.wait(seconds):
            raise KeyboardInterrupt("retry interrupted")
        return
    if abort_event is not None and abort_event.is_set():
        raise KeyboardInterrupt("retry interrupted")
    sleep(seconds)


def retry_provider_call(
    call: Callable[[], T],
    *,
    policy: RetryPolicy = RetryPolicy(),
    before_attempt: Optional[Callable[[], None]] = None,
    on_failure: Optional[
        Callable[[int, BaseException, FailureClassification, Optional[float]], None]
    ] = None,
    circuit_breaker: Optional[CircuitBreaker] = None,
    sleep: Callable[[float], None] = time.sleep,
    random_value: Callable[[], float] = random.random,
    abort_event: Optional[threading.Event] = None,
) -> T:
    """Run one side-effect-free provider request with bounded transient retry.

    The caller-provided ``before_attempt`` is invoked for every attempt.  A
    shared request gate should be entered there, ensuring retries do not bypass
    concurrency or requests-per-second limits.
    """

    for attempt in range(1, policy.max_attempts + 1):
        if abort_event is not None and abort_event.is_set():
            raise KeyboardInterrupt("provider request interrupted")
        if circuit_breaker is not None:
            _abortable_sleep(
                circuit_breaker.wait_seconds(), sleep=sleep, abort_event=abort_event
            )
        if before_attempt is not None:
            before_attempt()
        try:
            result = call()
        except BaseException as error:
            classification = classify_provider_error(error)
            if circuit_breaker is not None:
                circuit_breaker.record_failure(classification)
            if not classification.retryable:
                raise
            if attempt >= policy.max_attempts:
                if on_failure is not None:
                    on_failure(attempt, error, classification, None)
                raise RetryExhaustedError(
                    attempts=attempt,
                    last_error=error,
                    classification=classification,
                ) from error
            cap = min(
                policy.max_delay_seconds,
                policy.base_delay_seconds * (2 ** (attempt - 1)),
            )
            if classification.retry_after_seconds is not None:
                delay = min(
                    policy.max_delay_seconds, classification.retry_after_seconds
                )
            else:
                delay = cap * random_value() if policy.jitter else cap
            if on_failure is not None:
                on_failure(attempt, error, classification, delay)
            _abortable_sleep(delay, sleep=sleep, abort_event=abort_event)
            continue
        if circuit_breaker is not None:
            circuit_breaker.record_success()
        return result
    raise AssertionError("unreachable")
