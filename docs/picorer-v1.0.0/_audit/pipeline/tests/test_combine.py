from __future__ import annotations

import json

from question_pipeline.combine_manifests import combine, main


def test_combiner_interleaves_benchmarks(tmp_path):
    source = tmp_path / "input.json"
    output = tmp_path / "output.json"
    source.write_text(json.dumps({
        "schema_version": 2,
        "questions": [
            {"id": "a1", "benchmark": "A", "ordinal": 0},
            {"id": "a2", "benchmark": "A", "ordinal": 1},
            {"id": "b1", "benchmark": "B", "ordinal": 2},
            {"id": "b2", "benchmark": "B", "ordinal": 3},
        ],
    }))
    assert main([
        "--input", str(source), "--output", str(output), "--expected", "4"
    ]) == 0
    result = json.loads(output.read_text())
    assert [question["id"] for question in result["questions"]] == [
        "a1", "b1", "a2", "b2"
    ]


def test_combine_rejects_wrong_coverage():
    try:
        combine([{"schema_version": 2, "questions": []}], expected=1)
    except ValueError as error:
        assert "expected 1" in str(error)
    else:
        raise AssertionError("coverage mismatch was accepted")
