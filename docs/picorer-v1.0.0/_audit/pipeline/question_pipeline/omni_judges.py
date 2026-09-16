from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from typing import Any

from .contracts import RetryableStageError

JudgeCall = Callable[..., str]


def _json_object(value: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", value):
        try:
            parsed, _end = decoder.raw_decode(value[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise RetryableStageError(
        f"judge response does not contain valid JSON: {value[:200]}"
    )


def _kendall_tau_b(ref_order: list[int], pred_order: list[int]) -> float:
    n = len(ref_order)
    if n < 2:
        return 1.0
    concordant = discordant = ties_ref = ties_pred = 0
    for left in range(n):
        for right in range(left + 1, n):
            ref_diff = ref_order[left] - ref_order[right]
            pred_diff = pred_order[left] - pred_order[right]
            if ref_diff == 0 and pred_diff == 0:
                ties_ref += 1
                ties_pred += 1
            elif ref_diff == 0:
                ties_ref += 1
            elif pred_diff == 0:
                ties_pred += 1
            elif (ref_diff > 0) == (pred_diff > 0):
                concordant += 1
            else:
                discordant += 1
    pairs = n * (n - 1) // 2
    denominator = ((pairs - ties_ref) * (pairs - ties_pred)) ** 0.5
    return 0.0 if denominator == 0 else (concordant - discordant) / denominator


def binary(
    payload: Mapping[str, Any],
    response_record: Mapping[str, Any],
    judge: Mapping[str, Any],
    call: JudgeCall,
) -> dict[str, Any]:
    content = call(
        str(judge["prompt"]),
        question=payload["question"],
        golden_answer=payload["golden_answer"],
        response=response_record["answer"],
    )
    label = str(_json_object(content).get("label", "")).casefold()
    if label not in {"correct", "wrong"}:
        raise RetryableStageError(f"invalid binary judge label: {content[:200]}")
    return {
        "metrics": {"official_score": float(label == "correct")},
        "judge_response": content,
        "judge_model": str(judge["model"]),
        "judge_prompt": str(judge["prompt"]),
    }


def _beam_ordering(
    payload: Mapping[str, Any],
    answer: str,
    rubric_items: list[str],
    judge: Mapping[str, Any],
    call: JudgeCall,
) -> dict[str, Any]:
    listing = "\n".join(
        f"{index}. {item}" for index, item in enumerate(rubric_items, 1)
    )
    scores = []
    records = []
    for _ in range(int(judge.get("runs", 1))):
        content = call(
            str(judge["ordering_prompt"]),
            question=payload["question"],
            reference_ordering=listing,
            response=answer,
        )
        raw_positions = _json_object(content).get("positions")
        if not isinstance(raw_positions, list):
            raise RetryableStageError(
                f"invalid BEAM ordering response: {content[:200]}"
            )
        positions = [
            int(item.get("position", -1))
            for item in raw_positions[: len(rubric_items)]
            if isinstance(item, Mapping)
        ]
        positions.extend([-1] * (len(rubric_items) - len(positions)))
        found = [(index, position) for index, position in enumerate(positions) if position > 0]
        coverage = len(found) / len(rubric_items)
        if len(found) < 2:
            score = 0.0 if coverage == 0 else coverage * 0.5
        else:
            tau = _kendall_tau_b(
                [index for index, _position in found],
                [position for _index, position in found],
            )
            score = max(0.0, (tau + 1.0) / 2.0) * coverage
        scores.append(score)
        records.append({"response": content, "positions": positions})
    return {
        "metrics": {"official_score": sum(scores) / len(scores)},
        "scoring_method": "kendall_tau_b",
        "judge_runs": records,
        "judge_model": str(judge["model"]),
    }


def beam(
    payload: Mapping[str, Any],
    response_record: Mapping[str, Any],
    judge: Mapping[str, Any],
    call: JudgeCall,
) -> dict[str, Any]:
    rubric = payload.get("rubric")
    rubric_items = (
        [str(item) for item in rubric]
        if isinstance(rubric, list)
        else ([str(rubric)] if rubric else [])
    )
    if not rubric_items:
        rubric_items = [f"LLM response should contain: {payload['golden_answer']}"]
    answer = str(response_record["answer"])
    if payload.get("dimension") == "event_ordering":
        return _beam_ordering(payload, answer, rubric_items, judge, call)

    items = []
    for rubric_item in rubric_items:
        run_records = []
        for _ in range(int(judge.get("runs", 1))):
            content = call(
                str(judge["rubric_prompt"]),
                question=payload["question"],
                rubric_item=rubric_item,
                response=answer,
            )
            try:
                raw_score = float(_json_object(content)["score"])
            except (KeyError, TypeError, ValueError) as error:
                raise RetryableStageError(
                    f"invalid BEAM rubric score: {content[:200]}"
                ) from error
            score = 1.0 if raw_score >= 0.75 else 0.5 if raw_score >= 0.25 else 0.0
            run_records.append({"response": content, "score": score})
        items.append({
            "rubric_item": rubric_item,
            "item_score": sum(item["score"] for item in run_records)
            / len(run_records),
            "runs": run_records,
        })
    return {
        "metrics": {
            "official_score": sum(item["item_score"] for item in items) / len(items)
        },
        "scoring_method": "per_rubric_item",
        "rubric_item_scores": items,
        "judge_model": str(judge["model"]),
    }
