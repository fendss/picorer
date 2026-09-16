from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

import bootstrap  # noqa: E402


class PinsTests(unittest.TestCase):
    def setUp(self):
        self.pins = bootstrap.load_pins()
        self.data_revision = self.pins["data"]["public_tasks"]["revision"]

    def test_exact_code_data_and_auxiliary_revisions(self):
        self.assertEqual(
            self.pins["code"]["revision"],
            "6cd9de14b71915e39ac742a20dc33785e14b6aab",
        )
        self.assertEqual(
            self.data_revision,
            "da1a37c8b19280e18627ca01cf368195a5e1d92e",
        )
        observed = {
            name: (entry["repo_id"], entry["revision"])
            for name, entry in self.pins["data"]["auxiliary"].items()
        }
        self.assertEqual(observed, bootstrap.EXPECTED_AUXILIARY_PINS)

    def test_public_manifest_is_exactly_the_five_suites_and_701_tasks(self):
        manifest, _ = bootstrap.load_task_manifest(
            self.pins,
            data_revision=self.data_revision,
        )
        self.assertEqual(manifest["expected_total_tasks"], 701)
        self.assertEqual(manifest["suites"], bootstrap.EXPECTED_TASK_SUITES)
        ids = {
            suite: bootstrap.task_ids(manifest, suite)
            for suite in manifest["suites"]
        }
        self.assertEqual(sum(map(len, ids.values())), 701)
        self.assertEqual(ids["bundled_shopping"], list(range(150)))
        self.assertEqual(ids["progressive_search"], bootstrap.search_runner_ids())
        self.assertNotEqual(ids["progressive_search"], list(range(221)))
        self.assertEqual(ids["group_travel_planner"], list(range(1, 271)))
        self.assertEqual(ids["formal_reasoning_math"], list(range(40)))
        self.assertEqual(ids["formal_reasoning_phys"], list(range(20)))

    def test_data_revision_is_an_explicit_exact_input(self):
        with self.assertRaises(bootstrap.BoundaryError):
            bootstrap.load_task_manifest(
                self.pins,
                data_revision="0" * 40,
            )

    def test_pin_and_manifest_drift_are_rejected(self):
        changed_pins = copy.deepcopy(self.pins)
        changed_pins["code"]["revision"] = "0" * 40
        with self.assertRaises(bootstrap.BoundaryError):
            bootstrap.validate_pins(changed_pins)

        manifest_path = INTEGRATION_ROOT / "overlays/public-task-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["suites"]["progressive_search"]["id_end"] = 219
        with self.assertRaises(bootstrap.BoundaryError):
            bootstrap.validate_task_manifest(
                manifest,
                self.pins,
                data_revision=self.data_revision,
            )

    def test_five_overlay_and_official_evaluator_bindings_are_fixed(self):
        self.assertEqual(set(self.pins["overlays"]), bootstrap.EXPECTED_OVERLAYS)
        self.assertEqual(
            set(self.pins["official_execution"]),
            set(bootstrap.EXPECTED_TASK_SUITES),
        )
        for relative in self.pins["overlays"]:
            overlay = json.loads(
                (INTEGRATION_ROOT / relative).read_text(encoding="utf-8")
            )
            suite = bootstrap._validate_overlay_definition(overlay)
            self.assertIn(suite, bootstrap.EXPECTED_TASK_SUITES)

    def test_unversioned_travel_asset_is_not_misrepresented_as_pinned(self):
        asset = self.pins["data"]["unversioned_external_assets"][
            "travel_flights_csv"
        ]
        self.assertNotIn("revision", asset)
        self.assertNotIn("sha256", asset)
        self.assertEqual(
            asset["required_path"],
            "env/env_systems/travel_planner_env/database/flights/clean_Flights_2022.csv",
        )

    def test_search_qrels_are_bound_to_the_exact_upstream_git_blob(self):
        qrels = self.pins["data"]["pinned_external_assets"]["search_qrels"]
        self.assertEqual(
            qrels,
            {
                "repository": "https://github.com/texttron/BrowseComp-Plus.git",
                "revision": "046949032b0328319cc9a02663a759ec601d9402",
                "source_path": "topics-qrels/qrel_evidence.txt",
                "required_path": (
                    "env/env_systems/web_search_env/data/qrel_evidence.txt"
                ),
                "sha256": (
                    "a6f594975be57339de9e4e9f67f13c044f647feda77c0b84c45a1581e3041bd1"
                ),
                "git_blob": "d99a06aeb30dcf0dd9c41003c2bca8d775e4519c",
                "line_count": 5064,
                "query_id_count": 830,
                "locked_query_row_count": 1357,
            },
        )


if __name__ == "__main__":
    unittest.main()
