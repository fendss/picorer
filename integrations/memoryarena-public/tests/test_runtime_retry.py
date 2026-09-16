from __future__ import annotations

import sys
import socket
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.models import FailureKind  # noqa: E402
from runtime.retry import (  # noqa: E402
    CircuitBreaker,
    ProviderRequestError,
    RetryExhaustedError,
    RetryPolicy,
    classify_provider_error,
    parse_retry_after,
    retry_provider_call,
)


class APITimeoutError(Exception):
    pass


class APIConnectionError(Exception):
    pass


class RetryTests(unittest.TestCase):
    def test_error_classifier_separates_transient_and_blocking_failures(self):
        cases = (
            (ProviderRequestError("slow", status_code=408), FailureKind.TIMEOUT, True),
            (ProviderRequestError("too early", status_code=425), FailureKind.RATE_LIMIT, True),
            (ProviderRequestError("busy", status_code=429), FailureKind.RATE_LIMIT, True),
            (ProviderRequestError("bad gateway", status_code=502), FailureKind.PROVIDER_5XX, True),
            (APITimeoutError("timeout"), FailureKind.TIMEOUT, True),
            (APIConnectionError("offline"), FailureKind.NETWORK, True),
            (socket.gaierror("dns unavailable"), FailureKind.NETWORK, True),
            (ProviderRequestError("bad", status_code=400), FailureKind.INVALID_REQUEST, False),
            (ProviderRequestError("auth", status_code=401), FailureKind.AUTH, False),
            (ProviderRequestError("forbidden", status_code=403), FailureKind.AUTH, False),
            (ProviderRequestError("missing", status_code=404), FailureKind.MODEL_NOT_FOUND, False),
            (
                ProviderRequestError(
                    "quota", status_code=429, provider_code="insufficient_quota"
                ),
                FailureKind.QUOTA_EXHAUSTED,
                False,
            ),
            (
                ProviderRequestError(
                    "substituted", provider_code="response_model_mismatch"
                ),
                FailureKind.RESPONSE_MODEL_MISMATCH,
                False,
            ),
        )
        for error, expected_kind, expected_retryable in cases:
            with self.subTest(error=error):
                result = classify_provider_error(error)
                self.assertEqual(result.kind, expected_kind)
                self.assertEqual(result.retryable, expected_retryable)
                self.assertEqual(result.blocked, not expected_retryable)

    def test_retry_after_supports_seconds_and_http_date(self):
        now = datetime(2026, 8, 23, tzinfo=timezone.utc)
        self.assertEqual(parse_retry_after("4", now=now), 4.0)
        future = now + timedelta(seconds=9)
        self.assertEqual(
            parse_retry_after(future.strftime("%a, %d %b %Y %H:%M:%S GMT"), now=now),
            9.0,
        )

    def test_retry_honors_retry_after_jitters_backoff_and_reenters_gate(self):
        calls = 0
        gate_entries = 0
        sleeps: list[float] = []
        failures: list[tuple[int, float | None]] = []

        def call():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ProviderRequestError("rate", status_code=429, retry_after="3")
            if calls == 2:
                raise APITimeoutError("slow")
            return "ok"

        def gate():
            nonlocal gate_entries
            gate_entries += 1

        value = retry_provider_call(
            call,
            policy=RetryPolicy(
                max_attempts=3,
                base_delay_seconds=2,
                max_delay_seconds=10,
                jitter=True,
            ),
            before_attempt=gate,
            on_failure=lambda attempt, _error, _kind, delay: failures.append(
                (attempt, delay)
            ),
            sleep=sleeps.append,
            random_value=lambda: 0.25,
        )
        self.assertEqual(value, "ok")
        self.assertEqual(calls, 3)
        self.assertEqual(gate_entries, 3)
        self.assertEqual(sleeps, [3.0, 1.0])
        self.assertEqual(failures, [(1, 3.0), (2, 1.0)])

    def test_fatal_failure_is_not_retried(self):
        calls = 0

        def call():
            nonlocal calls
            calls += 1
            raise ProviderRequestError("bad key", status_code=401)

        with self.assertRaises(ProviderRequestError):
            retry_provider_call(
                call,
                policy=RetryPolicy(max_attempts=5),
                sleep=lambda _seconds: None,
            )
        self.assertEqual(calls, 1)

    def test_transient_exhaustion_stays_retryable(self):
        with self.assertRaises(RetryExhaustedError) as raised:
            retry_provider_call(
                lambda: (_ for _ in ()).throw(
                    ProviderRequestError("busy", status_code=503)
                ),
                policy=RetryPolicy(
                    max_attempts=2,
                    base_delay_seconds=0,
                    max_delay_seconds=0,
                ),
                sleep=lambda _seconds: None,
            )
        self.assertEqual(raised.exception.attempts, 2)
        self.assertTrue(raised.exception.classification.retryable)

    def test_circuit_breaker_opens_after_threshold(self):
        breaker = CircuitBreaker(failure_threshold=2, cooldown_seconds=7)
        failure = classify_provider_error(
            ProviderRequestError("busy", status_code=429)
        )
        breaker.record_failure(failure, now=100)
        self.assertEqual(breaker.wait_seconds(now=100), 0)
        breaker.record_failure(failure, now=100)
        self.assertEqual(breaker.wait_seconds(now=100), 7)
        breaker.record_success()
        self.assertEqual(breaker.wait_seconds(now=100), 0)


if __name__ == "__main__":
    unittest.main()
