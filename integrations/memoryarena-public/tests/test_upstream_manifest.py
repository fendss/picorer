from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import file_sha256, locked_manifest_document  # noqa: E402
from upstream.contracts import ManifestMaterializationError, SuiteContract  # noqa: E402
from upstream.manifest import (  # noqa: E402
    materialize_locked_task_manifest,
    validate_official_locked_task_manifest,
)


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


class UpstreamManifestTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        rows = {
            "bundled_shopping": [{
                "id": 9,
                "category": "beauty",
                "questions": [f"shop-{i}" for i in range(6)],
                "answers": [{"target_asin": f"A{i}", "attributes": []} for i in range(6)],
            }],
            "progressive_search": [{
                "id": 4,
                "questions": ["first", "final"],
                "answers": ["one", "answer"],
            }],
            "group_travel_planner": [{
                "id": 12,
                "base_person": {"name": "base"},
                "questions": ["person one", "person two"],
                "answers": [[{"day": 1}], [{"day": 2}]],
            }],
            "formal_reasoning_math": [{
                "id": 7,
                "paper_name": "math-paper",
                "questions": ["prove"],
                "answers": ["proof"],
                "backgrounds": ["context"],
            }],
            "formal_reasoning_phys": [{
                "id": 3,
                "paper_name": "phys-paper",
                "questions": ["derive"],
                "answers": ["derivation"],
                "backgrounds": ["context"],
            }],
        }
        self.contracts = {}
        kinds = {
            "bundled_shopping": "shopping",
            "progressive_search": "search",
            "group_travel_planner": "travel",
            "formal_reasoning_math": "formal",
            "formal_reasoning_phys": "formal",
        }
        runners = {
            "bundled_shopping": "run_shopping.py",
            "progressive_search": "run_search.py",
            "group_travel_planner": "run_travel.py",
            "formal_reasoning_math": "run_math.py",
            "formal_reasoning_phys": "run_math.py",
        }
        for suite, suite_rows in rows.items():
            relative = f"{suite}/data.jsonl"
            path = self.root / relative
            _write_jsonl(path, suite_rows)
            self.contracts[suite] = SuiteContract(
                name=suite,
                record_kind=kinds[suite],
                data_relative_path=relative,
                data_sha256=file_sha256(path),
                data_git_oid="1" * 40,
                expected_ids=(suite_rows[0]["id"],),
                effective_config_name=f"{suite}.json",
                official_runner=runners[suite],
            )
        self.search = self.root / "browsecomp_all_jsons.jsonl"
        _write_jsonl(
            self.search,
            [{"id": 987, "question": ["first", "final"], "answer": ["one", "answer"]}],
        )
        self.asset_lock = locked_manifest_document({
            "schema_version": 1,
            "kind": "memoryarena-public-local-assets",
            "code_revision": "6cd9de14b71915e39ac742a20dc33785e14b6aab",
            "data_revision": "da1a37c8b19280e18627ca01cf368195a5e1d92e",
            "assets": {},
        })

    def test_fake_pinned_data_materializes_concrete_stable_ids(self):
        manifest = materialize_locked_task_manifest(
            self.root,
            search_task_data_path=self.search,
            local_asset_lock=self.asset_lock,
            contracts=self.contracts,
            production=False,
            expected_search_task_sha256=file_sha256(self.search),
        )
        self.assertEqual(manifest["task_count"], 5)
        self.assertEqual(manifest["total_subtasks"], 12)
        by_key = {task["task_key"]: task for task in manifest["tasks"]}
        self.assertIn("bundled_shopping/009", by_key)
        search = by_key["progressive_search/004"]
        self.assertEqual(search["metadata"]["official_query_id"], "987")
        self.assertEqual(
            search["subtask_ids"],
            ["progressive_search/004/subquery/1", "progressive_search/004/final"],
        )

    def test_official_gate_rejects_a_self_signed_subset(self):
        subset = materialize_locked_task_manifest(
            self.root,
            search_task_data_path=self.search,
            local_asset_lock=self.asset_lock,
            contracts=self.contracts,
            production=False,
            expected_search_task_sha256=file_sha256(self.search),
        )
        with self.assertRaises(ManifestMaterializationError):
            validate_official_locked_task_manifest(subset)

    def test_search_payload_matching_is_bijective_not_ordinal(self):
        rows = self.search.read_text(encoding="utf-8")
        self.search.write_text(rows + rows, encoding="utf-8")
        with self.assertRaises(ManifestMaterializationError):
            materialize_locked_task_manifest(
                self.root,
                search_task_data_path=self.search,
                local_asset_lock=self.asset_lock,
                contracts=self.contracts,
                production=False,
                expected_search_task_sha256=file_sha256(self.search),
            )


if __name__ == "__main__":
    unittest.main()
