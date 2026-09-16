from __future__ import annotations

import json

from question_pipeline.omni_manifest import build


def test_builds_one_question_per_unit_and_filters_locomo_category_five(tmp_path):
    beam = tmp_path / "beam.jsonl"
    beam.write_text(json.dumps({
        "conversation_id": 7,
        "probing_questions": {
            "fact": [{"question": "Q1", "answer": "A1"}],
            "order": [{"question": "Q2", "ideal_answer": "A2"}],
        },
    }) + "\n")
    locomo = tmp_path / "locomo.json"
    locomo.write_text(json.dumps([{
        "conversation": {"speaker_a": "A", "speaker_b": "B"},
        "qa": [
            {"question": "Q3", "answer": "A3", "category": 1},
            {"question": "excluded", "answer": "x", "category": 5},
        ],
    }]))
    manifest = build({
        "beam": [{
            "scale": "100k", "data": str(beam), "env_file": "beam.env",
            "omni_root": "/omni", "ingestion_version": "ingested",
            "service_version": "run",
        }],
        "locomo": {
            "data": str(locomo), "env_file": "locomo.env",
            "omni_root": "/omni", "ingestion_version": "ingested",
            "service_version": "run",
        },
    })
    assert len(manifest["questions"]) == 3
    assert len({question["id"] for question in manifest["questions"]}) == 3
    assert [q["payload"]["question"] for q in manifest["questions"]] == ["Q1", "Q2", "Q3"]


def test_manifest_binds_eval_config(tmp_path):
    beam = tmp_path / "beam.jsonl"
    beam.write_text(json.dumps({
        "conversation_id": 7,
        "probing_questions": {"fact": [{"question": "Q", "answer": "A"}]},
    }) + "\n")
    eval_config = tmp_path / "eval.yaml"
    eval_config.write_text(
        "schema_version: 1\n"
        "models:\n"
        "  answer: {id: qwen, base_url: 'http://answer.invalid/v1'}\n"
        "  judge: {id: judge, base_url: 'http://judge.invalid/v1'}\n"
        "prompts:\n"
        "  answer: {user: '${context} ${question}'}\n"
        "  rubric: {user: '${question} ${rubric_item} ${response}'}\n"
        "  order: {user: '${question} ${reference_ordering} ${response}'}\n"
        "datasets:\n"
        "  omnimemeval/beam-100k:\n"
        "    answer: {model: answer, prompt: answer}\n"
        "    judge: {method: beam, model: judge, rubric_prompt: rubric, ordering_prompt: order}\n"
    )
    manifest = build({"beam": [{
        "scale": "100k",
        "data": str(beam),
        "env_file": "beam.env",
        "omni_root": "/omni",
        "ingestion_version": "ingested",
        "service_version": "run",
    }]}, eval_config)
    binding = manifest["questions"][0]["payload"]["eval_config"]
    assert binding["dataset"] == "omnimemeval/beam-100k"
    assert binding["path"] == str(eval_config.resolve())
    assert len(binding["sha256"]) == 64
    assert manifest["questions"][0]["max_attempts"]["evaluation"] == 3
