from __future__ import annotations

import json
import re
import string
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import editdistance

from .config import TaskConfig
from .dataset import load_auxiliary_json


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


def _extract_detective_answer(value: str) -> str:
    match = re.search(r'"answer"\s*:\s*"((?:\\.|[^"\\])*)"', value)
    if match is None:
        return parse_output(value)
    try:
        return json.loads(f'"{match.group(1)}"')
    except json.JSONDecodeError:
        return match.group(1).strip()


def _extract_movie_name(value: str) -> str:
    filename = value.split("/")[-1]
    cleaned = filename.replace("_", " ").replace("-", " ").replace(">", " ")
    cleaned = re.sub(r"\([^()]*\)", "", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def _clean_recommendation(value: str) -> str:
    value = re.sub(r"\([^()]*\)", "", value)
    value = re.sub(r"^(?:\d+[\.\)、]?\s*[\-—–]?\s*)?", "", value)
    return re.sub(r"\s+", " ", value).strip()


@lru_cache(maxsize=4)
def _movie_catalog(path: str) -> tuple[dict[int, str], tuple[str, ...]]:
    data_dir = Path(path)
    mapping = load_auxiliary_json(data_dir, "recsys_entities")
    if not isinstance(mapping, dict):
        raise ValueError("recsys entity mapping must be an object")
    id_to_name = {
        int(entity_id): _extract_movie_name(name)
        for name, entity_id in mapping.items()
    }
    candidates = tuple(dict.fromkeys(id_to_name.values()))
    return id_to_name, candidates


def _nearest_movie(value: str, candidates: tuple[str, ...]) -> str:
    target = value.casefold()
    return min(
        candidates,
        key=lambda candidate: editdistance.eval(target, candidate.casefold()),
    )


def _recommendations(value: str, candidates: tuple[str, ...]) -> tuple[str, ...]:
    try:
        _prefix, raw = value.split("1.", maxsplit=1)
    except ValueError:
        raw = value.replace(",", "\n")
    names = tuple(_clean_recommendation(item) for item in raw.splitlines())
    return tuple(_nearest_movie(name, candidates) for name in names)


def _score_recsys(
    prediction: str, answers: Iterable[str], data_dir: Path | None
) -> dict[str, float]:
    if data_dir is None:
        raise ValueError("data_dir is required to score recsys-redial-full")
    id_to_name, candidates = _movie_catalog(str(data_dir.resolve()))
    ground_truth = tuple(id_to_name[int(value.strip())] for value in answers)
    predicted = _recommendations(prediction, candidates)
    metrics = {
        f"recsys_recall@{cutoff}": sum(
            movie in predicted[:cutoff] for movie in ground_truth
        )
        / len(ground_truth)
        for cutoff in (1, 5, 10)
    }
    metrics["official_score"] = metrics["recsys_recall@5"]
    return metrics


def score_prediction(
    task: TaskConfig,
    prediction: str,
    answers: Iterable[str],
    data_dir: Path | None = None,
) -> dict[str, float | None]:
    if task.task_id == "recsys-redial-full":
        return _score_recsys(prediction, answers, data_dir)
    parsed = (
        _extract_detective_answer(prediction)
        if task.task_id == "detective-qa"
        else parse_output(prediction)
    )
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
