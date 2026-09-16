from __future__ import annotations

import sys
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import ArtifactStore, JudgeCacheKey  # noqa: E402
from runtime.integrity import require_complete_run  # noqa: E402
from runtime.models import NormalizedUsage, TaskExecutionResult, TaskSpec  # noqa: E402
from runtime.retry import ProviderRequestError, RetryPolicy, retry_provider_call  # noqa: E402
from runtime.runner import MemoryArenaRunner, RunnerPolicy  # noqa: E402


def make_task(key: str) -> TaskSpec:
    return TaskSpec(
        task_key=key,
        domain=key.split("/", 1)[0],
        subtask_ids=(f"{key}:1", f"{key}:2"),
        source_record_hash=(key.encode().hex() + "0" * 64)[:64],
    )


def make_runner(
    root: Path,
    tasks: list[TaskSpec],
    *,
    attempts=2,
    concurrency=1,
    retry_initial_delay_seconds=1.0,
    retry_max_delay_seconds=60.0,
    sleep=lambda _seconds: None,
):
    tasks = sorted(tasks, key=lambda item: item.task_key)
    store = ArtifactStore(root, "offline-e2e")
    task_manifest = {
        "schema_version": 1,
        "benchmark_name": "MemoryArena Public",
        "test_fixture": True,
        "task_count": len(tasks),
        "tasks": [task.to_manifest_entry() for task in tasks],
    }
    runner = MemoryArenaRunner(
        store=store,
        tasks=tasks,
        run_manifest={
            "schema_version": 1,
            "official_revision": "6cd9de14",
            "dataset_revision": "da1a37c8",
            "models": {
                "task_agent": "mock-task",
                "retrieval_agent": "mock-retrieval",
                "judge": "mock-judge",
            },
        },
        task_manifest=task_manifest,
        policy=RunnerPolicy(
            concurrency=concurrency,
            task_attempts_per_invocation=attempts,
            task_retry_initial_delay_seconds=retry_initial_delay_seconds,
            task_retry_max_delay_seconds=retry_max_delay_seconds,
        ),
        sleep=sleep,
    )
    return store, runner


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)

    def test_offline_e2e_retries_infra_then_accepts_valid_wrong_answer(self):
        task = make_task("math/group-1")
        store, runner = make_runner(Path(self.temporary.name) / "run", [task])
        task_calls = 0
        provider_calls = 0
        scopes: list[str] = []

        def executor(spec, context, artifacts):
            nonlocal task_calls, provider_calls
            task_calls += 1
            scopes.append(context.memory_scope)
            artifacts.record_usage(
                stage="retrieval-agent",
                model="mock-retrieval",
                usage=NormalizedUsage(input_tokens=5, output_tokens=1, cost_usd=0.01),
            )

            def provider():
                nonlocal provider_calls
                provider_calls += 1
                if task_calls == 1:
                    raise ProviderRequestError("429", status_code=429)
                if provider_calls == 2:
                    raise ProviderRequestError("timeout", status_code=408)
                return "valid answer"

            answer = retry_provider_call(
                provider,
                policy=RetryPolicy(
                    max_attempts=1 if task_calls == 1 else 2,
                    base_delay_seconds=0,
                    max_delay_seconds=0,
                ),
                sleep=lambda _seconds: None,
            )
            artifacts.append_event(
                component="official-agent",
                kind="answer",
                payload={"answer": answer},
                subtask_id=spec.subtask_ids[0],
            )
            return TaskExecutionResult(
                completed_subtask_ids=spec.subtask_ids,
                # It is intentionally wrong: infrastructure validity, not
                # correctness, determines whether a task may be retried.
                result={"answers": ["wrong", "also wrong"]},
                usage=(
                    {
                        "stage": "official-agent",
                        "model": "mock-task",
                        "usage": {
                            "input_tokens": 10,
                            "output_tokens": 2,
                            "cost_usd": 0.02,
                        },
                    },
                ),
            )

        summary = runner.run(executor)
        self.assertTrue(summary.report.eligible_for_scoring)
        self.assertEqual(task_calls, 2)
        self.assertEqual(len(set(scopes)), 2)
        self.assertEqual(len(store.list_attempts(task.task_key)), 2)
        record = store.load_success(task.task_key)
        self.assertEqual(record["result"]["answers"][0], "wrong")
        usage = store.summarize_usage()["buckets"]
        self.assertEqual(usage["retry_overhead"]["total_tokens"], 6)
        self.assertEqual(usage["accepted_evaluation"]["total_tokens"], 18)

        # A successful judge result is separately cached with full provenance.
        judge_key = JudgeCacheKey(
            evaluator_revision="official@1",
            judge_adapter_version="memoryarena-public@1",
            system_prompt_sha256="1" * 64,
            user_prompt_sha256="2" * 64,
            prediction_sha256="3" * 64,
            reference_sha256="4" * 64,
            requested_model="mock-judge",
            observed_model_policy="exact",
            temperature=0,
            reasoning=None,
            max_output_tokens=32,
        )
        store.put_judge_cache(
            judge_key,
            raw_response={"text": "0"},
            parsed_decision={"score": 0},
            usage=NormalizedUsage(input_tokens=3, output_tokens=1, cost_usd=0.001),
            response_id="judge-1",
            response_model="mock-judge",
        )
        self.assertEqual(store.get_judge_cache(judge_key)["parsed_decision"], {"score": 0})

    def test_resume_skips_atomic_success(self):
        tasks = [make_task("math/a"), make_task("travel/b")]
        root = Path(self.temporary.name) / "resume"
        store, runner = make_runner(root, tasks, concurrency=2)
        calls = defaultdict(int)

        def executor(spec, _context, _artifacts):
            calls[spec.task_key] += 1
            return TaskExecutionResult(spec.subtask_ids, {"ok": True})

        first = runner.run(executor)
        self.assertTrue(first.report.eligible_for_scoring)
        _, resumed_runner = make_runner(root, tasks, concurrency=2)
        second = resumed_runner.run(executor)
        self.assertEqual(second.attempts_started, 0)
        self.assertEqual(dict(calls), {task.task_key: 1 for task in tasks})
        require_complete_run(store)

    def test_incomplete_group_is_blocked_and_never_installed(self):
        task = make_task("search/incomplete")
        root = Path(self.temporary.name) / "blocked"
        store, runner = make_runner(root, [task])
        calls = 0

        def incomplete(spec, _context, _artifacts):
            nonlocal calls
            calls += 1
            return TaskExecutionResult((spec.subtask_ids[0],), {"partial": True})

        first = runner.run(incomplete)
        self.assertEqual(first.report.blocked, (task.task_key,))
        self.assertIsNone(store.load_success(task.task_key))
        _, resumed = make_runner(root, [task])
        resumed.run(incomplete)
        self.assertEqual(calls, 1)

    def test_systemic_provider_failure_stops_new_tasks(self):
        tasks = [make_task("math/a"), make_task("math/b")]
        store, runner = make_runner(
            Path(self.temporary.name) / "systemic", tasks, concurrency=1
        )
        calls: list[str] = []

        def executor(spec, _context, _artifacts):
            calls.append(spec.task_key)
            raise ProviderRequestError("bad key", status_code=401)

        summary = runner.run(executor)
        self.assertEqual(calls, [tasks[0].task_key])
        self.assertEqual(summary.report.blocked, (tasks[0].task_key,))
        self.assertEqual(summary.report.pending, (tasks[1].task_key,))

    def test_task_group_retry_honors_retry_after_and_uses_fresh_scope(self):
        task = make_task("search/rate-limited")
        sleeps: list[float] = []
        scopes: list[str] = []
        store, runner = make_runner(
            Path(self.temporary.name) / "retry-after",
            [task],
            attempts=2,
            retry_initial_delay_seconds=1,
            retry_max_delay_seconds=4,
            sleep=sleeps.append,
        )

        def executor(spec, context, _artifacts):
            scopes.append(context.memory_scope)
            if len(scopes) == 1:
                raise ProviderRequestError(
                    "slow down", status_code=429, retry_after="7"
                )
            return TaskExecutionResult(spec.subtask_ids, {"ok": True})

        summary = runner.run(executor)

        self.assertTrue(summary.report.eligible_for_scoring)
        self.assertEqual(len(scopes), 2)
        self.assertEqual(len(set(scopes)), 2)
        self.assertEqual(len(store.list_attempts(task.task_key)), 2)
        self.assertEqual(len(sleeps), 1)
        self.assertGreater(sleeps[0], 6.9)
        first_attempt = store.list_attempts(task.task_key)[0]
        self.assertEqual(first_attempt["failure"]["kind"], "rate-limit")
        self.assertEqual(first_attempt["failure"]["retry_after_seconds"], 7.0)

    def test_task_group_5xx_uses_bounded_exponential_backoff(self):
        task = make_task("search/provider-5xx")
        sleeps: list[float] = []
        calls = 0
        _, runner = make_runner(
            Path(self.temporary.name) / "bounded-backoff",
            [task],
            attempts=4,
            retry_initial_delay_seconds=2,
            retry_max_delay_seconds=3,
            sleep=sleeps.append,
        )

        def executor(spec, _context, _artifacts):
            nonlocal calls
            calls += 1
            if calls < 4:
                raise ProviderRequestError("upstream", status_code=503)
            return TaskExecutionResult(spec.subtask_ids, {"ok": True})

        summary = runner.run(executor)

        self.assertTrue(summary.report.eligible_for_scoring)
        self.assertEqual(calls, 4)
        self.assertEqual(len(sleeps), 3)
        for actual, expected in zip(sleeps, (2.0, 3.0, 3.0)):
            self.assertAlmostEqual(actual, expected, delta=0.1)

    def test_resume_retries_failed_group_in_another_fresh_scope(self):
        task = make_task("search/resume-retry")
        root = Path(self.temporary.name) / "resume-retry"
        scopes: list[str] = []
        store, first_runner = make_runner(root, [task], attempts=1)

        def fail_once(_spec, context, _artifacts):
            scopes.append(context.memory_scope)
            raise ProviderRequestError(
                "temporarily unavailable", status_code=429, retry_after="3"
            )

        first = first_runner.run(fail_once)
        self.assertFalse(first.report.eligible_for_scoring)
        self.assertEqual(first.report.failed_retryable, (task.task_key,))
        self.assertIsNone(store.load_success(task.task_key))

        _, resumed_runner = make_runner(root, [task], attempts=1)

        def succeed(spec, context, _artifacts):
            scopes.append(context.memory_scope)
            return TaskExecutionResult(spec.subtask_ids, {"ok": True})

        resumed = resumed_runner.run(succeed)
        self.assertTrue(resumed.report.eligible_for_scoring)
        self.assertEqual(len(scopes), 2)
        self.assertEqual(len(set(scopes)), 2)
        self.assertEqual(len(store.list_attempts(task.task_key)), 2)

    def test_auth_failure_is_never_retried_or_slept(self):
        task = make_task("search/auth")
        sleeps: list[float] = []
        scopes: list[str] = []
        _, runner = make_runner(
            Path(self.temporary.name) / "auth-no-retry",
            [task],
            attempts=5,
            sleep=sleeps.append,
        )

        def executor(_spec, context, _artifacts):
            scopes.append(context.memory_scope)
            raise ProviderRequestError("bad key", status_code=401)

        summary = runner.run(executor)

        self.assertEqual(len(scopes), 1)
        self.assertEqual(sleeps, [])
        self.assertEqual(summary.report.blocked, (task.task_key,))


if __name__ == "__main__":
    unittest.main()
