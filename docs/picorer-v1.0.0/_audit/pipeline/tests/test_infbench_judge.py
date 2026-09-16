from __future__ import annotations

import pytest

from question_pipeline.infbench_judge import evaluate
from question_pipeline.openai_compat import Completion


def test_official_infbench_formula_and_three_prompt_contract():
    outputs = {
        "fluency": 'analysis {"fluency": 1}',
        "recall": 'analysis {"recall": 2}',
        "precision": 'analysis {"precision": 3, "sentence_count": 4}',
    }
    seen = []

    def call(prompt_name, **values):
        seen.append((prompt_name, values))
        return Completion(outputs[prompt_name], "gpt-4o-2024-05-13", None)

    result = evaluate(
        {"keypoints": ["a", "b", "c", "d"], "answers": ["reference"]},
        "generated summary",
        {
            "model": "gpt-4o-2024-05-13",
            "prompts": {
                "fluency": "fluency",
                "recall": "recall",
                "precision": "precision",
            },
            "official_source": {"commit": "pinned"},
        },
        call,
    )
    metrics = result["metrics"]
    assert metrics["gpt-4-recall"] == 0.5
    assert metrics["gpt-4-precision"] == 0.75
    assert metrics["gpt-4-fluency"] == 1.0
    assert metrics["gpt-4-f1"] == pytest.approx(0.6)
    assert metrics["official_score"] == pytest.approx(0.6)
    assert [name for name, _values in seen] == ["fluency", "recall", "precision"]
