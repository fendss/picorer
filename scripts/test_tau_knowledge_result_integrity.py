import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "integrations"
    / "tau-knowledge"
    / "result_integrity.py"
)
SPEC = importlib.util.spec_from_file_location("tau_result_integrity", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
integrity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(integrity)


class TauKnowledgeResultIntegrityTests(unittest.TestCase):
    def test_method_execution_contract_excludes_only_infrastructure_controls(self):
        baseline = {
            "picorer_max_input_ms": 900_000,
            "picorer_max_turns_per_input": 64,
            "picorer_max_tool_calls_per_input": 128,
            "bridge_response_timeout_seconds": 930.0,
            "slots": 4,
            "infra_resume_rounds": 2,
        }
        infrastructure_change = {**baseline, "slots": 16, "infra_resume_rounds": 8}
        method_change = {**baseline, "picorer_max_turns_per_input": 1}

        self.assertEqual(
            integrity.method_execution_contract(baseline),
            integrity.method_execution_contract(infrastructure_change),
        )
        self.assertNotEqual(
            integrity.method_execution_contract(baseline),
            integrity.method_execution_contract(method_change),
        )

    def simulations(self, reason="user_stop", with_reward=True):
        seeds = integrity.trial_seeds(300, 2)
        rows = []
        for trial, seed in enumerate(seeds):
            rows.append(
                {
                    "task_id": "task-a",
                    "trial": trial,
                    "seed": seed,
                    "termination_reason": reason,
                    "reward_info": {"reward": 1.0} if with_reward else None,
                    "messages": [
                        {"role": "assistant", "raw_data": None},
                        {"role": "user", "raw_data": {"model": "gpt-user"}},
                        {
                            "role": "assistant",
                            "raw_data": {
                                "model": {"responseModel": "gpt-agent"}
                            },
                        },
                    ],
                }
            )
        return rows

    def report(self, simulations):
        return integrity.build_validity_report(
            tasks=[{"id": "task-a"}],
            simulations=simulations,
            num_trials=2,
            seed=300,
            expected_agent_model="gpt-agent",
            expected_user_model="gpt-user",
        )

    def test_accepts_exactly_one_evaluated_result_per_trial(self):
        report = self.report(self.simulations())
        self.assertTrue(report["valid"])
        self.assertEqual(report["evaluated_simulation_count"], 2)

    def test_infrastructure_error_is_retryable_not_a_score(self):
        rows = self.simulations()
        rows[1]["termination_reason"] = "infrastructure_error"
        rows[1]["reward_info"] = None
        report = self.report(rows)
        self.assertFalse(report["valid"])
        self.assertTrue(report["retryable_infrastructure_only"])
        self.assertEqual(report["evaluated_simulation_count"], 1)

    def test_rejects_duplicate_or_missing_trial(self):
        rows = self.simulations()
        rows[1] = dict(rows[0])
        report = self.report(rows)
        self.assertFalse(report["valid"])
        self.assertFalse(report["retryable_infrastructure_only"])
        self.assertEqual(len(report["duplicates"]), 1)
        self.assertEqual(len(report["missing"]), 1)

    def test_rejects_non_infrastructure_result_without_reward(self):
        report = self.report(self.simulations(with_reward=False))
        self.assertFalse(report["valid"])
        self.assertEqual(report["missing_reward_count"], 2)

    def test_rejects_response_model_alias_mismatch(self):
        rows = self.simulations()
        rows[0]["messages"][1]["raw_data"]["model"] = "not-the-user-model"
        report = self.report(rows)
        self.assertFalse(report["valid"])
        self.assertEqual(len(report["response_model_mismatches"]), 1)

    def test_accepts_dated_snapshot_of_expected_alias(self):
        rows = self.simulations()
        rows[0]["messages"][1]["raw_data"]["model"] = "gpt-user-2025-12-11"
        report = self.report(rows)
        self.assertTrue(report["valid"])
        self.assertEqual(
            report["response_models"]["user"],
            {"gpt-user": 1, "gpt-user-2025-12-11": 1},
        )

    def test_locates_and_hashes_nested_tau_results(self):
        with tempfile.TemporaryDirectory() as directory:
            save_to = Path(directory) / "results.json"
            save_to.mkdir()
            nested = save_to / "results.json"
            nested.write_bytes(b"official-result")
            self.assertEqual(integrity.locate_results_file(save_to), nested)
            self.assertEqual(
                integrity.sha256_file(nested),
                "a6eba0c19a2d8d34b045e450853b3ed1607faded1af2b07c81c5b761f5921b99",
            )


if __name__ == "__main__":
    unittest.main()
