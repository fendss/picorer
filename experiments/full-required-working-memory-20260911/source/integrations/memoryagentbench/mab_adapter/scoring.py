from __future__ import annotations

import re
import string
from collections import Counter
from typing import Iterable

from .config import TaskConfig


def normalize_answer(value: str) -> str:
    text = value.lower()
    text = "".join(character for character in text if character not in string.punctuation)
    text = re.sub(r"\b(a|an|the)\b", " ", text)
    return " ".join(text.split())


def parse_output(value: str) -> str:
    label = re.search(r"(?:^|\n)\s*label\s*:\s*(.*?)\s*(?:\n|$)", value, flags=re.IGNORECASE)
    if label:
        return label.group(1).strip()
    answer = re.search(r"(?:Answer:)(.*)(?:\n|$)", value, flags=re.IGNORECASE)
    if answer:
        return re.sub(
            r"^Answer:", "", answer.group(1).strip(), flags=re.IGNORECASE
        ).strip()
    first_line = re.search(r"(?:^)(.*)(?:\n|$)", value)
    return first_line.group(1).strip() if first_line else ""


def _f1(prediction: str, answer: str) -> float:
    predicted = normalize_answer(prediction).split()
    expected = normalize_answer(answer).split()
    special = {"yes", "no", "noanswer"}
    if (
        " ".join(predicted) in special or " ".join(expected) in special
    ) and predicted != expected:
        return 0.0
    if not predicted or not expected:
        return float(predicted == expected)
    common = Counter(predicted) & Counter(expected)
    overlap = sum(common.values())
    if overlap == 0:
        return 0.0
    precision = overlap / len(predicted)
    recall = overlap / len(expected)
    return 2 * precision * recall / (precision + recall)


def _metrics(prediction: str, answers: Iterable[str]) -> dict[str, float]:
    values = tuple(answers)
    if not values:
        raise ValueError("answers must not be empty")
    normalized_prediction = normalize_answer(prediction)
    return {
        "exact_match": float(
            any(normalized_prediction == normalize_answer(answer) for answer in values)
        ),
        "substring_exact_match": float(
            any(normalize_answer(answer) in normalized_prediction for answer in values)
        ),
        "f1": max(_f1(prediction, answer) for answer in values),
    }


def score_prediction(
    task: TaskConfig, prediction: str, answers: Iterable[str]
) -> dict[str, float | None]:
    parsed = parse_output(prediction)
    if task.capability == "test_time_learning" or task.task_id in {
        "eventqa-64k",
        "eventqa-full",
    }:
        metrics = _metrics(parsed, answers)
    else:
        raw = _metrics(prediction, answers)
        parsed_metrics = _metrics(parsed, answers)
        metrics = {key: max(value, parsed_metrics[key]) for key, value in raw.items()}
    if task.task_id in {"eventqa-64k", "eventqa-full"}:
        values = tuple(answers)
        metrics["eventqa_recall"] = float(
            all(answer.lower() in prediction.lower() for answer in values)
        )
    metrics["official_score"] = (
        None if task.official_metric == "llm_judge" else metrics[task.official_metric]
    )
    return metrics
