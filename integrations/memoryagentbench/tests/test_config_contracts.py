from __future__ import annotations

import sys
import unittest
import hashlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mab_adapter.config import TASKS, task_config  # noqa: E402
from mab_adapter.contracts import ContractError, parse_context  # noqa: E402


class ConfigContractTests(unittest.TestCase):
    def test_supported_set_includes_small_and_official_large_variants(self):
        self.assertEqual(
            set(TASKS),
            {
                "ruler-qa1",
                "longmemeval-s",
                "trec-coarse",
                "trec-fine",
                "banking77",
                "nlu",
                "clinic150",
                "fact-sh-6k",
                "fact-mh-6k",
                "fact-sh-262k",
                "fact-mh-262k",
                "eventqa-64k",
                "eventqa-full",
            },
        )
        self.assertEqual(sum(task.expected_questions for task in TASKS.values()), 2300)

    def test_official_large_amb10_totals_1600_queries(self):
        official_tasks = {
            "fact-mh-262k",
            "fact-sh-262k",
            "eventqa-full",
            "trec-fine",
            "trec-coarse",
            "banking77",
            "nlu",
            "clinic150",
            "ruler-qa1",
            "longmemeval-s",
        }
        self.assertEqual(len(official_tasks), 10)
        self.assertEqual(
            sum(TASKS[task_id].expected_questions for task_id in official_tasks),
            1600,
        )

    def test_icl_templates_keep_literal_label_placeholder(self):
        for task_id in ("trec-coarse", "trec-fine", "banking77", "nlu", "clinic150"):
            with self.subTest(task=task_id):
                query = task_config(task_id).format_query("Where is Paris?")
                self.assertIn('"label: {label}"', query)
                self.assertIn("Where is Paris?", query)

    def test_memorize_template_is_task_owned_and_formats_context(self):
        value = task_config("eventqa-64k").format_memory(
            "Book text", "2026-01-02 03:04:05"
        )
        self.assertIn("book excerpt", value)
        self.assertIn("Book text", value)
        self.assertIn("2026-01-02 03:04:05", value)

    def test_templates_match_the_pinned_upstream_commit(self):
        expected = {
            "ruler-qa1": (
                "e259f07c9614a51414e34994290833d2e68933f24571244e369d1c866e7827ea",
                "b5f2635f91e72299f68887beff5ec830b9df4892bdd153751203cd16b264a82c",
            ),
            "longmemeval-s": (
                "f7ee965f1274daa8d1a2f63de3ff9469bb663aeea0bab4c5a040a304a64f903f",
                "c87c1944485880dc48b340cb9f2153aad267e5f63693c7e4a62c6f17a2156eac",
            ),
            "trec-coarse": (
                "99cc2293d1fb033006966a576d0bd6bd650b1176855d7a30c62bc4ffe217b71c",
                "88465e240fc669df9f58cc49ea221abd6183c0957e1f1f480ae24132e9485a49",
            ),
            "trec-fine": (
                "99cc2293d1fb033006966a576d0bd6bd650b1176855d7a30c62bc4ffe217b71c",
                "88465e240fc669df9f58cc49ea221abd6183c0957e1f1f480ae24132e9485a49",
            ),
            "banking77": (
                "99cc2293d1fb033006966a576d0bd6bd650b1176855d7a30c62bc4ffe217b71c",
                "88465e240fc669df9f58cc49ea221abd6183c0957e1f1f480ae24132e9485a49",
            ),
            "nlu": (
                "99cc2293d1fb033006966a576d0bd6bd650b1176855d7a30c62bc4ffe217b71c",
                "88465e240fc669df9f58cc49ea221abd6183c0957e1f1f480ae24132e9485a49",
            ),
            "clinic150": (
                "99cc2293d1fb033006966a576d0bd6bd650b1176855d7a30c62bc4ffe217b71c",
                "88465e240fc669df9f58cc49ea221abd6183c0957e1f1f480ae24132e9485a49",
            ),
            "fact-sh-6k": (
                "7fb298c148aeea82bb4029b7bd4a55489a9ae5e02ed85ee910d60b1ad33482a6",
                "16dfd7ef2a32eb12197672ebfda42145602a6d214492e0a1f2f629694495f0da",
            ),
            "fact-mh-6k": (
                "7fb298c148aeea82bb4029b7bd4a55489a9ae5e02ed85ee910d60b1ad33482a6",
                "16dfd7ef2a32eb12197672ebfda42145602a6d214492e0a1f2f629694495f0da",
            ),
            "fact-sh-262k": (
                "7fb298c148aeea82bb4029b7bd4a55489a9ae5e02ed85ee910d60b1ad33482a6",
                "16dfd7ef2a32eb12197672ebfda42145602a6d214492e0a1f2f629694495f0da",
            ),
            "fact-mh-262k": (
                "7fb298c148aeea82bb4029b7bd4a55489a9ae5e02ed85ee910d60b1ad33482a6",
                "16dfd7ef2a32eb12197672ebfda42145602a6d214492e0a1f2f629694495f0da",
            ),
            "eventqa-64k": (
                "29555812a5f91e7c519c57ca94c85340975c58df62ca438dfb0db4c17335331c",
                "cab1615deaf8e06201f0384a03b2145d5dd5cb0d2dfdcae6c0b7eac6b77a167b",
            ),
            "eventqa-full": (
                "29555812a5f91e7c519c57ca94c85340975c58df62ca438dfb0db4c17335331c",
                "cab1615deaf8e06201f0384a03b2145d5dd5cb0d2dfdcae6c0b7eac6b77a167b",
            ),
        }
        actual = {
            task_id: (
                hashlib.sha256(task.memorize_template.encode()).hexdigest(),
                hashlib.sha256(task.query_template.encode()).hexdigest(),
            )
            for task_id, task in TASKS.items()
        }
        self.assertEqual(actual, expected)

    def test_parses_nested_answers_and_question_metadata(self):
        context = parse_context(
            {
                "context": "one two three",
                "questions": ["q"],
                "answers": [["A", "The A"]],
                "metadata": {
                    "qa_pair_ids": ["qa-1"],
                    "question_ids": ["question-1"],
                    "question_types": ["multi-session"],
                },
            },
            0,
        )
        self.assertEqual(context.queries[0].answers, ("A", "The A"))
        self.assertEqual(context.queries[0].question_id, "question-1")

    def test_rejects_mismatched_question_answer_lengths(self):
        with self.assertRaises(ContractError):
            parse_context(
                {
                    "context": "text",
                    "questions": ["q1", "q2"],
                    "answers": [["a1"]],
                    "metadata": {},
                },
                0,
            )


if __name__ == "__main__":
    unittest.main()
