from __future__ import annotations

import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import ArtifactStore, locked_manifest_document  # noqa: E402
from runtime.integrity import (  # noqa: E402
    IntegrityError,
    audit_run,
    validate_release_task_manifest,
    validate_task_manifest,
)
from runtime.models import TaskSpec  # noqa: E402
from test_runtime_cli import production_task_manifest  # noqa: E402


def relock(document: dict) -> dict:
    body = dict(document)
    body.pop("manifest_sha256", None)
    return locked_manifest_document(body)


class ReleaseContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.release = production_task_manifest()

    def test_exact_release_contract_accepts_701_tasks_and_4850_subtasks(self):
        tasks = validate_release_task_manifest(self.release)
        self.assertEqual(len(tasks), 701)
        self.assertEqual(sum(len(task.subtask_ids) for task in tasks), 4_850)

    def test_release_contract_rejects_subset_wrong_revision_and_reordered_ids(self):
        subset = dict(self.release)
        subset["tasks"] = subset["tasks"][:-1]
        subset["task_count"] = 700
        with self.assertRaises(IntegrityError):
            validate_release_task_manifest(relock(subset))

        revision = dict(self.release)
        revision["data_revision"] = "0" * 40
        with self.assertRaises(IntegrityError):
            validate_release_task_manifest(relock(revision))

        reordered = dict(self.release)
        reordered["tasks"] = list(reordered["tasks"])
        reordered["tasks"][0], reordered["tasks"][1] = (
            reordered["tasks"][1],
            reordered["tasks"][0],
        )
        with self.assertRaises(IntegrityError):
            validate_release_task_manifest(relock(reordered))

    def test_release_contract_rejects_source_and_subtask_drift(self):
        source = dict(self.release)
        source["source_files"] = {
            key: dict(value) for key, value in source["source_files"].items()
        }
        source["source_files"]["progressive_search"]["sha256"] = "0" * 64
        with self.assertRaises(IntegrityError):
            validate_release_task_manifest(relock(source))

        subtasks = dict(self.release)
        subtasks["tasks"] = [dict(task) for task in subtasks["tasks"]]
        subtasks["tasks"][0]["subtask_ids"] = subtasks["tasks"][0][
            "subtask_ids"
        ][:-1]
        with self.assertRaises(IntegrityError):
            validate_release_task_manifest(relock(subtasks))

    def test_release_contract_rejects_ordinal_search_runner_id_substitution(self):
        substituted = deepcopy(self.release)
        search_task = next(
            task
            for task in substituted["tasks"]
            if task["domain"] == "progressive_search"
        )
        search_task["metadata"]["official_query_id"] = "0"
        with self.assertRaisesRegex(IntegrityError, "official_query_id ordering"):
            validate_release_task_manifest(relock(substituted))

        source = deepcopy(self.release)
        source["search_runner_ids_source"]["ordered_ids_sha256"] = "0" * 64
        with self.assertRaisesRegex(IntegrityError, "search_runner_ids_source"):
            validate_release_task_manifest(relock(source))

    def test_small_manifests_require_explicit_fixture_and_production_rejects_them(self):
        task = TaskSpec("fixture/one", "fixture", ("q1",), "a" * 64)
        fixture = {
            "schema_version": 1,
            "benchmark_name": "MemoryArena Public",
            "test_fixture": True,
            "task_count": 1,
            "tasks": [task.to_manifest_entry()],
        }
        self.assertEqual(validate_task_manifest(fixture), (task,))
        with self.assertRaises(IntegrityError):
            validate_release_task_manifest(fixture)

        unmarked = dict(fixture)
        unmarked.pop("test_fixture")
        with self.assertRaises(IntegrityError):
            validate_task_manifest(unmarked)

    def test_scoring_gate_revalidates_release_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ArtifactStore(Path(directory), "release-gate")
            bad = dict(self.release)
            bad["total_subtasks"] = 4_849
            with self.assertRaises(IntegrityError):
                audit_run(store, relock(bad))


if __name__ == "__main__":
    unittest.main()
