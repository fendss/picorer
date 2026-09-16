#!/usr/bin/env python3
"""Strict completeness and consistency audit for v2 sufficiency measurements."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


EXPLICIT_SUFFICIENCY_PROMPT = (
    "Judge whether the evidence currently available in the conversation is "
    "sufficient to answer the original user question correctly. Respond with "
    "exactly one label: sufficient or insufficient."
)
PREFIX_SAMPLE_SIZES = (11, 31, 63, 101)
REQUIRED_RAW_FILES = {
    "input-state.json",
    "native-sufficient.render.request.json",
    "native-sufficient.render.response.json",
    "native-insufficient.render.request.json",
    "native-insufficient.render.response.json",
    "native-branch.detokenize-sufficient.request.json",
    "native-branch.detokenize-sufficient.response.json",
    "native-branch.detokenize-insufficient.request.json",
    "native-branch.detokenize-insufficient.response.json",
    "native-s.request.json",
    "native-s.response.json",
    "explicit-sufficient.render.request.json",
    "explicit-sufficient.render.response.json",
    "explicit-insufficient.render.request.json",
    "explicit-insufficient.render.response.json",
    "explicit-branch.detokenize-sufficient.request.json",
    "explicit-branch.detokenize-sufficient.response.json",
    "explicit-branch.detokenize-insufficient.request.json",
    "explicit-branch.detokenize-insufficient.response.json",
    "explicit-j.request.json",
    "explicit-j.response.json",
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def original_request(state: dict[str, Any]) -> dict[str, Any]:
    return read_json(Path(state["capture_dir"]) / "request.body")


def assert_render_contexts(
    directory: Path, state: dict[str, Any], failures: list[str]
) -> None:
    original = original_request(state)
    native = read_json(directory / "native-sufficient.render.request.json")
    explicit = read_json(directory / "explicit-sufficient.render.request.json")
    if native["messages"][:-1] != original["messages"]:
        failures.append(f"{directory}: native context differs from capture")
    if native["messages"][-1].get("role") != "assistant":
        failures.append(f"{directory}: malformed native completion suffix")
    if explicit["messages"][:-2] != original["messages"]:
        failures.append(f"{directory}: explicit frozen context differs from capture")
    expected_prompt = {"role": "user", "content": EXPLICIT_SUFFICIENCY_PROMPT}
    if explicit["messages"][-2] != expected_prompt:
        failures.append(f"{directory}: explicit prompt mismatch")


def audit_result(
    result_path: Path,
    expected_state: dict[str, Any],
    expected_replica: str,
    expected_samples: int,
    failures: list[str],
) -> dict[str, Any] | None:
    directory = result_path.parent
    try:
        result = read_json(result_path)
        state = read_json(directory / "input-state.json")
    except BaseException as error:
        failures.append(f"{result_path}: unreadable: {error!r}")
        return None
    for field in ("question_id", "decision_step", "capture_id", "request_sha256"):
        if result.get(field) != expected_state.get(field):
            failures.append(f"{result_path}: {field} mismatch")
    if state != expected_state:
        failures.append(f"{result_path}: input-state does not match index")
    if result.get("replica") != expected_replica:
        failures.append(f"{result_path}: replica mismatch")

    existing_raw = {path.name for path in directory.glob("*.json")}
    missing_raw = sorted(REQUIRED_RAW_FILES - existing_raw)
    if missing_raw:
        failures.append(f"{result_path}: missing raw files {missing_raw}")

    explicit = result.get("explicit_j", {})
    tokens = explicit.get("sampled_token_ids", [])
    branches = explicit.get("branch_token_ids", {})
    sufficient_token = branches.get("sufficient")
    insufficient_token = branches.get("insufficient")
    if explicit.get("prompt") != EXPLICIT_SUFFICIENCY_PROMPT:
        failures.append(f"{result_path}: explicit prompt summary mismatch")
    if explicit.get("sample_count") != expected_samples or len(tokens) != expected_samples:
        failures.append(f"{result_path}: explicit sample count mismatch")
    if set(tokens) - {sufficient_token, insufficient_token}:
        failures.append(f"{result_path}: invalid explicit tokens")
    sufficient_count = tokens.count(sufficient_token)
    if explicit.get("sufficient_count") != sufficient_count:
        failures.append(f"{result_path}: sufficient count mismatch")
    if explicit.get("insufficient_count") != len(tokens) - sufficient_count:
        failures.append(f"{result_path}: insufficient count mismatch")
    expected_j = sufficient_count / len(tokens) if tokens else math.nan
    if not math.isclose(
        float(explicit.get("sufficient_fraction", math.nan)), expected_j, abs_tol=1e-15
    ):
        failures.append(f"{result_path}: J mismatch")
    for size in PREFIX_SAMPLE_SIZES:
        if size > len(tokens):
            continue
        expected_prefix = tokens[:size].count(sufficient_token) / size
        recorded = explicit.get("prefix_estimates", {}).get(str(size))
        if recorded is None or not math.isclose(
            float(recorded), expected_prefix, abs_tol=1e-15
        ):
            failures.append(f"{result_path}: J prefix {size} mismatch")

    raw_j_request = read_json(directory / "explicit-j.request.json")
    raw_j_response = read_json(directory / "explicit-j.response.json")
    raw_j_tokens = [
        int(choice["token_ids"][0])
        for choice in raw_j_response.get("body", {}).get("choices", [])
    ]
    if raw_j_request.get("n") != expected_samples or raw_j_tokens != tokens:
        failures.append(f"{result_path}: raw J does not reproduce summary")
    if set(raw_j_request.get("allowed_token_ids", [])) != {
        sufficient_token,
        insufficient_token,
    }:
        failures.append(f"{result_path}: raw J constraint mismatch")

    native = result.get("native_s", {})
    logprobs = native.get("logprobs", {})
    sufficient_logprob = float(logprobs.get("sufficient", math.nan))
    insufficient_logprob = float(logprobs.get("insufficient", math.nan))
    maximum = max(sufficient_logprob, insufficient_logprob)
    expected_s = math.exp(sufficient_logprob - maximum) / (
        math.exp(sufficient_logprob - maximum)
        + math.exp(insufficient_logprob - maximum)
    )
    if not math.isclose(
        float(native.get("sufficient_likelihood", math.nan)), expected_s, abs_tol=1e-12
    ):
        failures.append(f"{result_path}: S softmax mismatch")
    raw_s_request = read_json(directory / "native-s.request.json")
    if set(raw_s_request.get("allowed_token_ids", [])) != set(
        native.get("branch_token_ids", {}).values()
    ) or raw_s_request.get("logprobs") != 2:
        failures.append(f"{result_path}: raw S constraint mismatch")

    try:
        assert_render_contexts(directory, state, failures)
    except BaseException as error:
        failures.append(f"{result_path}: context audit failed: {error!r}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--replica", action="append", required=True)
    parser.add_argument("--samples", type=int, default=101)
    args = parser.parse_args()

    root = args.experiment_root.resolve()
    states = [
        json.loads(line)
        for line in (root / "decision-states-v2/index.jsonl").read_text().splitlines()
        if line
    ]
    validation = read_json(root / "decision-states-v2/validation.json")
    failures: list[str] = []
    if validation.get("question_count") != 100:
        failures.append("decision-state validation does not contain 100 questions")
    if validation.get("decision_state_count") != len(states):
        failures.append("decision-state count disagrees with validation")
    if validation.get("failed_capture_count") != 0:
        failures.append("decision-state validation contains failed captures")
    grouped: dict[str, list[int]] = {}
    seen_captures: set[str] = set()
    for state in states:
        grouped.setdefault(state["question_id"], []).append(state["decision_step"])
        if state["capture_id"] in seen_captures:
            failures.append(f"duplicate capture id {state['capture_id']}")
        seen_captures.add(state["capture_id"])
        capture_request = Path(state["capture_dir"]) / "request.body"
        digest = hashlib.sha256(capture_request.read_bytes()).hexdigest()
        if digest != state["request_sha256"]:
            failures.append(f"capture request digest mismatch {state['capture_id']}")
    if len(grouped) != 100:
        failures.append(f"expected 100 trajectories, found {len(grouped)}")
    for question_id, steps in grouped.items():
        if sorted(steps) != list(range(1, len(steps) + 1)):
            failures.append(f"non-contiguous decision steps for {question_id}")

    checked = 0
    j_values: list[float] = []
    s_values: list[float] = []
    for state in states:
        question_hash = hashlib.sha256(state["question_id"].encode()).hexdigest()[:12]
        for replica in args.replica:
            result_path = (
                root
                / "probes-v2"
                / question_hash
                / f"step-{state['decision_step']:03d}"
                / replica
                / "result.json"
            )
            if not result_path.exists():
                failures.append(f"missing result {result_path}")
                continue
            result = audit_result(
                result_path, state, replica, args.samples, failures
            )
            if result is not None:
                checked += 1
                j_values.append(result["explicit_j"]["sufficient_fraction"])
                s_values.append(result["native_s"]["sufficient_likelihood"])

    summary = {
        "schema_version": 1,
        "experiment_root": str(root),
        "question_count": len(grouped),
        "decision_state_count": len(states),
        "replicas": args.replica,
        "expected_result_count": len(states) * len(args.replica),
        "checked_result_count": checked,
        "samples_per_state_per_replica": args.samples,
        "total_explicit_labels_checked": checked * args.samples,
        "j_range": [min(j_values), max(j_values)] if j_values else None,
        "s_range": [min(s_values), max(s_values)] if s_values else None,
        "failure_count": len(failures),
        "failures": failures,
    }
    output = root / "measurement-v2-audit.json"
    output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    print(json.dumps(summary, indent=2, sort_keys=True))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
