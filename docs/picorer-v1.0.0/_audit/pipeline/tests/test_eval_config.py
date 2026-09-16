from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
import yaml

from question_pipeline.eval_config import bind, load, render, validate

CONFIG = Path(__file__).parents[1] / "config" / "eval.yaml"


def test_repository_config_covers_supported_datasets():
    config = load(CONFIG)
    expected = {
        "agentmemorybench/fact-mh-262k",
        "agentmemorybench/fact-sh-262k",
        "agentmemorybench/longmemeval-s",
        "agentmemorybench/infbench-sum",
        "omnimemeval/locomo",
        "omnimemeval/beam-100k",
        "omnimemeval/beam-10m",
    }
    assert expected <= set(config["datasets"])


def test_binding_freezes_absolute_path_and_hash():
    binding = bind(CONFIG, "omnimemeval/beam-100k")
    assert binding["path"] == str(CONFIG.resolve())
    assert binding["sha256"] == hashlib.sha256(CONFIG.read_bytes()).hexdigest()
    assert binding["dataset"] == "omnimemeval/beam-100k"


def test_hash_drift_is_rejected(tmp_path):
    target = tmp_path / "eval.yaml"
    target.write_bytes(CONFIG.read_bytes())
    binding = bind(target, "omnimemeval/locomo")
    target.write_text(target.read_text() + "\n# changed\n")
    with pytest.raises(RuntimeError, match="eval config drift"):
        load(target, binding["sha256"])


def test_inline_api_key_is_rejected():
    config = yaml.safe_load(CONFIG.read_text())
    config["models"]["qwen3.6-27b"]["api_key"] = "secret"
    with pytest.raises(ValueError, match="api_key_env"):
        validate(config)


def test_template_render_does_not_treat_json_braces_as_variables():
    assert render('${question} {"label": "CORRECT"}', question="Q") == (
        'Q {"label": "CORRECT"}'
    )


def test_infbench_prompts_match_pinned_official_commit():
    config = load(CONFIG)
    prompts = config["prompts"]
    rendered = {
        "fluency": render(
            prompts["infbench-fluency-judge"]["user"], text="__TEXT__"
        ),
        "recall": render(
            prompts["infbench-recall-judge"]["user"],
            keypoints="__KEYPOINTS__",
            summary="__SUMMARY__",
        ),
        "precision": render(
            prompts["infbench-precision-judge"]["user"],
            expert_summary="__EXPERT_SUMMARY__",
            summary="__SUMMARY__",
        ),
    }
    expected = {
        "fluency": "7b49f6adbfd43b6506a412d6a75ba059162981e0a49d52e884881c0cb0cb433d",
        "recall": "72cb0fbfb24b49b6a2c8f182a5fa35c5a1c2e146ff150c8c1171f90ff0f1db0c",
        "precision": "40c1f26ea1c819aa3a18359371e600e68b9cc959c4a9a4a9d0c135ee38f15691",
    }
    assert {
        name: hashlib.sha256(value.encode()).hexdigest()
        for name, value in rendered.items()
    } == expected
