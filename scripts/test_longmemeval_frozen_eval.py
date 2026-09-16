import importlib.util
import hashlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path


if importlib.util.find_spec("tqdm") is None:
    tqdm_module = types.ModuleType("tqdm")
    tqdm_module.tqdm = lambda *args, **kwargs: None
    sys.modules["tqdm"] = tqdm_module


MODULE_PATH = Path(__file__).with_name("longmemeval_frozen_eval.py")
SPEC = importlib.util.spec_from_file_location("longmemeval_frozen_eval", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
EVAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVAL)


def fixture() -> dict:
    memory = {
        "memoryId": "m-1",
        "contentHash": "hash-1",
        "role": "user",
        "content": "source fact",
        "metadata": {},
    }
    return {
        "results": [
            {
                "question_id": "q-1",
                "retrieval": {
                    "scopeId": "scope-1",
                    "question": "What was selected?",
                    "searchedMemories": [memory],
                    "evidence": [memory],
                    "citations": [
                        {"memoryId": "m-1", "supports": "the selected fact"}
                    ],
                    "status": "sufficient",
                    "evidenceSummary": "One source fact was selected.",
                },
            }
        ]
    }


class FrozenInputPreparationTest(unittest.TestCase):
    def prepare(self, *, selection: bool = False) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "results.json"
            output = root / "input.json"
            source.write_text(json.dumps(fixture()), encoding="utf-8")
            EVAL.prepare_frozen_input(
                source,
                output,
                include_selection_data=selection,
            )
            return json.loads(output.read_text(encoding="utf-8"))

    def test_selection_data_is_explicit_and_gold_isolated(self) -> None:
        prepared = self.prepare(selection=True)
        self.assertTrue(prepared["selection_data_present"])
        self.assertFalse(prepared["gold_fields_present"])
        self.assertFalse(prepared["original_answer_fields_present"])
        record = prepared["records"][0]
        self.assertIn("selection_package", record)
        self.assertIn("selected_memories", record)
        self.assertIn("selection_data_hash", record)
        EVAL.validate_reanswer_source(prepared, "selection-aware-v3")
        with self.assertRaisesRegex(ValueError, "without selection data"):
            EVAL.validate_reanswer_source(prepared, "exact-searched-memories")

    def test_exact_input_contains_no_selection_data(self) -> None:
        prepared = self.prepare()
        self.assertNotIn("selection_data_present", prepared)
        self.assertNotIn("evidence_packages_present", prepared)
        EVAL.validate_reanswer_source(prepared, "exact-searched-memories")
        with self.assertRaisesRegex(ValueError, "requires prepared selection data"):
            EVAL.validate_reanswer_source(prepared, "selection-aware-v3")


class PromptContractTest(unittest.TestCase):
    def test_model_identity_accepts_only_exact_or_dated_snapshot(self) -> None:
        self.assertTrue(EVAL.returned_model_matches("gpt-5.4", "gpt-5.4"))
        self.assertTrue(
            EVAL.returned_model_matches("gpt-5.4", "gpt-5.4-2026-08-20")
        )
        self.assertFalse(
            EVAL.returned_model_matches("gpt-5.4", "gpt-5.4-mini")
        )

    def test_answer_prompt_matches_ldbd_contract(self) -> None:
        self.assertEqual(
            hashlib.sha256(EVAL.ANSWER_PROMPT.encode()).hexdigest(),
            "ecfb93382f47ef1fc23d284182a0e49fca7e9a8cb4046ce2f51daadb110e29a5",
        )
        self.assertIs(EVAL.SELECTION_V3_ANSWER_PROMPT, EVAL.ANSWER_PROMPT)

    def test_selection_payload_preserves_the_gold_isolated_retrieval_package(self) -> None:
        prepared = FrozenInputPreparationTest().prepare(selection=True)
        prompt = EVAL.answer_prompt(prepared["records"][0], "selection-aware-v3")
        self.assertIn("<retrieval_package>", prompt)
        self.assertIn("One source fact was selected.", prompt)
        self.assertIn("source fact", prompt)
        self.assertNotIn("gold_answer", prompt)

    def test_judge_prompt_matches_ldbd_contract(self) -> None:
        self.assertEqual(
            hashlib.sha256(EVAL.JUDGE_PROMPT.encode()).hexdigest(),
            "44b751660e4e0950ee640b14207a0ab7d519c4558374d429b6bf262d9871d6ff",
        )

    def test_refind_judge_prompt_and_verdict_contract(self) -> None:
        self.assertIn(
            "Be generous: if the generated answer contains the gold answer information",
            EVAL.REFIND_2026_JUDGE_PROMPT,
        )
        self.assertEqual(
            EVAL.parse_refind_label("The content matches. CORRECT"),
            "CORRECT",
        )
        self.assertEqual(
            EVAL.parse_refind_label("This is WRONG, not CORRECT."),
            "WRONG",
        )
        self.assertEqual(EVAL.parse_refind_label("unclear"), "WRONG")


if __name__ == "__main__":
    unittest.main()
