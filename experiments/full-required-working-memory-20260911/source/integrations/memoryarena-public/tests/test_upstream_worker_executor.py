from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

from runtime.artifacts import canonical_sha256, file_sha256  # noqa: E402
from runtime.usage import (  # noqa: E402
    locked_price_table_document,
    normalize_usage,
    price_table_from_document,
)
from upstream.executor import (  # noqa: E402
    PRODUCTION_SEAM_BUNDLE_SHA256,
    _provider_error,
    _verify_effective_config_lock,
    _verify_checkout,
    _worker_provider_error,
    production_seam_identity,
)
from upstream.worker import (  # noqa: E402
    _partial_usage,
    _travel_usage_coverage,
    execute_request,
)


class UpstreamWorkerExecutorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_production_bundle_binds_every_behavioral_helper_and_descriptor(self):
        identity = production_seam_identity()
        self.assertEqual(identity["bundle_sha256"], PRODUCTION_SEAM_BUNDLE_SHA256)
        self.assertEqual(
            {entry["path"] for entry in identity["files"]},
            {
                "__init__.py", "assets.py", "audit_proxy.py", "contracts.py",
                "evaluator.py", "executor.py", "hf_source_manifests.json",
                "hydrate.py", "judge_proxy.py", "manifest.py", "prepare.py",
                "search_runner_ids.json", "worker.py",
            },
        )

    def test_provider_markers_are_typed_before_missing_output_integrity(self):
        cases = [
            ("HTTP 429 rate limit", 429),
            ("request timed out", 408),
            ("status_code=503 unavailable", 503),
            ("HTTP 401 unauthorized", 401),
            ('{"status": 403, "error": "forbidden"}', 403),
            ("HTTP status 404 model not found", 404),
            ("status_code=400 bad request", 400),
            ("HTTP 425 too early", 425),
        ]
        for text, status in cases:
            with self.subTest(text=text):
                error = _provider_error(text, stage="official")
                self.assertIsNotNone(error)
                self.assertEqual(error.status_code, status)
        self.assertIsNone(_provider_error("JSON decode error at position 401", stage="official"))

    def test_successful_worker_output_is_not_reclassified_from_log_text(self):
        response = {"status": "ok", "error": "", "swallowed_errors": []}
        self.assertIsNone(
            _worker_provider_error(
                response,
                0,
                "answer: the request timeout is 30 seconds; stay within rate limit",
                "",
            )
        )
        self.assertIsNotNone(
            _worker_provider_error(
                {"status": "infra_error", "error": "request timed out"},
                1,
                "",
                "",
            )
        )

    def test_effective_config_cannot_be_resigned_after_run_lock(self):
        config = self.root / "formal_reasoning.json"
        provenance = self.root / "formal_reasoning.manifest.json"
        config.write_text(json.dumps({"agent": {"model_name": "official"}}))
        provenance.write_text(json.dumps({"effective_config_sha256": file_sha256(config)}))
        locked = {
            "effective_config_sha256": file_sha256(config),
            "provenance_sha256": file_sha256(provenance),
        }
        _verify_effective_config_lock(config, provenance, locked)

        config.write_text(json.dumps({"agent": {"model_name": "substituted"}}))
        provenance.write_text(json.dumps({"effective_config_sha256": file_sha256(config)}))
        with self.assertRaisesRegex(Exception, "differs from locked run manifest"):
            _verify_effective_config_lock(config, provenance, locked)

    def test_nested_dotenv_provider_override_is_rejected(self):
        checkout = self.root / "checkout"
        (checkout / ".git").mkdir(parents=True)
        nested = checkout / "search_agent"
        nested.mkdir()
        (nested / ".env.local").write_text("OPENAI_BASE_URL=http://bypass\n")

        def fake_git(_checkout, args):
            if args == ["remote", "get-url", "origin"]:
                return "https://github.com/ZexueHe/MemoryArena.git"
            if args == ["rev-parse", "HEAD"]:
                return "6cd9de14b71915e39ac742a20dc33785e14b6aab"
            if args == ["status", "--porcelain", "--untracked-files=no"]:
                return ""
            raise AssertionError(args)

        with patch("upstream.executor._run_git", side_effect=fake_git):
            with self.assertRaisesRegex(Exception, "dotenv"):
                _verify_checkout(checkout)

    def test_travel_usage_does_not_promote_local_cost_estimate(self):
        output = self.root / "travel-output"
        stats = output / "stats_results"
        stats.mkdir(parents=True)
        (stats / "usage_stats.json").write_text(
            json.dumps(
                {
                    "total_input_tokens": 120,
                    "total_output_tokens": 30,
                    "total_cost": 99.0,
                    "call_count": 4,
                }
            ),
            encoding="utf-8",
        )
        config = self.root / "travel-config.json"
        config.write_text(
            json.dumps({"agent": {"model_name": "priced-model"}}),
            encoding="utf-8",
        )

        events = _partial_usage(
            {"suite": "group_travel_planner", "config": str(config)}, output
        )

        self.assertEqual(len(events), 1)
        self.assertEqual(
            events[0]["usage"], {"input_tokens": 120, "output_tokens": 30}
        )
        self.assertNotIn("cost_usd", events[0]["usage"])
        self.assertEqual(events[0]["raw"]["total_cost"], 99.0)
        unpriced = normalize_usage(events[0]["usage"], model="priced-model")
        self.assertIsNone(unpriced.cost_usd)
        table = price_table_from_document(
            locked_price_table_document(
                {
                    "priced-model": {
                        "input": 2.0,
                        "output": 8.0,
                        "cache_read": 0.5,
                        "cache_write": 3.0,
                    }
                }
            )
        )
        priced = normalize_usage(
            events[0]["usage"], model="priced-model", price_table=table
        )
        self.assertAlmostEqual(priced.cost_usd, 0.00048)
        self.assertTrue(priced.price_source.startswith("price-table:"))

    def test_travel_coverage_requires_external_attempt_reconciliation(self):
        coverage = _travel_usage_coverage()
        self.assertEqual(coverage["status"], "partial")
        self.assertIn("provider-attempt denominator", coverage["official-agent"])
        self.assertTrue(coverage["gaps"])

    def test_search_judge_parse_error_is_accepted_without_resampling(self):
        checkout = self.root / "checkout"
        checkout.mkdir()
        (checkout / "run_search.py").write_text(
            "# checkout identity sentinel\n", encoding="utf-8"
        )
        output = self.root / "official"
        query_id = "4"
        judgement = {
            "extracted_final_answer": None,
            "reasoning": None,
            "correct": None,
            "confidence": None,
            "parse_error": True,
        }
        calls = []
        fake_run_search = ModuleType("run_search")
        fake_run_search.uuid = None

        def fake_main():
            calls.append(tuple(sys.argv))
            raw_directories = [
                output / f"query_{query_id}" / "subqueries" / "subquery_1",
                output / f"query_{query_id}" / "final_query",
            ]
            for directory in raw_directories:
                directory.mkdir(parents=True)
                (directory / "response.json").write_text("{}", encoding="utf-8")
            summary = {
                "query_ids": [query_id],
                "summary": {"accuracy": 0.0},
                "per_query": {
                    query_id: {
                        "summary": {"accuracy": 0.0},
                        "result": {"judgement": judgement},
                    }
                },
            }
            (output / f"query_{query_id}_result.json").write_text(
                json.dumps(summary), encoding="utf-8"
            )

        fake_run_search.main = fake_main
        record = {"id": 4, "questions": ["subquery", "final query"]}
        record_path = self.root / "record.json"
        record_path.write_text(json.dumps(record), encoding="utf-8")
        config = self.root / "config.json"
        config.write_text(
            json.dumps({"agent": {"model_name": "fake"}}), encoding="utf-8"
        )
        request_path = self.root / "request.json"
        response_path = self.root / "response.json"
        worker_path = INTEGRATION_ROOT / "upstream/worker.py"
        provider_url = "http://127.0.0.1:9999/v1"
        request_path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "suite": "progressive_search",
                    "checkout": str(checkout),
                    "output_dir": str(output),
                    "config": str(config),
                    "record": str(record_path),
                    "source_record_hash": canonical_sha256(record),
                    "official_query_id": query_id,
                    "memory_scope": "run/task/attempt-1",
                    "seam_bundle_sha256": "a" * 64,
                    "worker_sha256": file_sha256(worker_path),
                    "provider_proxy_url": provider_url,
                }
            ),
            encoding="utf-8",
        )

        try:
            with patch.dict(
                os.environ,
                {"OPENAI_BASE_URL": provider_url, "OPENAI_API_BASE": provider_url},
            ), patch.dict(sys.modules, {"run_search": fake_run_search}):
                self.assertEqual(execute_request(request_path, response_path), 0)
        finally:
            if str(checkout) in sys.path:
                sys.path.remove(str(checkout))

        response = json.loads(response_path.read_text(encoding="utf-8"))
        self.assertEqual(len(calls), 1)
        self.assertEqual(response["status"], "ok")
        self.assertEqual(response["completed_count"], 2)
        result = response["result"]
        self.assertEqual(result["summary"]["accuracy"], 0.0)
        self.assertEqual(
            result["per_query"][query_id]["result"]["judgement"], judgement
        )

    def test_fake_pinned_formal_checkout_runs_one_inner_task_group(self):
        checkout = self.root / "checkout"
        checkout.mkdir()
        (checkout / "run_search.py").write_text("# checkout identity sentinel\n", encoding="utf-8")
        (checkout / "run_math.py").write_text(
            "CALLS = 0\n"
            "uuid = None\n"
            "def run_task_with_memory_and_env(config, tasks, paper):\n"
            "    global CALLS\n"
            "    CALLS += 1\n"
            "    return [{'query_id': i, 'judge_result': {'is_correct': False}, "
            "             'memory_user_id': str(uuid.uuid4())} for i, _ in enumerate(tasks)]\n",
            encoding="utf-8",
        )
        record = {
            "id": 3,
            "paper_name": "paper",
            "questions": ["q1", "q2"],
            "answers": ["a1", "a2"],
            "backgrounds": ["b1", "b2"],
        }
        record_path = self.root / "record.json"
        record_path.write_text(json.dumps(record), encoding="utf-8")
        config = self.root / "config.json"
        config.write_text(json.dumps({"agent": {"model_name": "fake"}}), encoding="utf-8")
        output = self.root / "official"
        request_path = self.root / "request.json"
        response_path = self.root / "response.json"
        worker_path = INTEGRATION_ROOT / "upstream/worker.py"
        request_path.write_text(json.dumps({
            "schema_version": 1,
            "suite": "formal_reasoning_math",
            "checkout": str(checkout),
            "output_dir": str(output),
            "config": str(config),
            "record": str(record_path),
            "source_record_hash": canonical_sha256(record),
            "memory_scope": "run/task/retry-2",
            "seam_bundle_sha256": "a" * 64,
            "worker_sha256": file_sha256(worker_path),
            "provider_proxy_url": "http://127.0.0.1:9999/v1",
        }), encoding="utf-8")
        try:
            prior = {
                name: os.environ.get(name)
                for name in ("OPENAI_BASE_URL", "OPENAI_API_BASE")
            }
            os.environ["OPENAI_BASE_URL"] = "http://127.0.0.1:9999/v1"
            os.environ["OPENAI_API_BASE"] = "http://127.0.0.1:9999/v1"
            self.assertEqual(execute_request(request_path, response_path), 0)
            response = json.loads(response_path.read_text(encoding="utf-8"))
            self.assertEqual(response["completed_count"], 2)
            self.assertEqual(response["seam_bundle_sha256"], "a" * 64)
            ids = [row["memory_user_id"] for row in response["result"]["logs"]]
            self.assertEqual(ids, [
                "run/task/retry-2::formal-1",
                "run/task/retry-2::formal-2",
            ])
            import run_math

            self.assertEqual(run_math.CALLS, 1)
        finally:
            for name, value in prior.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
            sys.modules.pop("run_math", None)
            if str(checkout) in sys.path:
                sys.path.remove(str(checkout))


if __name__ == "__main__":
    unittest.main()
