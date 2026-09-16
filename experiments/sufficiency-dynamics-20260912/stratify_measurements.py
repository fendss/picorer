#!/usr/bin/env python3
"""Produce stratified, read-only quality statistics for sufficiency probes."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


REPLICAS = ("qwen-r1", "qwen-r2")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def quantile(values: list[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = probability * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def describe(values: Iterable[float]) -> dict[str, float | int | None]:
    data = [float(value) for value in values]
    return {
        "n": len(data),
        "mean": statistics.fmean(data) if data else None,
        "std": statistics.pstdev(data) if len(data) > 1 else 0.0 if data else None,
        "min": min(data) if data else None,
        "p10": quantile(data, 0.10),
        "p25": quantile(data, 0.25),
        "median": quantile(data, 0.50),
        "p75": quantile(data, 0.75),
        "p90": quantile(data, 0.90),
        "max": max(data) if data else None,
    }


def pearson(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right) or len(left) < 2:
        return None
    left_mean = statistics.fmean(left)
    right_mean = statistics.fmean(right)
    numerator = sum(
        (x - left_mean) * (y - right_mean) for x, y in zip(left, right)
    )
    left_sum = sum((x - left_mean) ** 2 for x in left)
    right_sum = sum((y - right_mean) ** 2 for y in right)
    denominator = math.sqrt(left_sum * right_sum)
    return numerator / denominator if denominator else None


def ranks(values: list[float]) -> list[float]:
    ordered = sorted(enumerate(values), key=lambda pair: pair[1])
    result = [0.0] * len(values)
    offset = 0
    while offset < len(ordered):
        end = offset + 1
        while end < len(ordered) and ordered[end][1] == ordered[offset][1]:
            end += 1
        rank = (offset + 1 + end) / 2
        for original_index, _ in ordered[offset:end]:
            result[original_index] = rank
        offset = end
    return result


def spearman(left: list[float], right: list[float]) -> float | None:
    return pearson(ranks(left), ranks(right)) if len(left) == len(right) else None


def relationship(
    left: list[float],
    right: list[float],
    *,
    left_positive: list[bool] | None = None,
    right_positive: list[bool] | None = None,
) -> dict[str, Any]:
    if len(left) != len(right):
        raise ValueError("relationship inputs differ in length")
    if left_positive is None:
        left_positive = [value > 0.5 for value in left]
    if right_positive is None:
        right_positive = [value > 0.5 for value in right]
    if len(left_positive) != len(left) or len(right_positive) != len(right):
        raise ValueError("decision inputs differ in length")
    differences = [abs(x - y) for x, y in zip(left, right)]
    agreements = [x == y for x, y in zip(left_positive, right_positive)]
    confusion = {
        "both_positive": sum(x and y for x, y in zip(left_positive, right_positive)),
        "left_positive_right_negative": sum(
            x and not y for x, y in zip(left_positive, right_positive)
        ),
        "left_negative_right_positive": sum(
            not x and y for x, y in zip(left_positive, right_positive)
        ),
        "both_negative": sum(
            not x and not y for x, y in zip(left_positive, right_positive)
        ),
    }
    observed = statistics.fmean(agreements) if agreements else None
    if agreements:
        left_rate = statistics.fmean(left_positive)
        right_rate = statistics.fmean(right_positive)
        expected = left_rate * right_rate + (1 - left_rate) * (1 - right_rate)
        kappa = (observed - expected) / (1 - expected) if expected < 1 else None
    else:
        kappa = None
    return {
        "n": len(left),
        "pearson": pearson(left, right),
        "spearman": spearman(left, right),
        "binary_agreement": observed,
        "cohen_kappa": kappa,
        "confusion": confusion,
        "mae": statistics.fmean(differences) if differences else None,
        "rmse": (
            math.sqrt(statistics.fmean((x - y) ** 2 for x, y in zip(left, right)))
            if left
            else None
        ),
    }


def probability_bands(values: Iterable[float]) -> dict[str, int]:
    counts = Counter()
    for value in values:
        if value == 0:
            counts["exact_0"] += 1
        elif value < 0.1:
            counts["(0,.1)"] += 1
        elif value < 0.5:
            counts["[.1,.5)"] += 1
        elif value < 0.9:
            counts["[.5,.9)"] += 1
        elif value < 1:
            counts["[.9,1)"] += 1
        else:
            counts["exact_1"] += 1
    names = ("exact_0", "(0,.1)", "[.1,.5)", "[.5,.9)", "[.9,1)", "exact_1")
    return {name: counts[name] for name in names}


def progress_band(tau: float) -> str:
    if tau <= 0.2:
        return "(0,.2]"
    if tau <= 0.4:
        return "(.2,.4]"
    if tau <= 0.6:
        return "(.4,.6]"
    if tau <= 0.8:
        return "(.6,.8]"
    return "(.8,1]"


def safe_ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def load_states(root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    states = [
        json.loads(line)
        for line in (root / "decision-states-v2" / "index.jsonl").read_text().splitlines()
        if line
    ]
    manifest = read_json(root / "manifest-full.json")
    question_order = [str(question["id"]) for question in manifest["questions"]]
    return states, question_order


def load_official_scores(root: Path) -> dict[str, float]:
    scores: dict[str, float] = {}
    for path in (root / "artifacts-scoring").glob("*/evaluation.json"):
        evaluation = read_json(path)
        question_id = str(evaluation["question_id"])
        score = float(evaluation["output"]["metrics"]["official_score"])
        scores[question_id] = score
    return scores


def expected_result_path(root: Path, state: dict[str, Any], replica: str) -> Path:
    question_hash = hashlib.sha256(state["question_id"].encode()).hexdigest()[:12]
    return (
        root
        / "probes-v2"
        / question_hash
        / f"step-{state['decision_step']:03d}"
        / replica
        / "result.json"
    )


def analyze_round(label: str, root: Path) -> dict[str, Any]:
    states, question_order = load_states(root)
    official_scores = load_official_scores(root)
    state_by_key = {
        (state["question_id"], int(state["decision_step"])): state for state in states
    }
    expected_keys = {
        (state["question_id"], int(state["decision_step"]), replica)
        for state in states
        for replica in REPLICAS
    }
    validation_errors: list[str] = []
    records: list[dict[str, Any]] = []
    actual_paths = sorted((root / "probes-v2").glob("*/step-*/*/result.json"))
    seen_keys: set[tuple[str, int, str]] = set()
    for path in actual_paths:
        try:
            result = read_json(path)
        except Exception as error:  # noqa: BLE001 - report all corrupt snapshots
            validation_errors.append(f"unreadable {path}: {error!r}")
            continue
        key = (
            str(result.get("question_id")),
            int(result.get("decision_step", -1)),
            str(result.get("replica")),
        )
        if key in seen_keys:
            validation_errors.append(f"duplicate logical result {key}")
        seen_keys.add(key)
        if key not in expected_keys:
            validation_errors.append(f"unexpected logical result {key}: {path}")
            continue
        expected_state = state_by_key[key[:2]]
        explicit = result.get("explicit_j", {})
        native = result.get("native_s", {})
        native_logprobs = native.get("logprobs", {})
        sampled = explicit.get("sampled_token_ids", [])
        sample_count = explicit.get("sample_count")
        sufficient_count = explicit.get("sufficient_count")
        insufficient_count = explicit.get("insufficient_count")
        j_value = explicit.get("sufficient_fraction")
        s_value = native.get("sufficient_likelihood")
        checks = {
            "sample_count_101": sample_count == 101,
            "token_count_101": len(sampled) == 101,
            "counts_sum_101": (
                isinstance(sufficient_count, int)
                and isinstance(insufficient_count, int)
                and sufficient_count + insufficient_count == 101
            ),
            "j_recomputed": (
                isinstance(j_value, (int, float))
                and isinstance(sufficient_count, int)
                and math.isclose(j_value, sufficient_count / 101, abs_tol=1e-15)
            ),
            "j_in_range": isinstance(j_value, (int, float)) and 0 <= j_value <= 1,
            "s_in_range": isinstance(s_value, (int, float)) and 0 <= s_value <= 1,
            "native_logprobs_present": (
                isinstance(native_logprobs.get("sufficient"), (int, float))
                and isinstance(native_logprobs.get("insufficient"), (int, float))
            ),
            "context_unchanged": native.get("agent_context_changed") is False,
            "no_extra_s_prompt": native.get("extra_sufficiency_prompt") is False,
            "metadata_match": (
                result.get("capture_id") == expected_state.get("capture_id")
                and result.get("request_sha256") == expected_state.get("request_sha256")
                and int(result.get("decision_state_count", -1))
                == int(expected_state.get("decision_state_count", -2))
            ),
        }
        for name, passed in checks.items():
            if not passed:
                validation_errors.append(f"{key} failed {name}")
        if not all(checks.values()):
            continue
        records.append(
            {
                "question_id": key[0],
                "step": key[1],
                "replica": key[2],
                "capture_id": str(result["capture_id"]),
                "tau": float(result["normalized_progress"]),
                "terminal": key[1] == int(result["decision_state_count"]),
                "trajectory_length": int(result["decision_state_count"]),
                "j": float(j_value),
                "s": float(s_value),
                "s_margin": (
                    float(native_logprobs["sufficient"])
                    - float(native_logprobs["insufficient"])
                ),
                "seed": int(explicit["seed"]),
                "prompt": str(explicit["prompt"]),
                "j_prefix": {
                    key: float(value)
                    for key, value in explicit.get("prefix_estimates", {}).items()
                },
                "explicit_token_pair": tuple(
                    sorted(explicit.get("branch_token_ids", {}).items())
                ),
                "native_token_pair": tuple(
                    sorted(native.get("branch_token_ids", {}).items())
                ),
            }
        )

    completed_keys = {
        (record["question_id"], record["step"], record["replica"])
        for record in records
    }
    expected_by_question = Counter(state["question_id"] for state in states)
    completed_by_question = Counter(record["question_id"] for record in records)
    complete_questions = sum(
        completed_by_question[question_id] == expected_by_question[question_id] * 2
        for question_id in question_order
    )
    started_questions = sum(completed_by_question[question_id] > 0 for question_id in question_order)

    progress: dict[str, dict[str, Any]] = {}
    for band in ("(0,.2]", "(.2,.4]", "(.4,.6]", "(.6,.8]", "(.8,1]"):
        expected = sum(
            2 for state in states if progress_band(float(state["normalized_progress"])) == band
        )
        subset = [record for record in records if progress_band(record["tau"]) == band]
        j_values = [record["j"] for record in subset]
        s_values = [record["s"] for record in subset]
        progress[band] = {
            "expected_jobs": expected,
            "completed_jobs": len(subset),
            "completion_rate": safe_ratio(len(subset), expected),
            "j_mean": statistics.fmean(j_values) if j_values else None,
            "s_mean": statistics.fmean(s_values) if s_values else None,
            "agreement": relationship(
                j_values,
                s_values,
                right_positive=[record["s_margin"] > 0 for record in subset],
            )["binary_agreement"],
        }

    manifest_quartiles: dict[str, dict[str, Any]] = {}
    for quartile in range(4):
        selected = set(question_order[quartile * 25 : (quartile + 1) * 25])
        expected = sum(expected_by_question[question_id] * 2 for question_id in selected)
        completed = sum(completed_by_question[question_id] for question_id in selected)
        manifest_quartiles[f"q{quartile + 1}"] = {
            "questions": len(selected),
            "expected_jobs": expected,
            "completed_jobs": completed,
            "completion_rate": safe_ratio(completed, expected),
        }

    by_replica: dict[str, Any] = {}
    for replica in REPLICAS:
        subset = [record for record in records if record["replica"] == replica]
        j_values = [record["j"] for record in subset]
        s_values = [record["s"] for record in subset]
        by_replica[replica] = {
            "completed": len(subset),
            "completion_rate": safe_ratio(len(subset), len(states)),
            "j": describe(j_values),
            "j_bands": probability_bands(j_values),
            "s": describe(s_values),
            "s_bands": probability_bands(s_values),
            "native_logit_margin": describe(record["s_margin"] for record in subset),
            "native_margin_decisions": {
                "sufficient": sum(record["s_margin"] > 0 for record in subset),
                "insufficient": sum(record["s_margin"] < 0 for record in subset),
                "tie": sum(record["s_margin"] == 0 for record in subset),
            },
            "j_vs_s": relationship(
                j_values,
                s_values,
                right_positive=[record["s_margin"] > 0 for record in subset],
            ),
        }

    paired: dict[tuple[str, int], dict[str, dict[str, Any]]] = defaultdict(dict)
    for record in records:
        paired[(record["question_id"], record["step"])][record["replica"]] = record
    pairs = [value for value in paired.values() if set(value) == set(REPLICAS)]
    j_r1 = [pair["qwen-r1"]["j"] for pair in pairs]
    j_r2 = [pair["qwen-r2"]["j"] for pair in pairs]
    s_r1 = [pair["qwen-r1"]["s"] for pair in pairs]
    s_r2 = [pair["qwen-r2"]["s"] for pair in pairs]
    s_margin_r1 = [pair["qwen-r1"]["s_margin"] for pair in pairs]
    s_margin_r2 = [pair["qwen-r2"]["s_margin"] for pair in pairs]

    all_j = [record["j"] for record in records]
    all_s = [record["s"] for record in records]
    all_s_margins = [record["s_margin"] for record in records]
    terminals = [record for record in records if record["terminal"]]
    nonterminals = [record for record in records if not record["terminal"]]
    prefix_mae: dict[str, float | None] = {}
    for size in ("11", "31", "63"):
        differences = [
            abs(record["j_prefix"][size] - record["j"])
            for record in records
            if size in record["j_prefix"]
        ]
        prefix_mae[size] = statistics.fmean(differences) if differences else None

    question_lengths = list(expected_by_question.values())
    per_question_completion = [
        safe_ratio(completed_by_question[q], expected_by_question[q] * 2)
        for q in question_order
    ]

    per_question_records: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        per_question_records[record["question_id"]].append(record)
    question_means = [
        {
            "question_id": question_id,
            "j": statistics.fmean(record["j"] for record in subset),
            "s": statistics.fmean(record["s"] for record in subset),
        }
        for question_id, subset in per_question_records.items()
    ]
    question_j = [record["j"] for record in question_means]
    question_s = [record["s"] for record in question_means]

    question_balanced_progress: dict[str, dict[str, Any]] = {}
    for band in ("(0,.2]", "(.2,.4]", "(.4,.6]", "(.6,.8]", "(.8,1]"):
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for record in records:
            if progress_band(record["tau"]) == band:
                grouped[record["question_id"]].append(record)
        j_values = [
            statistics.fmean(record["j"] for record in subset)
            for subset in grouped.values()
        ]
        s_values = [
            statistics.fmean(record["s"] for record in subset)
            for subset in grouped.values()
        ]
        margin_values = [
            statistics.fmean(record["s_margin"] for record in subset)
            for subset in grouped.values()
        ]
        question_balanced_progress[band] = {
            "questions": len(grouped),
            "j_mean": statistics.fmean(j_values) if j_values else None,
            "s_mean": statistics.fmean(s_values) if s_values else None,
            "mean_native_logit_margin": (
                statistics.fmean(margin_values) if margin_values else None
            ),
            "agreement": relationship(
                j_values,
                s_values,
                right_positive=[margin > 0 for margin in margin_values],
            )["binary_agreement"],
        }

    mismatch_examples = sorted(
        (
            {
                "question_id": record["question_id"],
                "step": record["step"],
                "tau": record["tau"],
                "replica": record["replica"],
                "j": record["j"],
                "s": record["s"],
                "j_minus_s": record["j"] - record["s"],
            }
            for record in records
        ),
        key=lambda record: abs(record["j_minus_s"]),
        reverse=True,
    )[:20]

    correctness_strata: dict[str, dict[str, Any]] = {}
    for stratum, is_selected in (
        ("correct", lambda score: score > 0),
        ("incorrect", lambda score: score == 0),
    ):
        selected_questions = {
            question_id
            for question_id, score in official_scores.items()
            if is_selected(score)
        }
        subset = [
            record for record in records if record["question_id"] in selected_questions
        ]
        subset_terminals = [record for record in subset if record["terminal"]]
        selected_question_means = [
            record
            for record in question_means
            if record["question_id"] in selected_questions
        ]
        correctness_strata[stratum] = {
            "questions": len(selected_questions),
            "completed_jobs": len(subset),
            "question_mean_j": describe(
                record["j"] for record in selected_question_means
            ),
            "question_mean_s": describe(
                record["s"] for record in selected_question_means
            ),
            "terminal_j": describe(record["j"] for record in subset_terminals),
            "terminal_s": describe(record["s"] for record in subset_terminals),
        }
    return {
        "label": label,
        "root": str(root),
        "snapshot": {
            "questions": len(question_order),
            "decision_states": len(states),
            "expected_jobs": len(expected_keys),
            "completed_jobs": len(records),
            "completion_rate": safe_ratio(len(records), len(expected_keys)),
            "missing_jobs": len(expected_keys - completed_keys),
            "unexpected_or_malformed_files": len(validation_errors),
            "started_questions": started_questions,
            "fully_complete_questions": complete_questions,
            "paired_states": len(pairs),
        },
        "validation": {
            "errors": validation_errors[:100],
            "error_count": len(validation_errors),
            "unique_seeds": len({record["seed"] for record in records}),
            "result_count": len(records),
            "unique_explicit_prompts": len({record["prompt"] for record in records}),
            "explicit_token_pairs": [list(pair) for pair in sorted({record["explicit_token_pair"] for record in records})],
            "native_token_pairs": [list(pair) for pair in sorted({record["native_token_pair"] for record in records})],
        },
        "trajectory_lengths": describe(question_lengths),
        "question_completion_rates": describe(per_question_completion),
        "manifest_quartiles": manifest_quartiles,
        "progress_quintiles": progress,
        "question_balanced": {
            "question_means_j": describe(question_j),
            "question_means_s": describe(question_s),
            "j_vs_s": relationship(
                question_j,
                question_s,
                right_positive=[
                    statistics.fmean(
                        record["s_margin"]
                        for record in per_question_records[item["question_id"]]
                    )
                    > 0
                    for item in question_means
                ],
            ),
            "progress_quintiles": question_balanced_progress,
        },
        "by_final_answer_correctness": correctness_strata,
        "overall": {
            "j": describe(all_j),
            "j_bands": probability_bands(all_j),
            "s": describe(all_s),
            "s_bands": probability_bands(all_s),
            "native_logit_margin": describe(all_s_margins),
            "native_margin_decisions": {
                "sufficient": sum(margin > 0 for margin in all_s_margins),
                "insufficient": sum(margin < 0 for margin in all_s_margins),
                "tie": sum(margin == 0 for margin in all_s_margins),
            },
            "j_vs_s": relationship(
                all_j,
                all_s,
                right_positive=[margin > 0 for margin in all_s_margins],
            ),
            "terminal_j": describe(record["j"] for record in terminals),
            "terminal_s": describe(record["s"] for record in terminals),
            "nonterminal_j": describe(record["j"] for record in nonterminals),
            "nonterminal_s": describe(record["s"] for record in nonterminals),
            "prefix_mae_vs_101": prefix_mae,
        },
        "by_replica": by_replica,
        "replica_pairs": {
            "paired_states": len(pairs),
            "j_r1_vs_r2": relationship(j_r1, j_r2),
            "s_r1_vs_r2": relationship(
                s_r1,
                s_r2,
                left_positive=[margin > 0 for margin in s_margin_r1],
                right_positive=[margin > 0 for margin in s_margin_r2],
            ),
            "j_exact_match": (
                statistics.fmean(x == y for x, y in zip(j_r1, j_r2)) if pairs else None
            ),
        },
        "largest_j_s_mismatches": mismatch_examples,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--round",
        action="append",
        nargs=2,
        metavar=("LABEL", "ROOT"),
        required=True,
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "rounds": [analyze_round(label, Path(root)) for label, root in args.round],
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
