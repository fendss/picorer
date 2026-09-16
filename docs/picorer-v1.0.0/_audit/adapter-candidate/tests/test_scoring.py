from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mab_adapter.config import task_config  # noqa: E402
from mab_adapter.scoring import normalize_answer, parse_output, score_prediction  # noqa: E402


class ScoringTests(unittest.TestCase):
    def test_normalization_matches_upstream_rules(self):
        self.assertEqual(normalize_answer("The, Blue! Car"), "blue car")

    def test_substring_metric_accepts_concise_answer_inside_output(self):
        metrics = score_prediction(task_config("ruler-qa1"), "Answer: France.", ["France"])
        self.assertEqual(metrics["substring_exact_match"], 1.0)
        self.assertEqual(metrics["official_score"], 1.0)

    def test_trec_preserves_upstream_strict_exact_match(self):
        metrics = score_prediction(task_config("trec-coarse"), "label: 4", ["4"])
        self.assertEqual(metrics["exact_match"], 1.0)

    def test_all_icl_tasks_preserve_upstream_strict_exact_match(self):
        for task_id in ("trec-fine", "banking77", "nlu", "clinic150"):
            with self.subTest(task=task_id):
                metrics = score_prediction(task_config(task_id), "4", ["4"])
                self.assertEqual(metrics["official_score"], 1.0)
                formatted = score_prediction(task_config(task_id), "label: 4", ["4"])
                self.assertEqual(formatted["official_score"], 1.0)

    def test_label_parser_does_not_accept_explanatory_suffix(self):
        metrics = score_prediction(
            task_config("trec-fine"), "label: 4 because it matches", ["4"]
        )
        self.assertEqual(metrics["official_score"], 0.0)

    def test_eventqa_full_uses_eventqa_recall(self):
        metrics = score_prediction(
            task_config("eventqa-full"),
            "First event, then the second event.",
            ["First event", "second event"],
        )
        self.assertEqual(metrics["eventqa_recall"], 1.0)
        self.assertEqual(metrics["official_score"], 1.0)

    def test_longmemeval_requires_official_judge(self):
        metrics = score_prediction(task_config("longmemeval-s"), "Paris", ["Paris"])
        self.assertIsNone(metrics["official_score"])

    def test_infbench_summary_requires_official_judge(self):
        metrics = score_prediction(
            task_config("infbench-sum"), "A summary", ["Reference summary"]
        )
        self.assertIsNone(metrics["official_score"])

    def test_detective_qa_scores_only_the_json_answer_field(self):
        metrics = score_prediction(
            task_config("detective-qa"),
            '{"answer":"C. The Brandt couple","reasoning":"clues"}',
            ["C. The Brandt couple"],
        )
        self.assertEqual(metrics["official_score"], 1.0)

    def test_recsys_uses_official_recall_at_five(self):
        catalog = (
            {7: "Movie A", 8: "Movie B"},
            ("Movie A", "Movie B", "Movie C"),
        )
        with patch("mab_adapter.scoring._movie_catalog", return_value=catalog):
            metrics = score_prediction(
                task_config("recsys-redial-full"),
                "1. Movie C\n2. Movie B\n3. Movie A",
                ["7", "8"],
                Path("/tmp/data"),
            )
        self.assertEqual(metrics["recsys_recall@1"], 0.0)
        self.assertEqual(metrics["recsys_recall@5"], 1.0)
        self.assertEqual(metrics["official_score"], 1.0)

    def test_parser_prefers_explicit_answer_on_a_later_line(self):
        self.assertEqual(parse_output("Reasoning first\nAnswer: Paris\nMore"), "Paris")


if __name__ == "__main__":
    unittest.main()
