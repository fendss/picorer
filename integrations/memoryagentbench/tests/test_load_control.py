from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mab_adapter.load_control import (  # noqa: E402
    AdaptiveConcurrencyConfig,
    AdaptiveConcurrencyController,
)


class AdaptiveConcurrencyControllerTests(unittest.TestCase):
    def test_blocks_at_limit_then_uses_aimd(self):
        controller = AdaptiveConcurrencyController(
            AdaptiveConcurrencyConfig(
                minimum=1,
                initial=2,
                maximum=4,
                successes_per_increase=2,
            )
        )
        first = controller.acquire()
        second = controller.acquire()
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)

        admitted = threading.Event()
        release = threading.Event()

        def waiter() -> None:
            lease_id = controller.acquire()
            self.assertIsNotNone(lease_id)
            admitted.set()
            release.wait(timeout=2)
            assert lease_id is not None
            controller.cancelled(lease_id)

        thread = threading.Thread(target=waiter)
        thread.start()
        self.assertFalse(admitted.wait(timeout=0.05))

        assert first is not None
        controller.succeeded(first, "retrieval")
        self.assertTrue(admitted.wait(timeout=1))
        assert second is not None
        controller.succeeded(second, "answer")
        release.set()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())

        increased = controller.snapshot()
        self.assertEqual(increased["current_limit"], 3)
        self.assertEqual(increased["peak_in_flight"], 2)
        self.assertEqual(increased["changes"][-1]["reason"], "sustained_success")

        lease_id = controller.acquire()
        self.assertIsNotNone(lease_id)
        assert lease_id is not None
        controller.failed(
            lease_id,
            "retrieval",
            retryable=True,
            http_status=503,
            error_code="upstream_unavailable",
        )
        reduced = controller.snapshot()
        self.assertEqual(reduced["current_limit"], 1)
        self.assertEqual(reduced["retryable_failures"], 1)
        self.assertEqual(reduced["changes"][-1]["http_status"], 503)

    def test_restores_only_a_compatible_snapshot(self):
        config = AdaptiveConcurrencyConfig(1, 2, 8, 4)
        controller = AdaptiveConcurrencyController(config)
        lease_id = controller.acquire()
        self.assertIsNotNone(lease_id)
        assert lease_id is not None
        controller.failed(lease_id, "answer", retryable=True, http_status=429)
        snapshot = controller.snapshot()

        restored = AdaptiveConcurrencyController(config, snapshot).snapshot()
        self.assertEqual(restored["current_limit"], 1)
        self.assertEqual(restored["retryable_failures"], 1)

        incompatible = AdaptiveConcurrencyController(
            AdaptiveConcurrencyConfig(1, 3, 8, 4),
            snapshot,
        ).snapshot()
        self.assertEqual(incompatible["current_limit"], 3)
        self.assertEqual(incompatible["retryable_failures"], 0)

    def test_coalesces_one_concurrent_failure_wave(self):
        controller = AdaptiveConcurrencyController(
            AdaptiveConcurrencyConfig(1, 8, 32, 8)
        )
        leases = [controller.acquire() for _ in range(8)]
        self.assertNotIn(None, leases)

        for lease_id in leases:
            assert lease_id is not None
            controller.failed(
                lease_id,
                "retrieval",
                retryable=True,
                http_status=503,
            )

        snapshot = controller.snapshot()
        self.assertEqual(snapshot["current_limit"], 4)
        self.assertEqual(snapshot["retryable_failures"], 8)
        self.assertEqual(snapshot["coalesced_retryable_failures"], 7)
        self.assertEqual(len(snapshot["changes"]), 1)

        next_lease = controller.acquire()
        self.assertIsNotNone(next_lease)
        assert next_lease is not None
        controller.failed(
            next_lease,
            "retrieval",
            retryable=True,
            http_status=503,
        )
        self.assertEqual(controller.snapshot()["current_limit"], 2)


if __name__ == "__main__":
    unittest.main()
