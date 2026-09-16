from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


INTEGRATION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(INTEGRATION_ROOT))

import bootstrap  # noqa: E402


def search_base_config() -> dict:
    return {
        "task_name": "search",
        "description": "official prompt-bearing description",
        "agent": {
            "model_name": "gpt-5-mini",
            "embedding_model": "text-embedding-3-small",
            "max_iterations": 35,
            "provider": None,
        },
        "memory": {
            "use_step_memory": False,
            "memory_system_name": "mirix",
            "memory_url": "http://0.0.0.0:8000",
            "no_memory": False,
        },
        "env": {
            "env_server_url": "http://0.0.0.0:8001",
            "script_path": None,
            "timeout": 3000,
            "index_path": "env/search/shard*.index",
            "corpus_path": "env/search/corpus.jsonl",
            "mcp_url": None,
            "mcp_name": "retrieval-mcp-server",
        },
        "task_specific": {
            "query_ids": ["116"],
            "store_eval_in_memory": False,
            "data_dir": "env/search/data",
            "qrel_evidence": "topics-qrels/qrel_evidence.txt",
            "judge_model": "gpt-4.1",
        },
        "output": {"output_dir": "results/search"},
    }


def shopping_base_config() -> dict:
    return {
        "task_name": "shopping",
        "agent": {
            "model_name": "gpt-5-mini",
            "base_url": "http://provider.invalid",
        },
        "memory": {
            "memory_system_name": "bm25",
            "server_url": "http://0.0.0.0:8000",
        },
        "env": {"env_server_url": "http://0.0.0.0:8005"},
        "task_specific": {"task_category": "example", "task_file_limit": 1},
        "output": {"output_dir": "results/shopping"},
    }


def travel_base_config() -> dict:
    return {
        "task_name": "travel",
        "agent": {
            "model_name": "gpt-5-mini",
            "base_url": "http://provider.invalid",
        },
        "memory": {
            "memory_system_name": "bm25",
            "server_url": "http://0.0.0.0:8000",
        },
        "env": {"env_server_url": "http://0.0.0.0:8005"},
        "output": {
            "output_dir": "results/travel",
            "log_dir": "results/travel/logs",
            "global_csv": "results/travel/global.csv",
        },
    }


def formal_base_config(hf_config: str = "formal_reasoning_math") -> dict:
    return {
        "task_name": "math",
        "description": "official math task",
        "agent": {
            "model_name": "gpt-5-mini",
            "temperature": 0.0,
            "max_tokens": 8192,
            "backend": "openai",
            "base_url": "http://provider.invalid",
        },
        "memory": {
            "session_wise_memory": True,
            "judge_result_in_memory": False,
            "memory_system_name": "bm25",
            "base_url": "http://0.0.0.0:8000",
            "timeout": 300,
        },
        "env": {
            "env_name": "math",
            "base_url": "http://0.0.0.0:8001",
            "timeout": 300,
            "env_config": {
                "model_name": "gpt-5-mini",
                "temperature": 1.0,
                "max_tokens": 4096,
                "backend": "openai",
                "base_url": "http://provider.invalid",
                "max_steps": 10,
            },
        },
        "task_specific": {
            "max_steps": 10,
            "auto_eval_after_run": True,
            "dataset": {
                "hf_dataset": "ZexueHe/memoryarena",
                "hf_config": hf_config,
                "hf_split": "test",
            },
        },
        "output": {"json_output_dir": "results/json/math"},
    }


def run_git(cwd: Path, *args: str) -> str:
    process = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return process.stdout.strip()


class ConfigBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pins = bootstrap.load_pins()
        cls.data_revision = cls.pins["data"]["public_tasks"]["revision"]
        cls.manifest, cls.manifest_path = bootstrap.load_task_manifest(
            cls.pins,
            data_revision=cls.data_revision,
        )

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def load_overlay(self, relative: str) -> dict:
        return json.loads((INTEGRATION_ROOT / relative).read_text(encoding="utf-8"))

    def test_search_selection_expands_to_all_221_ids_only(self):
        base = search_base_config()
        effective, changed = bootstrap.apply_overlay(
            base,
            self.load_overlay("overlays/progressive-search.picorer.json"),
            self.manifest,
            run_dir=self.root / "run",
            memory_backend="picorer",
            memory_url="http://127.0.0.1:3111",
        )
        expected = bootstrap.search_runner_ids()
        self.assertEqual(effective["task_specific"]["query_ids"], expected)
        self.assertEqual(expected[:3], ["454", "1235", "639"])
        self.assertEqual(expected[116], "1233")
        self.assertEqual(expected[-1], "366")
        self.assertEqual(len(set(expected)), 221)
        self.assertEqual(effective["agent"], base["agent"])
        self.assertEqual(effective["task_specific"]["judge_model"], "gpt-4.1")
        self.assertIn("task_specific.query_ids", changed)
        self.assertEqual(base["task_specific"]["query_ids"], ["116"])

    def test_only_pure_infrastructure_endpoint_can_be_overridden(self):
        base = search_base_config()
        effective, _ = bootstrap.apply_overlay(
            base,
            self.load_overlay("overlays/progressive-search.picorer.json"),
            self.manifest,
            run_dir=self.root / "run",
            memory_backend="picorer",
            memory_url="http://127.0.0.1:3111",
            infra_overrides={
                "progressive_search": {
                    "env.env_server_url": "http://127.0.0.1:8001",
                    "env.mcp_url": "http://127.0.0.1:8123",
                },
            },
        )
        self.assertEqual(effective["env"]["env_server_url"], "http://127.0.0.1:8001")
        self.assertEqual(effective["env"]["mcp_url"], "http://127.0.0.1:8123")
        with self.assertRaises(bootstrap.ConfigBoundaryError):
            bootstrap.apply_overlay(
                base,
                self.load_overlay("overlays/progressive-search.picorer.json"),
                self.manifest,
                run_dir=self.root / "run",
                memory_backend="picorer",
                memory_url="http://127.0.0.1:3111",
                infra_overrides={
                    "progressive_search": {"agent.model_name": "gpt-other"}
                },
            )

    def test_infrastructure_override_cli_is_explicitly_suite_scoped(self):
        parsed = bootstrap._parse_infra_overrides(
            [
                "bundled_shopping:env.env_server_url=http://127.0.0.1:8001",
                "progressive_search:env.env_server_url=http://127.0.0.1:8001",
                "group_travel_planner:env.env_server_url=http://127.0.0.1:8001",
                "formal_reasoning_math:env.base_url=http://127.0.0.1:8001",
                "formal_reasoning_phys:env.base_url=http://127.0.0.1:8001",
            ]
        )
        self.assertEqual(set(parsed), set(bootstrap.EXPECTED_SUITES))
        self.assertEqual(
            parsed["bundled_shopping"]["env.env_server_url"],
            "http://127.0.0.1:8001",
        )
        self.assertEqual(
            parsed["formal_reasoning_phys"]["env.base_url"],
            "http://127.0.0.1:8001",
        )

        with self.assertRaisesRegex(
            bootstrap.ConfigBoundaryError, "explicitly select one suite"
        ):
            bootstrap._parse_infra_overrides(
                ["env.env_server_url=http://127.0.0.1:8001"]
            )
        with self.assertRaisesRegex(bootstrap.ConfigBoundaryError, "Unknown.*suite"):
            bootstrap._parse_infra_overrides(
                ["all:env.env_server_url=http://127.0.0.1:8001"]
            )
        with self.assertRaisesRegex(bootstrap.ConfigBoundaryError, "Duplicate"):
            bootstrap._parse_infra_overrides(
                [
                    "bundled_shopping:env.env_server_url=http://127.0.0.1:8001",
                    "bundled_shopping:env.env_server_url=http://127.0.0.1:8002",
                ]
            )

    def test_suite_scoped_infrastructure_overrides_cover_all_five_configs(self):
        endpoint = "http://127.0.0.1:8001"
        scoped = {
            "bundled_shopping": {"env.env_server_url": endpoint},
            "progressive_search": {"env.env_server_url": endpoint},
            "group_travel_planner": {"env.env_server_url": endpoint},
            "formal_reasoning_math": {"env.base_url": endpoint},
            "formal_reasoning_phys": {"env.base_url": endpoint},
        }
        cases = {
            "bundled_shopping": (
                shopping_base_config(),
                "overlays/bundled-shopping.picorer.json",
                ("env", "env_server_url"),
            ),
            "progressive_search": (
                search_base_config(),
                "overlays/progressive-search.picorer.json",
                ("env", "env_server_url"),
            ),
            "group_travel_planner": (
                travel_base_config(),
                "overlays/group-travel.picorer.json",
                ("env", "env_server_url"),
            ),
            "formal_reasoning_math": (
                formal_base_config("formal_reasoning_math"),
                "overlays/formal-math.picorer.json",
                ("env", "base_url"),
            ),
            "formal_reasoning_phys": (
                formal_base_config("formal_reasoning_phys"),
                "overlays/formal-phys.picorer.json",
                ("env", "base_url"),
            ),
        }
        for suite, (base, overlay_path, endpoint_path) in cases.items():
            with self.subTest(suite=suite):
                original_endpoint = base[endpoint_path[0]][endpoint_path[1]]
                effective, changed = bootstrap.apply_overlay(
                    base,
                    self.load_overlay(overlay_path),
                    self.manifest,
                    run_dir=self.root / suite,
                    memory_backend="picorer",
                    memory_url="http://127.0.0.1:3111",
                    infra_overrides=scoped,
                )
                self.assertEqual(
                    effective[endpoint_path[0]][endpoint_path[1]], endpoint
                )
                self.assertNotEqual(original_endpoint, endpoint)
                self.assertEqual(
                    base[endpoint_path[0]][endpoint_path[1]], original_endpoint
                )
                self.assertIn(".".join(endpoint_path), changed)

    def test_model_prompt_steps_judge_evaluator_and_task_content_are_forbidden(self):
        forbidden = {
            "description": "changed prompt",
            "agent.model_name": "gpt-other",
            "agent.temperature": 0.5,
            "agent.max_tokens": 1,
            "task_specific.max_steps": 1,
            "task_specific.judge_model": "other-judge",
            "evaluator.path": "replacement.py",
            "task.content": "replacement task",
        }
        for path, value in forbidden.items():
            with self.subTest(path=path):
                overlay = self.load_overlay("overlays/progressive-search.picorer.json")
                overlay["patch"][path] = value
                with self.assertRaises(bootstrap.ConfigBoundaryError):
                    bootstrap.apply_overlay(
                        search_base_config(),
                        overlay,
                        self.manifest,
                        run_dir=self.root / "run",
                        memory_backend="picorer",
                        memory_url="http://127.0.0.1:3111",
                    )

    def test_output_cannot_escape_run_directory(self):
        overlay = self.load_overlay("overlays/progressive-search.picorer.json")
        overlay["patch"]["output.output_dir"] = "${RUN_DIR}/../escape"
        with self.assertRaises(bootstrap.ConfigBoundaryError):
            bootstrap.apply_overlay(
                search_base_config(),
                overlay,
                self.manifest,
                run_dir=self.root / "run",
                memory_backend="picorer",
                memory_url="http://127.0.0.1:3111",
            )

    def test_partial_or_wrong_base_overlay_is_rejected(self):
        overlay = self.load_overlay("overlays/progressive-search.picorer.json")
        del overlay["patch"]["memory.memory_url"]
        with self.assertRaises(bootstrap.ConfigBoundaryError):
            bootstrap.apply_overlay(
                search_base_config(),
                overlay,
                self.manifest,
                run_dir=self.root / "run",
                memory_backend="picorer",
                memory_url="http://127.0.0.1:3111",
            )

        overlay = self.load_overlay("overlays/progressive-search.picorer.json")
        overlay["base_config"] = "configs/web_search_configs/other.json"
        with self.assertRaises(bootstrap.ConfigBoundaryError):
            bootstrap.apply_overlay(
                search_base_config(),
                overlay,
                self.manifest,
                run_dir=self.root / "run",
                memory_backend="picorer",
                memory_url="http://127.0.0.1:3111",
            )

    def test_formal_dataset_binding_cannot_drift(self):
        base = formal_base_config()
        base["task_specific"]["dataset"]["hf_config"] = "other"
        with self.assertRaises(bootstrap.ConfigBoundaryError):
            bootstrap.apply_overlay(
                base,
                self.load_overlay("overlays/formal-math.picorer.json"),
                self.manifest,
                run_dir=self.root / "run",
                memory_backend="picorer",
                memory_url="http://127.0.0.1:3111",
            )

    def test_effective_config_is_run_scoped_and_official_file_is_unchanged(self):
        checkout = self.root / "checkout"
        base_relative = Path("configs/web_search_configs/search_task.json")
        base_path = checkout / base_relative
        base_path.parent.mkdir(parents=True)
        base_path.write_text(
            json.dumps(search_base_config(), indent=2) + "\n",
            encoding="utf-8",
        )
        run_git(checkout, "init", "--quiet")
        run_git(checkout, "config", "user.name", "Offline Test")
        run_git(checkout, "config", "user.email", "offline@example.invalid")
        run_git(checkout, "add", base_relative.as_posix())
        run_git(checkout, "commit", "--quiet", "-m", "official fixture")
        original = base_path.read_bytes()

        run_dir = self.root / "run"
        result = bootstrap.generate_effective_config(
            checkout_dir=checkout,
            run_dir=run_dir,
            overlay_path=INTEGRATION_ROOT / "overlays/progressive-search.picorer.json",
            pins=self.pins,
            task_manifest=self.manifest,
            task_manifest_path=self.manifest_path,
            data_revision=self.data_revision,
            memory_backend="picorer",
            memory_url="http://127.0.0.1:3111",
        )

        self.assertEqual(base_path.read_bytes(), original)
        self.assertEqual(run_git(checkout, "status", "--porcelain"), "")
        effective_path = Path(result["config"])
        provenance_path = Path(result["manifest"])
        self.assertTrue(effective_path.is_relative_to(run_dir.resolve()))
        self.assertTrue(provenance_path.is_relative_to(run_dir.resolve()))
        effective = json.loads(effective_path.read_text(encoding="utf-8"))
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        self.assertEqual(effective["memory"]["memory_system_name"], "picorer")
        self.assertEqual(effective["memory"]["memory_url"], "http://127.0.0.1:3111")
        self.assertEqual(provenance["code_revision"], bootstrap.EXPECTED_CODE_REVISION)
        self.assertEqual(provenance["data_revision"], self.data_revision)
        self.assertTrue(provenance["official_config_unchanged"])
        self.assertEqual(provenance["evaluator_policy"], "official_only")


if __name__ == "__main__":
    unittest.main()
