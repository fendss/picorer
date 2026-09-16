from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import file_sha256, locked_manifest_document  # noqa: E402
from upstream.contracts import (  # noqa: E402
    EXPECTED_SUITE_COUNTS,
    EXPECTED_SUBTASK_TOTAL,
    EXPECTED_TASK_TOTAL,
    OFFICIAL_CODE_REVISION,
    PUBLIC_DATA_REVISION,
    EvaluatorMaterializationError,
)
from upstream.evaluator import (  # noqa: E402
    _judge_usage_coverage,
    _reset_wrapper_owned_csv,
    _run_stage,
    _validate_formal_evaluator_input,
    _validate_formal_evaluator_output,
    _validate_materialized_input_files,
    _validate_travel_submission,
    _validate_travel_csv,
    run_official_evaluators,
)
from upstream.executor import PRODUCTION_SEAM_BUNDLE_SHA256  # noqa: E402


class _FakeStore:
    def __init__(self, run_dir, run_id, price_table=None):
        self.run_dir = Path(run_dir)
        self.indexes_dir = self.run_dir / "indexes"

    def load_manifests(self):
        return {}, {}


class _FakeProxy:
    def __init__(self, **kwargs):
        self.url = "http://127.0.0.1:1/v1"
        self.events = (
            {
                "cache": "miss",
                "status_code": 200,
                "billed_this_request": True,
                "usage_present": True,
                "usage_normalized": True,
            },
        )

    def start(self):
        return self

    def close(self):
        return None


class UpstreamEvaluatorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def _input_plan(self) -> tuple[Path, dict]:
        input_root = self.root / "inputs"
        result = input_root / "shopping/run/step_results/item.json"
        result.parent.mkdir(parents=True)
        result.write_text('{"result":true}\n', encoding="utf-8")
        plan = locked_manifest_document(
            {
                "schema_version": 1,
                "kind": "memoryarena-public-official-evaluator-inputs",
                "run_id": "run-1",
                "code_revision": OFFICIAL_CODE_REVISION,
                "data_revision": PUBLIC_DATA_REVISION,
                "production_seam_bundle_sha256": PRODUCTION_SEAM_BUNDLE_SHA256,
                "task_count": EXPECTED_TASK_TOTAL,
                "subtask_count": EXPECTED_SUBTASK_TOTAL,
                "suite_counts": dict(EXPECTED_SUITE_COUNTS),
                "files": [
                    {
                        "path": "shopping/run/step_results/item.json",
                        "size": result.stat().st_size,
                        "sha256": file_sha256(result),
                    }
                ],
                "official_evaluators": {
                    "bundled_shopping": {
                        "script": "shopping.py",
                        "input": "shopping/run",
                        "product_catalog": "catalog",
                        "domain_data": "domain.json",
                    },
                    "progressive_search": {
                        "script": "search.py",
                        "input": "progressive_search/input",
                        "ground_truth": "ground.jsonl",
                        "qrel_evidence": "qrels.txt",
                    },
                    "group_travel_planner": {
                        "combiner": "combine.py",
                        "evaluator": "travel.py",
                        "input": "group_travel_planner/generated",
                    },
                    "formal_reasoning_math": {
                        "evaluator": "formal.py",
                        "input": "formal_reasoning_math",
                    },
                    "formal_reasoning_phys": {
                        "evaluator": "formal.py",
                        "input": "formal_reasoning_phys",
                    },
                },
                "scoring_performed": False,
            }
        )
        (input_root / "evaluator-plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
        return input_root, plan

    def test_materialized_input_tamper_extra_file_and_symlink_are_rejected(self):
        input_root, plan = self._input_plan()
        target = input_root / "shopping/run/step_results/item.json"
        _validate_materialized_input_files(plan, input_root)

        target.write_text("tampered\n", encoding="utf-8")
        with self.assertRaisesRegex(EvaluatorMaterializationError, "drift"):
            _validate_materialized_input_files(plan, input_root)

        target.write_text('{"result":true}\n', encoding="utf-8")
        extra = input_root / "shopping/run/step_results/extra.json"
        extra.write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(EvaluatorMaterializationError, "inventory"):
            _validate_materialized_input_files(plan, input_root)
        extra.unlink()

        link = input_root / "shopping/run/step_results/link.json"
        link.symlink_to(target)
        with self.assertRaisesRegex(EvaluatorMaterializationError, "symlink"):
            _validate_materialized_input_files(plan, input_root)

    def test_travel_resume_rebuilds_one_complete_csv_row(self):
        script = self.root / "travel_eval.py"
        script.write_text(
            "import argparse, csv, os\n"
            "p=argparse.ArgumentParser(); p.add_argument('--global_csv'); a=p.parse_args()\n"
            "fields=['timestamp','model_name','memory_system','total_groups','PS','SPS','SR']\n"
            "row=['now','model','picorer','270','1','2','3']\n"
            "with open(a.global_csv,'a',newline='',encoding='utf-8') as h:\n"
            " w=csv.writer(h); w.writerow(fields) if h.tell()==0 else None; w.writerow(row)\n",
            encoding="utf-8",
        )
        output = self.root / "evaluation/group_travel_planner"
        csv_path = output / "global.csv"
        for invocation in range(2):
            _reset_wrapper_owned_csv(csv_path, output)
            _run_stage(
                f"travel-{invocation}",
                [sys.executable, str(script), "--global_csv", str(csv_path)],
                checkout=self.root,
                environment=os.environ,
                log_dir=self.root / "logs",
            )
            _validate_travel_csv(csv_path, "model")
            self.assertEqual(len(csv_path.read_text(encoding="utf-8").splitlines()), 2)

        csv_path.write_text(
            "timestamp,model_name,memory_system,total_groups,PS,SPS,SR\n"
            "now,model,picorer,270,NaN,2,3\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(EvaluatorMaterializationError, "complete"):
            _validate_travel_csv(csv_path, "model")

    def test_travel_submission_requires_270_ordered_groups_and_1869_persons(self):
        submission = self.root / "travel/submission.jsonl"
        submission.parent.mkdir(parents=True)
        rows = []
        for group_id in range(1, 271):
            person_count = 6 if group_id <= 21 else 7
            rows.append(
                {
                    "id": group_id,
                    "persons": [
                        {"person_idx": person_id, "plan": None}
                        for person_id in range(1, person_count + 1)
                    ],
                    "all_results": [],
                }
            )
        submission.write_text(
            "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
        )
        _validate_travel_submission(submission)

        rows[0]["persons"][1]["person_idx"] = 1
        submission.write_text(
            "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
        )
        with self.assertRaisesRegex(EvaluatorMaterializationError, "person IDs"):
            _validate_travel_submission(submission)

    def test_raw_usage_that_cannot_normalize_is_not_complete(self):
        gaps, attempts, normalized, status = _judge_usage_coverage(
            [
                {
                    "cache": "miss",
                    "cache_key": "paid",
                    "billed_this_request": True,
                    "usage_present": True,
                    "usage_normalized": False,
                }
            ]
        )
        self.assertEqual((attempts, normalized, status), (1, 0, "unknown"))
        self.assertEqual(gaps, ["paid"])

    def test_formal_stage_requires_exact_release_rows_and_metric_coverage(self):
        suite = "formal_reasoning_math"
        work_root = self.root / "formal"
        tasks = []
        counts = [9] * 34 + [8] * 6
        for index, count in enumerate(counts):
            paper = f"paper-{index:02d}"
            tasks.append(
                {
                    "domain": suite,
                    "metadata": {"paper_name": paper},
                    "subtask_ids": [f"{paper}/{item}" for item in range(count)],
                }
            )
            result = work_root / "picorer" / paper / "result.jsonl"
            result.parent.mkdir(parents=True)
            result.write_text(
                "".join(
                    json.dumps({"query_id": item, "is_correct": True}) + "\n"
                    for item in range(count)
                ),
                encoding="utf-8",
            )

        minimum, maximum = _validate_formal_evaluator_input(
            work_root, suite, {"tasks": tasks}
        )
        self.assertEqual((minimum, maximum), (8, 9))
        output = work_root / "picorer/all_results.json"
        output.write_text(
            json.dumps(
                {
                    "overall_average_passrate": 1.0,
                    "avg_progress_score": 1.0,
                    "average_session_time": 1.0,
                    "average_memory_length": 1.0,
                    "average_task_time": 1.0,
                    "memory_length": 1.0,
                    "min_k": minimum,
                    "passrate_at_k": [1.0] * maximum,
                    "cummulative_passrate_at_k": [1.0] * maximum,
                    "passrate_at_min_k": [1.0] * minimum,
                    "cummulative_passrate_at_min_k": [1.0] * minimum,
                }
            ),
            encoding="utf-8",
        )
        _validate_formal_evaluator_output(
            output,
            suite,
            expected_min_k=minimum,
            expected_max_k=maximum,
        )

        output_value = json.loads(output.read_text(encoding="utf-8"))
        output_value["passrate_at_k"].pop()
        output.write_text(json.dumps(output_value), encoding="utf-8")
        with self.assertRaisesRegex(EvaluatorMaterializationError, "coverage"):
            _validate_formal_evaluator_output(
                output,
                suite,
                expected_min_k=minimum,
                expected_max_k=maximum,
            )

        first_result = work_root / "picorer/paper-00/result.jsonl"
        rows = first_result.read_text(encoding="utf-8").splitlines()
        duplicate_id_rows = [json.loads(row) for row in rows]
        duplicate_id_rows[1]["query_id"] = 0
        first_result.write_text(
            "".join(json.dumps(row) + "\n" for row in duplicate_id_rows),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(EvaluatorMaterializationError, "incomplete"):
            _validate_formal_evaluator_input(work_root, suite, {"tasks": tasks})

        first_result.write_text("\n".join(rows[:-1]) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(EvaluatorMaterializationError, "incomplete"):
            _validate_formal_evaluator_input(work_root, suite, {"tasks": tasks})

    def test_failed_or_incomplete_official_stage_never_publishes_final_manifest(self):
        input_root, _ = self._input_plan()
        run_root = self.root / "run"
        run_root.mkdir()
        (run_root / "run-manifest.json").write_text(
            json.dumps(
                {
                    "run_id": "run-1",
                    "runtime_execution": {"price_table_sha256": None},
                    "infrastructure": {"provider_proxy_url": "http://provider/v1"},
                }
            ),
            encoding="utf-8",
        )
        (run_root / "task-manifest.json").write_text('{"tasks":[]}\n', encoding="utf-8")

        for stage_effect in (
            EvaluatorMaterializationError("official stage failed"),
            {"stage": "bundled-shopping", "return_code": 0},
        ):
            output = self.root / ("failed" if isinstance(stage_effect, Exception) else "incomplete")
            with self.subTest(output=output.name), patch.dict(
                os.environ,
                {
                    "OPENAI_API_KEY": "test",
                    "OPENAI_BASE_URL": "http://provider/v1",
                    "OPENAI_API_BASE": "http://provider/v1",
                },
                clear=False,
            ), patch("upstream.executor._verify_checkout"), patch(
                "upstream.evaluator._validate_evaluator_asset_provenance"
            ), patch("upstream.evaluator.ArtifactStore", _FakeStore), patch(
                "upstream.evaluator.JudgeCacheProxy", _FakeProxy
            ), patch(
                "upstream.evaluator._shopping_attribution_markers", return_value=[]
            ), patch(
                "upstream.evaluator._search_attribution_markers", return_value=[]
            ), patch(
                "upstream.evaluator._run_stage",
                side_effect=(stage_effect if isinstance(stage_effect, Exception) else None),
                return_value=(None if isinstance(stage_effect, Exception) else stage_effect),
            ):
                with self.assertRaises(EvaluatorMaterializationError):
                    run_official_evaluators(
                        run_root,
                        input_root,
                        output,
                        checkout=self.root / "checkout",
                    )
            self.assertFalse((output / "official-evaluation.json").exists())


if __name__ == "__main__":
    unittest.main()
