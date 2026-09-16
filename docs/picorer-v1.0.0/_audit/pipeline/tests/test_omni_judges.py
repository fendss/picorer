from __future__ import annotations

from question_pipeline.omni_judges import beam, binary


def test_binary_judge_parses_json_after_explanation():
    result = binary(
        {"question": "Q", "golden_answer": "A"},
        {"answer": "A"},
        {"model": "judge", "prompt": "binary"},
        lambda _prompt, **_values: 'Reason. {"label": "CORRECT"}',
    )
    assert result["metrics"]["official_score"] == 1.0


def test_beam_scores_each_rubric_item_independently():
    responses = iter([
        '{"score": 1.0, "reason": "covered"}',
        '{"score": 0.5, "reason": "partial"}',
    ])
    result = beam(
        {
            "question": "Q",
            "golden_answer": "A",
            "dimension": "fact",
            "rubric": ["first", "second"],
        },
        {"answer": "response"},
        {
            "model": "judge",
            "rubric_prompt": "rubric",
            "ordering_prompt": "ordering",
            "runs": 1,
        },
        lambda _prompt, **_values: next(responses),
    )
    assert result["metrics"]["official_score"] == 0.75
    assert [item["item_score"] for item in result["rubric_item_scores"]] == [
        1.0,
        0.5,
    ]


def test_beam_event_ordering_uses_coverage_and_order():
    result = beam(
        {
            "question": "Q",
            "golden_answer": "A",
            "dimension": "event_ordering",
            "rubric": ["first", "second", "third"],
        },
        {"answer": "response"},
        {
            "model": "judge",
            "rubric_prompt": "rubric",
            "ordering_prompt": "ordering",
            "runs": 1,
        },
        lambda _prompt, **_values: (
            '{"positions": ['
            '{"event": "first", "position": 1}, '
            '{"event": "second", "position": 2}, '
            '{"event": "third", "position": -1}]}'
        ),
    )
    assert result["metrics"]["official_score"] == 2 / 3
