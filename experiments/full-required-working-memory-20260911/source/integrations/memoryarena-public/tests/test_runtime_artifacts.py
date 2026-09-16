from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import ArtifactStore, JudgeCacheKey  # noqa: E402
from runtime.integrity import (  # noqa: E402
    IntegrityError,
    audit_run,
    require_clean_artifact_inventory,
    require_complete_run,
)
from runtime.models import (  # noqa: E402
    FailureClassification,
    FailureKind,
    NormalizedUsage,
    TaskSpec,
    TaskStatus,
)


def task(key: str = "math/paper-1") -> TaskSpec:
    return TaskSpec(
        task_key=key,
        domain=key.split("/", 1)[0],
        subtask_ids=("q1", "q2"),
        source_record_hash="a" * 64,
    )


def manifests(tasks: list[TaskSpec]):
    tasks = sorted(tasks, key=lambda item: item.task_key)
    return (
        {
            "schema_version": 1,
            "code_revision": "official@abc",
            "picorer_revision": "picorer@def",
            "models": {"task_agent": "model-a", "retrieval_agent": "model-b"},
        },
        {
            "schema_version": 1,
            "benchmark_name": "MemoryArena Public",
            "test_fixture": True,
            "task_count": len(tasks),
            "tasks": [item.to_manifest_entry() for item in tasks],
        },
    )


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = ArtifactStore(Path(self.temporary.name) / "run", "run-1")
        self.task = task()
        run_manifest, task_manifest = manifests([self.task])
        self.store.initialize(
            run_manifest=run_manifest, task_manifest=task_manifest
        )
        self.task_manifest = self.store.load_manifests()[1]

    def _succeed(self, *, cost: float | None = 0.2):
        handle = self.store.start_attempt(self.task)
        handle.append_event(
            component="official-agent", kind="message", payload={"text": "raw"}
        )
        handle.record_usage(
            stage="official-agent",
            model="model-a",
            usage=NormalizedUsage(
                input_tokens=10, output_tokens=4, cost_usd=cost
            ),
        )
        handle.finish(TaskStatus.SUCCEEDED)
        return handle, self.store.install_success(
            task=self.task,
            context=handle.context,
            completed_subtask_ids=self.task.subtask_ids,
            result={"answers": ["wrong is still valid", "answer"]},
        )

    def test_complete_atomic_record_is_scoring_eligible(self):
        handle, record = self._succeed()
        self.assertEqual(record["accepted_attempt_id"], handle.context.attempt_id)
        report = require_complete_run(self.store, self.task_manifest)
        self.assertTrue(report.eligible_for_scoring)

    def test_missing_task_is_not_silently_scored_zero(self):
        report = audit_run(self.store, self.task_manifest)
        self.assertEqual(report.pending, (self.task.task_key,))
        self.assertFalse(report.eligible_for_scoring)
        with self.assertRaises(IntegrityError):
            require_complete_run(self.store, self.task_manifest)

    def test_retry_overhead_is_separate_from_accepted_cost(self):
        failed = self.store.start_attempt(self.task)
        failed.record_usage(
            stage="retrieval-agent",
            model="model-b",
            usage=NormalizedUsage(
                input_tokens=100, output_tokens=20, cost_usd=None
            ),
        )
        failed.finish(
            TaskStatus.FAILED_RETRYABLE,
            failure=FailureClassification(
                FailureKind.RATE_LIMIT, retryable=True, blocked=False
            ),
        )
        self._succeed(cost=0.2)
        summary = self.store.summarize_usage()["buckets"]
        self.assertEqual(summary["accepted_evaluation"]["total_tokens"], 14)
        self.assertAlmostEqual(
            summary["accepted_evaluation"]["known_cost_usd"], 0.2
        )
        self.assertEqual(summary["retry_overhead"]["total_tokens"], 120)
        self.assertEqual(summary["retry_overhead"]["unknown_cost_events"], 1)
        self.assertEqual(summary["all_billed"]["total_tokens"], 134)
        self.assertEqual(summary["all_billed"]["by_domain"]["math"], 134)

    def test_stale_running_attempt_is_recovered_not_scored(self):
        handle = self.store.start_attempt(self.task)
        handle.append_event(
            component="official-agent", kind="partial", payload={"round": 1}
        )
        recovered = self.store.recover_stale_running()
        self.assertEqual(recovered, [handle.context.attempt_id])
        attempt = self.store.list_attempts(self.task.task_key)[0]
        self.assertEqual(attempt["status"], TaskStatus.FAILED_RETRYABLE.value)
        self.assertFalse(audit_run(self.store, self.task_manifest).eligible_for_scoring)

    def test_trajectory_tampering_fails_integrity_gate(self):
        handle, _ = self._succeed()
        with handle.trajectory_path.open("a", encoding="utf-8") as stream:
            stream.write("{}\n")
        report = audit_run(self.store, self.task_manifest)
        self.assertEqual(report.invalid, (self.task.task_key,))

    def test_judge_cache_is_provenance_keyed_and_success_only(self):
        key = JudgeCacheKey(
            evaluator_revision="judge@1",
            judge_adapter_version="adapter@1",
            system_prompt_sha256="1" * 64,
            user_prompt_sha256="2" * 64,
            prediction_sha256="3" * 64,
            reference_sha256="4" * 64,
            requested_model="judge-model",
            observed_model_policy="exact",
            temperature=0,
            reasoning="low",
            max_output_tokens=256,
        )
        self.assertIsNone(self.store.get_judge_cache(key))
        self.store.put_judge_cache(
            key,
            raw_response={"id": "resp"},
            parsed_decision={"score": 1},
            usage=NormalizedUsage(input_tokens=7, output_tokens=2, cost_usd=0.01),
            response_id="resp",
            response_model="judge-model",
        )
        self.assertEqual(self.store.get_judge_cache(key)["parsed_decision"]["score"], 1)
        cached = self.store.put_judge_cache(
            key,
            raw_response={"id": "would-have-been-a-second-call"},
            parsed_decision={"score": 0},
            usage=NormalizedUsage(input_tokens=99, output_tokens=9, cost_usd=9),
            response_id="ignored",
            response_model="judge-model",
        )
        self.assertEqual(cached["parsed_decision"]["score"], 1)
        usage_events = [
            json.loads(line)
            for line in (self.store.usage_dir / "events.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        self.assertEqual([event["stage"] for event in usage_events], ["judge"])
        changed = JudgeCacheKey(**{**key.payload(), "prediction_sha256": "5" * 64})
        self.assertIsNone(self.store.get_judge_cache(changed))

        self._succeed()
        self.store.generate_indexes()
        judge_index = json.loads(
            (self.store.indexes_dir / "judge-cache.json").read_text(encoding="utf-8")
        )
        self.assertEqual(judge_index["entries"], 1)
        self.assertEqual(judge_index["judge_cache"][0]["cache_key"], key.digest)

    def test_unattributed_zero_cost_is_persisted_as_unknown(self):
        handle = self.store.start_attempt(self.task)
        handle.record_usage(
            stage="retrieval-agent",
            model="unpriced-model",
            usage=NormalizedUsage(input_tokens=3, output_tokens=1, cost_usd=0),
        )
        handle.finish(TaskStatus.SUCCEEDED)
        self.store.install_success(
            task=self.task,
            context=handle.context,
            completed_subtask_ids=self.task.subtask_ids,
            result={"answer": "valid"},
        )
        bucket = self.store.summarize_usage()["buckets"]["accepted_evaluation"]
        self.assertEqual(bucket["unknown_cost_events"], 1)
        self.assertEqual(bucket["cost_status"], "unknown")
        self.assertEqual(bucket["known_cost_usd"], 0)

    def test_orphan_runtime_artifact_is_rejected(self):
        orphan = self.store.attempts_dir / "unknown-task"
        orphan.mkdir()
        with self.assertRaises(IntegrityError):
            require_clean_artifact_inventory(self.store, self.task_manifest)

    def test_manifest_rejects_secret_and_resume_mismatch(self):
        other = ArtifactStore(Path(self.temporary.name) / "other", "run-2")
        run_manifest, task_manifest = manifests([self.task])
        run_manifest["api_key"] = "should-never-be-written"
        with self.assertRaises(ValueError):
            other.initialize(run_manifest=run_manifest, task_manifest=task_manifest)

        run_manifest, task_manifest = manifests([self.task])
        run_manifest["note"] = "Authorization: Bearer sk-not-a-real-secret-12345"
        with self.assertRaisesRegex(ValueError, "secret-bearing string"):
            ArtifactStore(
                Path(self.temporary.name) / "secret-value",
                "run",
            ).initialize(
                run_manifest=run_manifest,
                task_manifest=task_manifest,
            )

        run_manifest, task_manifest = manifests([self.task])
        with self.assertRaises(ValueError):
            self.store.initialize(
                run_manifest={**run_manifest, "code_revision": "changed"},
                task_manifest=task_manifest,
            )


if __name__ == "__main__":
    unittest.main()
