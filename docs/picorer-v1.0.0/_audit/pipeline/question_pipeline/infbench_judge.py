from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from typing import Any

from .contracts import RetryableStageError
from .openai_compat import Completion

JudgeCall = Callable[..., Completion]


def _last_json_object(value: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    objects = []
    for match in re.finditer(r"\{", value):
        try:
            parsed, _end = decoder.raw_decode(value[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            objects.append(parsed)
    if not objects:
        raise RetryableStageError(
            f"InfBench judge response has no JSON object: {value[:200]}"
        )
    return objects[-1]


def evaluate(
    payload: Mapping[str, Any],
    prediction: str,
    judge: Mapping[str, Any],
    call: JudgeCall,
) -> dict[str, Any]:
    keypoints = [str(value) for value in payload.get("keypoints", [])]
    answers = [str(value) for value in payload.get("answers", [])]
    if not keypoints:
        raise RuntimeError("InfBench evaluation requires keypoints")
    if not answers:
        raise RuntimeError("InfBench evaluation requires an expert summary")
    prompts = judge["prompts"]
    summary = prediction.strip()
    completions = {
        "fluency": call(str(prompts["fluency"]), text=summary),
        "recall": call(
            str(prompts["recall"]),
            keypoints="\n".join(
                f"{index}. {keypoint}"
                for index, keypoint in enumerate(keypoints, 1)
            ),
            summary=summary,
        ),
        "precision": call(
            str(prompts["precision"]),
            expert_summary=answers[0],
            summary=summary,
        ),
    }
    parsed = {
        name: _last_json_object(completion.text)
        for name, completion in completions.items()
    }
    try:
        fluency = float(parsed["fluency"]["fluency"])
        recall_found = float(parsed["recall"]["recall"])
        precision_found = float(parsed["precision"]["precision"])
        sentence_count = float(parsed["precision"]["sentence_count"])
    except (KeyError, TypeError, ValueError) as error:
        raise RetryableStageError("InfBench judge JSON violates the contract") from error
    recall = recall_found / len(keypoints)
    precision = precision_found / sentence_count if sentence_count > 0 else 0.0
    f1 = (
        fluency * 2 * recall * precision / (recall + precision)
        if recall + precision > 0
        else 0.0
    )
    return {
        "metrics": {
            "official_score": f1,
            "gpt-4-f1": f1,
            "gpt-4-recall": recall,
            "gpt-4-precision": precision,
            "gpt-4-fluency": fluency,
            "recall_total": len(keypoints),
            "recall_found": recall_found,
            "precision_total": sentence_count,
            "precision_found": precision_found,
        },
        "judge_model": str(judge["model"]),
        "judge_prompts": dict(prompts),
        "judge_outputs": {
            name: {
                "text": completion.text,
                "response_model": completion.response_model,
                "usage": completion.usage,
            }
            for name, completion in completions.items()
        },
        "official_source": dict(judge.get("official_source", {})),
    }
