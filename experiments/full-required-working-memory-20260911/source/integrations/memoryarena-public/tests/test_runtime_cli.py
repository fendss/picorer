from __future__ import annotations

import json
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import locked_manifest_document, read_json  # noqa: E402
from runtime.integrity import (  # noqa: E402
    IntegrityError,
    OFFICIAL_CODE_REVISION,
    PUBLIC_DATA_REPOSITORY,
    PUBLIC_DATA_REVISION,
    RELEASE_ID,
    RELEASE_SUITE_COUNTS,
    RELEASE_SUITE_SUBTASK_COUNTS,
    SEARCH_RUNNER_IDS_SOURCE,
    _RELEASE_SUITE_DETAILS,
)
from runtime.models import TaskExecutionResult, TaskSpec  # noqa: E402
from runtime.run_memoryarena_public import (  # noqa: E402
    CliContractError,
    build_parser,
    executor_implementation_sha256,
    execute_from_args,
)
from runtime.usage import locked_price_table_document  # noqa: E402


SEARCH_RUNNER_IDS = json.loads(
    (INTEGRATION_ROOT / "upstream" / "search_runner_ids.json").read_text(
        encoding="utf-8"
    )
)["ordered_ids"]


def successful_executor(task, _context, artifacts):
    artifacts.append_event(
        component="official-agent",
        kind="raw-turn",
        payload={"answer": "valid result, correctness is irrelevant to retry"},
        subtask_id=task.subtask_ids[0],
    )
    return TaskExecutionResult(
        completed_subtask_ids=task.subtask_ids,
        result={"answer": "valid result"},
        usage=(
            {
                "stage": "retrieval-agent",
                "model": "retrieval-model",
                "usage": {
                    "input": 100,
                    "output": 10,
                    "cacheRead": 20,
                    "cacheWrite": 0,
                    "reasoning": 3,
                    "totalTokens": 130,
                    "cost": {"total": 0},
                },
            },
        ),
    )


def production_task_manifest() -> dict:
    local_asset_hash = "b" * 64
    tasks = []
    for suite, count in RELEASE_SUITE_COUNTS.items():
        details = _RELEASE_SUITE_DETAILS[suite]
        start = int(details["id_start"])
        subtask_total = RELEASE_SUITE_SUBTASK_COUNTS[suite]
        base, remainder = divmod(subtask_total, count)
        for ordinal in range(count):
            record_id = start + ordinal
            task_key = f"{suite}/{record_id:03d}"
            subtask_count = base + (1 if ordinal < remainder else 0)
            if suite == "bundled_shopping":
                subtask_ids = tuple(
                    f"{task_key}/step/{index}" for index in range(1, 7)
                )
            elif suite == "progressive_search":
                subtask_ids = tuple(
                    [
                        *(
                            f"{task_key}/subquery/{index}"
                            for index in range(1, subtask_count)
                        ),
                        f"{task_key}/final",
                    ]
                )
            elif suite == "group_travel_planner":
                subtask_ids = tuple(
                    f"{task_key}/person/{index}"
                    for index in range(1, subtask_count + 1)
                )
            else:
                subtask_ids = tuple(
                    f"{task_key}/query/{index}" for index in range(subtask_count)
                )
            metadata = {
                "release_id": RELEASE_ID,
                "suite": suite,
                "record_kind": details["record_kind"],
                "record_id": record_id,
                "ordinal": ordinal,
                "source": {
                    "relative_path": details["relative_path"],
                    "line_number": ordinal + 1,
                    "file_sha256": details["file_sha256"],
                    "data_git_oid": details["data_git_oid"],
                },
                "code_revision": OFFICIAL_CODE_REVISION,
                "data_revision": PUBLIC_DATA_REVISION,
                "official_runner": details["runner"],
                "local_asset_manifest_sha256": local_asset_hash,
            }
            if suite == "bundled_shopping":
                metadata["category"] = "test-category"
            elif suite == "progressive_search":
                metadata["official_query_id"] = SEARCH_RUNNER_IDS[ordinal]
            elif suite.startswith("formal_reasoning_"):
                metadata["paper_name"] = f"paper-{record_id}"
            tasks.append(
                TaskSpec(
                    task_key=task_key,
                    domain=suite,
                    subtask_ids=subtask_ids,
                    source_record_hash=hashlib.sha256(task_key.encode()).hexdigest(),
                    metadata=metadata,
                ).to_manifest_entry()
            )
    tasks.sort(key=lambda item: item["task_key"])
    return locked_manifest_document(
        {
            "schema_version": 2,
            "kind": "memoryarena-public-task-manifest",
            "benchmark_name": "MemoryArena Public",
            "release_id": RELEASE_ID,
            "code_revision": OFFICIAL_CODE_REVISION,
            "data_repository": PUBLIC_DATA_REPOSITORY,
            "data_revision": PUBLIC_DATA_REVISION,
            "local_asset_manifest_sha256": local_asset_hash,
            "task_count": 701,
            "total_subtasks": 4_850,
            "suite_counts": dict(RELEASE_SUITE_COUNTS),
            "domain_counts": dict(RELEASE_SUITE_COUNTS),
            "suite_subtask_counts": dict(RELEASE_SUITE_SUBTASK_COUNTS),
            "source_files": {
                suite: {
                    "relative_path": details["relative_path"],
                    "sha256": details["file_sha256"],
                    "git_oid": details["data_git_oid"],
                    "row_count": RELEASE_SUITE_COUNTS[suite],
                }
                for suite, details in _RELEASE_SUITE_DETAILS.items()
            },
            "search_runner_ids_source": dict(SEARCH_RUNNER_IDS_SOURCE),
            "tasks": tasks,
        }
    )
class CliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.task = TaskSpec(
            task_key="formal-math/group-1",
            domain="formal-math",
            subtask_ids=("q1", "q2"),
            source_record_hash="a" * 64,
        )
        self.fixture_task_manifest = locked_manifest_document(
            {
                "schema_version": 1,
                "benchmark_name": "MemoryArena Public",
                "test_fixture": True,
                "task_count": 1,
                "tasks": [self.task.to_manifest_entry()],
            }
        )
        self.task_manifest = production_task_manifest()
        self.run_manifest = locked_manifest_document(
            {
                "schema_version": 1,
                "benchmark_name": "MemoryArena Public",
                "run_id": "cli-test-run",
                "official_revision": "6cd9de14",
                "dataset_revision": "da1a37c8",
                "models": {"retrieval_agent": "retrieval-model"},
            }
        )
        self.price_table = locked_price_table_document(
            {
                "retrieval-model": {
                    "input": 2,
                    "output": 8,
                    "cache_read": 0.5,
                    "cache_write": 3,
                }
            }
        )
        self.task_path = self.root / "tasks.json"
        self.run_path = self.root / "run.json"
        self.price_path = self.root / "prices.json"
        for path, value in (
            (self.task_path, self.task_manifest),
            (self.run_path, self.run_manifest),
            (self.price_path, self.price_table),
        ):
            path.write_text(json.dumps(value), encoding="utf-8")

    def args(self, run_dir: Path, *extra: str):
        return build_parser().parse_args(
            [
                "--task-manifest",
                str(self.task_path),
                "--run-manifest",
                str(self.run_path),
                "--run-dir",
                str(run_dir),
                "--executor",
                "test_runtime_cli:successful_executor",
                "--price-table",
                str(self.price_path),
                *extra,
            ]
        )

    def test_cli_runs_locked_manifest_writes_indexes_and_resumes(self):
        run_dir = self.root / "output"
        first = execute_from_args(self.args(run_dir, "--slots", "2", "--attempts", "2"))
        self.assertTrue(first.report.eligible_for_scoring)
        local_run = read_json(run_dir / "run-manifest.json")
        self.assertEqual(local_run["runtime_execution"]["slots"], 2)
        self.assertEqual(local_run["runtime_execution"]["attempts_per_invocation"], 2)
        self.assertEqual(
            local_run["runtime_execution"]["task_retry_initial_delay_seconds"],
            1.0,
        )
        self.assertEqual(
            local_run["runtime_execution"]["task_retry_max_delay_seconds"],
            60.0,
        )
        self.assertRegex(
            local_run["runtime_execution"]["executor_implementation_sha256"],
            r"^[0-9a-f]{64}$",
        )
        self.assertEqual(
            local_run["runtime_execution"]["price_table_sha256"],
            self.price_table["manifest_sha256"],
        )
        for name in (
            "artifacts.json",
            "tasks.json",
            "trajectories.json",
            "judge-cache.json",
            "usage-cost.json",
        ):
            self.assertTrue((run_dir / "indexes" / name).is_file())
        usage = read_json(run_dir / "usage" / "summary.json")["buckets"]
        self.assertEqual(usage["accepted_evaluation"]["cost_status"], "complete")
        self.assertGreater(usage["accepted_evaluation"]["estimated_cost_usd"], 0)

        resumed = execute_from_args(self.args(run_dir, "--resume"))
        self.assertEqual(resumed.attempts_started, 0)
        self.assertTrue(resumed.report.eligible_for_scoring)

    def test_cli_refuses_manifest_mismatch_before_executor(self):
        run_dir = self.root / "mismatch"
        execute_from_args(self.args(run_dir))
        changed = locked_manifest_document(
            {
                **{
                    key: value
                    for key, value in self.run_manifest.items()
                    if key != "manifest_sha256"
                },
                "models": {"retrieval_agent": "changed-model"},
            }
        )
        changed_path = self.root / "changed-run.json"
        changed_path.write_text(json.dumps(changed), encoding="utf-8")
        args = self.args(run_dir, "--resume")
        args.run_manifest = changed_path
        with self.assertRaises(ValueError):
            execute_from_args(args)

    def test_cli_refuses_orphan_record_on_resume(self):
        run_dir = self.root / "orphan"
        execute_from_args(self.args(run_dir))
        (run_dir / "records" / "orphan.json").write_text(
            json.dumps({"task_key": "not-in-manifest"}), encoding="utf-8"
        )
        with self.assertRaises(IntegrityError):
            execute_from_args(self.args(run_dir, "--resume"))

    def test_cli_requires_resume_for_existing_runtime(self):
        run_dir = self.root / "existing"
        execute_from_args(self.args(run_dir))
        with self.assertRaises(CliContractError):
            execute_from_args(self.args(run_dir))

    def test_cli_always_rejects_explicit_test_fixture_manifest(self):
        fixture_path = self.root / "fixture-tasks.json"
        fixture_path.write_text(
            json.dumps(self.fixture_task_manifest), encoding="utf-8"
        )
        args = self.args(self.root / "fixture-output")
        args.task_manifest = fixture_path
        with self.assertRaisesRegex(CliContractError, "test_fixture"):
            execute_from_args(args)

    def test_resume_rejects_changed_executor_implementation_hash(self):
        run_dir = self.root / "executor-drift"
        execute_from_args(self.args(run_dir))
        with patch(
            "runtime.run_memoryarena_public.executor_implementation_sha256",
            return_value="c" * 64,
        ):
            with self.assertRaisesRegex(CliContractError, "executor implementation"):
                execute_from_args(self.args(run_dir, "--resume"))

    def test_package_executor_hash_binds_helper_and_descriptor_files(self):
        package = self.root / "executor_package"
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "executor.py").write_text(
            "def execute(*_args):\n    return None\n",
            encoding="utf-8",
        )
        helper = package / "helper.py"
        helper.write_text("VALUE = 1\n", encoding="utf-8")
        descriptor = package / "descriptor.json"
        descriptor.write_text('{"version":1}\n', encoding="utf-8")
        sys.path.insert(0, str(self.root))
        self.addCleanup(lambda: sys.path.remove(str(self.root)))

        reference = "executor_package.executor:execute"
        initial = executor_implementation_sha256(reference)
        helper.write_text("VALUE = 2\n", encoding="utf-8")
        helper_changed = executor_implementation_sha256(reference)
        descriptor.write_text('{"version":2}\n', encoding="utf-8")
        descriptor_changed = executor_implementation_sha256(reference)

        self.assertNotEqual(initial, helper_changed)
        self.assertNotEqual(helper_changed, descriptor_changed)

    def test_resume_freezes_task_retry_policy(self):
        run_dir = self.root / "retry-policy-drift"
        execute_from_args(
            self.args(
                run_dir,
                "--retry-initial-delay-seconds",
                "2",
                "--retry-max-delay-seconds",
                "20",
            )
        )

        # Omitting the flags inherits the frozen values and resumes cleanly.
        resumed = execute_from_args(self.args(run_dir, "--resume"))
        self.assertEqual(resumed.attempts_started, 0)

        with self.assertRaisesRegex(CliContractError, "retry policy differs"):
            execute_from_args(
                self.args(
                    run_dir,
                    "--resume",
                    "--retry-initial-delay-seconds",
                    "3",
                    "--retry-max-delay-seconds",
                    "20",
                )
            )


if __name__ == "__main__":
    unittest.main()
