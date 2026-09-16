from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import ArtifactStore  # noqa: E402
from runtime.models import (  # noqa: E402
    FailureClassification,
    FailureKind,
    NormalizedUsage,
    TaskSpec,
    TaskStatus,
)
from runtime.usage import (  # noqa: E402
    UsageNormalizationError,
    load_price_table,
    locked_price_table_document,
    normalize_usage,
    price_table_from_document,
)


def price_document():
    return locked_price_table_document(
        {
            "priced-model": {
                "input": 2.0,
                "output": 8.0,
                "cache_read": 0.5,
                "cache_write": 3.0,
            },
            "free-model": {
                "input": 0.0,
                "output": 0.0,
                "cache_read": 0.0,
                "cache_write": 0.0,
            },
        },
        aliases={"priced-alias": "priced-model"},
    )


class UsageTests(unittest.TestCase):
    def test_picorer_zero_cost_is_repriced_from_sha_locked_table(self):
        table = price_table_from_document(price_document(), source="test-table")
        usage = normalize_usage(
            {
                "input": 100,
                "output": 20,
                "cacheRead": 50,
                "cacheWrite": 10,
                "reasoning": 5,
                "totalTokens": 180,
                "cost": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "total": 0,
                },
            },
            model="priced-alias",
            price_table=table,
        )
        self.assertEqual(usage.input_tokens, 100)
        self.assertEqual(usage.cached_input_tokens, 50)
        self.assertEqual(usage.cache_write_tokens, 10)
        self.assertEqual(usage.effective_total_tokens, 180)
        self.assertAlmostEqual(usage.cost_usd, 0.000415)
        self.assertEqual(usage.price_sha256, table.sha256)
        self.assertTrue(usage.price_source.startswith("price-table:"))

    def test_provider_zero_without_model_rate_is_unknown_not_free(self):
        table = price_table_from_document(price_document())
        usage = normalize_usage(
            {
                "input": 10,
                "output": 2,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 12,
                "cost": {"total": 0},
            },
            model="missing-model",
            price_table=table,
        )
        self.assertIsNone(usage.cost_usd)
        self.assertEqual(usage.price_source, "unknown-provider-zero")

    def test_explicitly_configured_zero_rate_is_known_free(self):
        table = price_table_from_document(price_document())
        usage = normalize_usage(
            {"input": 10, "output": 2, "totalTokens": 12, "cost": 0},
            model="free-model",
            price_table=table,
        )
        self.assertEqual(usage.cost_usd, 0)
        self.assertEqual(usage.price_sha256, table.sha256)

    def test_chat_completions_usage_separates_cached_input(self):
        table = price_table_from_document(price_document())
        usage = normalize_usage(
            {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120,
                "prompt_tokens_details": {"cached_tokens": 40},
                "completion_tokens_details": {"reasoning_tokens": 5},
            },
            model="priced-model",
            price_table=table,
        )
        self.assertEqual(usage.input_tokens, 60)
        self.assertEqual(usage.cached_input_tokens, 40)
        self.assertEqual(usage.reasoning_tokens, 5)
        self.assertAlmostEqual(usage.cost_usd, 0.0003)

    def test_responses_usage_and_positive_provider_cost(self):
        table = price_table_from_document(price_document())
        usage = normalize_usage(
            {
                "input_tokens": 50,
                "output_tokens": 10,
                "total_tokens": 60,
                "input_tokens_details": {"cached_tokens": 20},
                "output_tokens_details": {"reasoning_tokens": 4},
                "cost": 0.123,
            },
            model="priced-model",
            price_table=table,
        )
        self.assertEqual(usage.input_tokens, 30)
        self.assertEqual(usage.cached_input_tokens, 20)
        self.assertEqual(usage.cost_usd, 0.123)
        self.assertEqual(usage.price_source, "provider-reported")
        self.assertIsNone(usage.price_sha256)

    def test_price_table_requires_valid_embedded_sha(self):
        document = price_document()
        document["models"]["priced-model"]["input"] = 999
        with self.assertRaises(UsageNormalizationError):
            price_table_from_document(document)

    def test_load_price_table_from_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prices.json"
            path.write_text(json.dumps(price_document()), encoding="utf-8")
            table = load_price_table(path)
        self.assertIsNotNone(table.rate_for("priced-model"))

    def _coverage_store(self) -> tuple[ArtifactStore, TaskSpec]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        task = TaskSpec(
            task_key="suite/task-1",
            domain="suite",
            subtask_ids=("q1",),
            source_record_hash="a" * 64,
        )
        store = ArtifactStore(Path(temporary.name) / "run", "run-coverage")
        store.initialize(
            run_manifest={"schema_version": 1},
            task_manifest={
                "schema_version": 1,
                "test_fixture": True,
                "tasks": [task.to_manifest_entry()],
            },
        )
        return store, task

    def test_usage_coverage_event_prevents_complete_summary(self):
        store, task = self._coverage_store()
        attempt = store.start_attempt(task)
        attempt.append_event(
            component="official-upstream",
            kind="usage-coverage",
            payload={
                "official-agent": "observed from provider response",
                "official-judge": "unknown: provider discarded response usage",
            },
        )
        attempt.record_usage(
            stage="official-agent",
            model="priced-model",
            usage=NormalizedUsage(input_tokens=10, output_tokens=2, cost_usd=0.01),
        )
        attempt.finish(TaskStatus.SUCCEEDED)
        store.install_success(
            task=task,
            context=attempt.context,
            completed_subtask_ids=task.subtask_ids,
            result={"answer": "valid"},
        )

        summary = store.summarize_usage()
        self.assertEqual(summary["coverage_status"], "partial")
        self.assertEqual(summary["coverage"]["accepted_evaluation"]["status"], "partial")
        self.assertEqual(summary["coverage"]["accepted_evaluation"]["observation_count"], 1)
        self.assertEqual(
            summary["buckets"]["accepted_evaluation"]["cost_status"], "complete"
        )
        self.assertEqual(
            summary["buckets"]["accepted_evaluation"]["coverage_status"], "partial"
        )

    def test_failed_attempt_without_usage_is_conservative_retry_gap(self):
        store, task = self._coverage_store()
        failed = store.start_attempt(task)
        failed.finish(
            TaskStatus.FAILED_RETRYABLE,
            failure=FailureClassification(
                FailureKind.RATE_LIMIT,
                retryable=True,
                blocked=False,
                stage="official-agent",
            ),
        )

        accepted = store.start_attempt(task)
        accepted.append_event(
            component="official-upstream",
            kind="usage-coverage",
            payload={"status": "complete"},
        )
        accepted.record_usage(
            stage="official-agent",
            model="priced-model",
            usage=NormalizedUsage(input_tokens=3, output_tokens=1, cost_usd=0.01),
        )
        accepted.finish(TaskStatus.SUCCEEDED)
        store.install_success(
            task=task,
            context=accepted.context,
            completed_subtask_ids=task.subtask_ids,
            result={"answer": "valid"},
        )

        coverage = store.summarize_usage()["coverage"]
        self.assertEqual(coverage["accepted_evaluation"]["status"], "complete")
        self.assertEqual(coverage["retry_overhead"]["status"], "unknown")
        self.assertEqual(coverage["all_billed"]["status"], "partial")
        gap = coverage["retry_overhead"]["observations"][0]
        self.assertEqual(gap["source"], "failed-attempt-without-usage")
        self.assertEqual(gap["attempt_id"], failed.context.attempt_id)


if __name__ == "__main__":
    unittest.main()
