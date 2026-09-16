#!/usr/bin/env python3
"""Forensic consistency audit for the Picorer sufficiency experiment."""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import statistics
from pathlib import Path
from typing import Any


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def pearson(left: list[float], right: list[float]) -> float:
    left_mean = mean(left)
    right_mean = mean(right)
    numerator = sum(
        (x - left_mean) * (y - right_mean) for x, y in zip(left, right)
    )
    left_scale = sum((x - left_mean) ** 2 for x in left)
    right_scale = sum((y - right_mean) ** 2 for y in right)
    return numerator / math.sqrt(left_scale * right_scale)


def ranks(values: list[float]) -> list[float]:
    result = [0.0] * len(values)
    order = sorted(range(len(values)), key=values.__getitem__)
    offset = 0
    while offset < len(order):
        end = offset + 1
        while end < len(order) and values[order[end]] == values[order[offset]]:
            end += 1
        rank = (offset + end - 1) / 2 + 1
        for index in order[offset:end]:
            result[index] = rank
        offset = end
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-root", type=Path, required=True)
    args = parser.parse_args()
    root = args.experiment_root.resolve()
    failures: list[str] = []

    manifest = read_json(root / "manifest-full.json")
    questions = manifest["questions"]
    question_ids = [str(question["id"]) for question in questions]
    nonempty_keypoint_questions = sum(
        bool(question.get("payload", {}).get("keypoints")) for question in questions
    )
    if len(questions) != 100 or len(set(question_ids)) != 100:
        failures.append("manifest does not contain 100 unique questions")
    ordinals = sorted(int(question["ordinal"]) for question in questions)
    if ordinals != list(range(100)):
        failures.append("manifest ordinals are not exactly 0..99")

    artifact_paths = list((root / "artifacts-canary").glob("*/retrieval.json"))
    artifact_paths += list((root / "artifacts-main").glob("*/retrieval.json"))
    artifact_ids = [str(read_json(path)["question_id"]) for path in artifact_paths]
    if len(artifact_ids) != 100 or set(artifact_ids) != set(question_ids):
        failures.append("retrieval artifacts do not cover the manifest exactly once")

    audit_path = root / "runtime" / "memory-service" / "wrap-audits.jsonl"
    wrap_audits = [json.loads(line) for line in audit_path.read_text().splitlines()]
    if len(wrap_audits) != 100:
        failures.append(f"expected 100 wrap audits, found {len(wrap_audits)}")

    capture_paths = sorted((root / "captures").glob("*/meta.json"))
    capture_path_counts: collections.Counter[str] = collections.Counter()
    acquisition_upstreams: collections.Counter[str] = collections.Counter()
    capture_hash_failures: list[str] = []
    chat_captures: dict[str, dict[str, Any]] = {}
    chat_response_dispositions: dict[str, str] = {}
    request_hashes: collections.Counter[str] = collections.Counter()
    for meta_path in capture_paths:
        meta = read_json(meta_path)
        capture_path_counts[str(meta["path"])] += 1
        request_path = meta_path.parent / "request.body"
        response_path = meta_path.parent / "response.body"
        if sha256(request_path) != meta["request_sha256"]:
            capture_hash_failures.append(f"{meta['request_id']}:request")
        if sha256(response_path) != meta["response_sha256"]:
            capture_hash_failures.append(f"{meta['request_id']}:response")
        if meta.get("path") == "/v1/chat/completions":
            if meta.get("capture_state") != "complete" or meta.get("response_status") != 200:
                failures.append(f"non-successful chat capture {meta['request_id']}")
            capture_id = str(meta["request_id"])
            chat_captures[capture_id] = meta
            response_body = read_json(response_path)
            message = response_body.get("choices", [{}])[0].get("message", {})
            tool_calls = message.get("tool_calls") or []
            if tool_calls:
                tool_names = "+".join(
                    str(call.get("function", {}).get("name", "unknown"))
                    for call in tool_calls
                )
                chat_response_dispositions[capture_id] = f"tool:{tool_names}"
            elif message.get("content"):
                chat_response_dispositions[capture_id] = "content_without_tool"
            else:
                chat_response_dispositions[capture_id] = "empty_without_tool"
            request_hashes[str(meta["request_sha256"])] += 1
            acquisition_upstreams[
                str(meta.get("response_headers", {}).get("x-qwen-upstream"))
            ] += 1
    if capture_hash_failures:
        failures.append(f"capture hash failures: {capture_hash_failures[:10]}")
    if len(chat_captures) != 694:
        failures.append(f"expected 694 chat captures, found {len(chat_captures)}")

    index_rows = [
        json.loads(line)
        for line in (root / "decision-states" / "index.jsonl").read_text().splitlines()
    ]
    index_by_capture = {str(row["capture_id"]): row for row in index_rows}
    if len(index_rows) != 694 or len(index_by_capture) != 694:
        failures.append("decision-state index is not 694 unique captures")
    if set(index_by_capture) != set(chat_captures):
        failures.append("decision-state index and chat captures differ")
    per_question_steps: dict[str, list[int]] = collections.defaultdict(list)
    for row in index_rows:
        capture_id = str(row["capture_id"])
        per_question_steps[str(row["question_id"])].append(int(row["decision_step"]))
        meta = chat_captures.get(capture_id)
        if meta is None:
            continue
        if row["request_sha256"] != meta["request_sha256"]:
            failures.append(f"index request hash mismatch for {capture_id}")
        expected_tau = row["decision_step"] / row["decision_state_count"]
        if abs(float(row["normalized_progress"]) - expected_tau) > 1e-15:
            failures.append(f"bad normalized progress for {capture_id}")
    for question_id, steps in per_question_steps.items():
        if sorted(steps) != list(range(1, len(steps) + 1)):
            failures.append(f"non-contiguous decision steps for {question_id}")
    response_disposition_counts = collections.Counter(chat_response_dispositions.values())
    non_tool_decision_states = [
        {
            "capture_id": capture_id,
            "question_id": index_by_capture[capture_id]["question_id"],
            "decision_step": index_by_capture[capture_id]["decision_step"],
            "disposition": disposition,
        }
        for capture_id, disposition in chat_response_dispositions.items()
        if not disposition.startswith("tool:")
    ]

    validation = read_json(root / "decision-states" / "validation.json")
    if validation["question_count"] != 100 or validation["decision_state_count"] != 694:
        failures.append("decision-state validation totals are wrong")
    if validation["transport_failures"]:
        failures.append("decision-state validation records transport failures")
    if not all(
        item.get("trace_aligned") for item in validation["per_question"].values()
    ):
        failures.append("one or more Picorer traces are not aligned")

    probe_paths = sorted((root / "probes").glob("*/step-*.json"))
    probes = [read_json(path) for path in probe_paths]
    probe_by_capture = {str(probe["capture_id"]): probe for probe in probes}
    if len(probes) != 694 or len(probe_by_capture) != 694:
        failures.append("probe results are not 694 unique captures")
    if set(probe_by_capture) != set(index_by_capture):
        failures.append("probe results and decision-state index differ")

    s_values: list[float] = []
    j_values: list[float] = []
    standardized_residuals: list[float] = []
    s_upstreams: collections.Counter[str] = collections.Counter()
    j_upstreams: collections.Counter[str] = collections.Counter()
    render_upstreams: collections.Counter[str] = collections.Counter()
    branch_pairs: collections.Counter[tuple[int, int, str, str]] = collections.Counter()
    sample_total = 0
    for probe in probes:
        capture_id = str(probe["capture_id"])
        state = index_by_capture.get(capture_id)
        if state is None:
            continue
        if probe["request_sha256"] != state["request_sha256"]:
            failures.append(f"probe request hash mismatch for {capture_id}")
        if probe["question_id"] != state["question_id"]:
            failures.append(f"probe question mismatch for {capture_id}")
        if probe["decision_step"] != state["decision_step"]:
            failures.append(f"probe step mismatch for {capture_id}")

        j = probe["j"]
        sufficient_count = int(j["sufficient_count"])
        insufficient_count = int(j["insufficient_count"])
        sample_count = int(j["sample_count"])
        sample_total += sample_count
        if sample_count != 63 or sufficient_count + insufficient_count != 63:
            failures.append(f"bad J sample counts for {capture_id}")
        j_value = float(j["sufficient_fraction"])
        if abs(j_value - sufficient_count / sample_count) > 1e-15:
            failures.append(f"bad J fraction for {capture_id}")

        s = probe["s"]
        s_value = float(s["sufficient_likelihood"])
        sufficient_logprob = float(s["sufficient_logprob"])
        insufficient_logprob = float(s["insufficient_logprob"])
        expected_s = 1 / (1 + math.exp(insufficient_logprob - sufficient_logprob))
        if abs(s_value - expected_s) > 1e-12:
            failures.append(f"bad S softmax for {capture_id}")
        if not (math.isfinite(s_value) and 0 <= s_value <= 1):
            failures.append(f"non-finite S for {capture_id}")

        s_values.append(s_value)
        j_values.append(j_value)
        variance = sample_count * s_value * (1 - s_value)
        if variance > 1e-8:
            standardized_residuals.append(
                (sufficient_count - sample_count * s_value) / math.sqrt(variance)
            )
        s_upstreams[str(s.get("upstream"))] += 1
        j_upstreams[str(j.get("upstream"))] += 1
        render_upstreams.update(map(str, probe.get("render_upstreams", [])))
        tokens = probe["protocol"]["status_branch_tokens"]
        branch_pairs[
            (
                int(tokens["sufficient"]["id"]),
                int(tokens["insufficient"]["id"]),
                str(tokens["sufficient"]["text"]),
                str(tokens["insufficient"]["text"]),
            )
        ] += 1

    mtimes = [path.stat().st_mtime for path in probe_paths]
    duplicate_request_hashes = {
        digest: count for digest, count in request_hashes.items() if count > 1
    }
    residual_abs = [abs(value) for value in standardized_residuals]
    report = {
        "schema_version": 1,
        "audit_failures": failures,
        "integrity": {
            "manifest_questions": len(questions),
            "manifest_questions_with_nonempty_keypoints": nonempty_keypoint_questions,
            "retrieval_artifacts": len(artifact_paths),
            "wrap_audits": len(wrap_audits),
            "capture_paths": dict(capture_path_counts),
            "chat_captures": len(chat_captures),
            "capture_hash_failures": capture_hash_failures,
            "decision_states": len(index_rows),
            "probe_results": len(probes),
            "j_total_sampled_choices": sample_total,
            "duplicate_acquisition_request_hashes": duplicate_request_hashes,
            "chat_response_dispositions": dict(response_disposition_counts),
            "non_tool_decision_states": non_tool_decision_states,
            "raw_j_choice_sequence_persisted": False,
            "raw_s_and_j_http_responses_persisted": False,
        },
        "timing": {
            "first_probe_mtime_unix": min(mtimes),
            "last_probe_mtime_unix": max(mtimes),
            "probe_wall_span_seconds": max(mtimes) - min(mtimes),
        },
        "routing": {
            "acquisition": dict(acquisition_upstreams),
            "s": dict(s_upstreams),
            "j": dict(j_upstreams),
            "render": dict(render_upstreams),
        },
        "protocol": {
            "status_branch_pairs": {
                repr(key): count for key, count in branch_pairs.items()
            },
            "j_is_sampled_from_same_two_branch_logits_used_to_compute_s": True,
            "j_request_count": len(probes),
            "choices_per_j_request": 63,
            "generated_tokens_per_choice": 1,
            "shared_prefill_within_each_j_request": True,
        },
        "numerical": {
            "binary_agreement": mean(
                [
                    float((s_value >= 0.5) == (j_value >= 0.5))
                    for s_value, j_value in zip(s_values, j_values)
                ]
            ),
            "pearson": pearson(s_values, j_values),
            "spearman": pearson(ranks(s_values), ranks(j_values)),
            "mae": mean(
                [abs(s_value - j_value) for s_value, j_value in zip(s_values, j_values)]
            ),
            "mean_s": mean(s_values),
            "mean_j": mean(j_values),
            "standardized_binomial_residual": {
                "count": len(standardized_residuals),
                "mean": mean(standardized_residuals),
                "std": statistics.pstdev(standardized_residuals),
                "max_abs": max(residual_abs),
                "fraction_abs_gt_2": mean(
                    [float(value > 2) for value in residual_abs]
                ),
                "fraction_abs_gt_3": mean(
                    [float(value > 3) for value in residual_abs]
                ),
            },
        },
    }
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
