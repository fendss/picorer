#!/usr/bin/env python3
"""Compute official gold-evidence coverage R for every captured decision state."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import sqlite3
import statistics
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


REPLICAS = ("qwen-r1", "qwen-r2")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def normalize_text(value: str) -> str:
    return " ".join(value.casefold().strip().rstrip(".").split())


def atomic_json(path: Path, document: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as destination:
        json.dump(document, destination, ensure_ascii=False, indent=2)
        destination.write("\n")
        temporary = Path(destination.name)
    os.replace(temporary, path)


def atomic_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as destination:
        for row in rows:
            destination.write(json.dumps(row, ensure_ascii=False) + "\n")
        temporary = Path(destination.name)
    os.replace(temporary, path)


def csv_value(value: Any) -> Any:
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return value


def atomic_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        raise ValueError(f"refusing to write empty CSV: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", newline="", dir=path.parent, delete=False
    ) as destination:
        writer = csv.DictWriter(destination, fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows:
            writer.writerow({key: csv_value(value) for key, value in row.items()})
        temporary = Path(destination.name)
    os.replace(temporary, path)


def load_scores(root: Path) -> dict[str, float]:
    scores: dict[str, float] = {}
    for path in (root / "artifacts-scoring").glob("*/evaluation.json"):
        evaluation = read_json(path)
        question_id = str(evaluation["question_id"])
        if question_id in scores:
            raise ValueError(f"duplicate evaluation for {question_id}")
        scores[question_id] = float(
            evaluation["output"]["metrics"]["official_score"]
        )
    return scores


def map_audits(root: Path) -> dict[str, dict[str, Any]]:
    query_to_id: dict[str, str] = {}
    # The first experiment retained its eight validated canary trajectories in
    # artifacts-canary and the remaining trajectories in artifacts-main.
    for artifact_dir in ("artifacts-canary", "artifacts-main"):
        for path in (root / artifact_dir).glob("*/retrieval.json"):
            retrieval = read_json(path)
            question_id = str(retrieval["question_id"])
            query = str(retrieval["output"]["formatted_query"])
            if query in query_to_id:
                raise ValueError(f"duplicate formatted query for {question_id}")
            query_to_id[query] = question_id
    result: dict[str, dict[str, Any]] = {}
    for audit in read_jsonl(root / "runtime/memory-service/wrap-audits.jsonl"):
        query = str(audit["question"])
        question_id = query_to_id.get(query)
        if question_id is None:
            raise ValueError(f"wrap audit has no matching retrieval artifact: {query[:100]}")
        if question_id in result:
            raise ValueError(f"duplicate wrap audit for {question_id}")
        result[question_id] = audit
    return result


def read_memory_ids(trace_entry: dict[str, Any]) -> list[str]:
    if trace_entry.get("toolName") != "read" or trace_entry.get("isError"):
        return []
    details = trace_entry.get("details") or {}
    evidence = details.get("evidence") or []
    ids = [str(item["memoryId"]) for item in evidence if item.get("memoryId")]
    if not ids:
        ids = [str(value) for value in details.get("requestedMemoryIds", [])]
    return list(dict.fromkeys(ids))


def read_evidence_items(trace_entry: dict[str, Any]) -> list[dict[str, Any]]:
    if trace_entry.get("toolName") != "read" or trace_entry.get("isError"):
        return []
    details = trace_entry.get("details") or {}
    evidence = details.get("evidence") or []
    if evidence:
        return evidence
    return [
        {"memoryId": memory_id, "truncated": False}
        for memory_id in details.get("requestedMemoryIds", [])
    ]


def visible_source_text(evidence: dict[str, Any], full_content: str) -> str:
    source_length = evidence.get("sourceContentLength")
    if source_length is not None and int(source_length) != len(full_content):
        raise ValueError(
            f"source length mismatch for {evidence.get('memoryId')}: "
            f"database={len(full_content)} audit={source_length}"
        )
    if not evidence.get("truncated"):
        return full_content
    excerpts = evidence.get("excerpts") or []
    if not excerpts:
        raise ValueError(
            f"truncated evidence has no excerpt ranges: {evidence.get('memoryId')}"
        )
    parts = []
    previous_end = -1
    for excerpt in excerpts:
        start = int(excerpt["start"])
        end = int(excerpt["end"])
        if start < 0 or end <= start or end > len(full_content):
            raise ValueError(
                f"invalid excerpt range for {evidence.get('memoryId')}: {start}:{end}"
            )
        if start < previous_end:
            raise ValueError(
                f"overlapping excerpt ranges for {evidence.get('memoryId')}"
            )
        parts.append(full_content[start:end])
        previous_end = end
    # The explicit separator prevents a fact from matching across two excerpts.
    return "\n<EXCERPT_BREAK>\n".join(parts)


def load_memory_contents(database: Path, memory_ids: set[str]) -> dict[str, str]:
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        result: dict[str, str] = {}
        ordered = sorted(memory_ids)
        for offset in range(0, len(ordered), 500):
            batch = ordered[offset : offset + 500]
            marks = ",".join("?" for _ in batch)
            for memory_id, content in connection.execute(
                f"SELECT memory_id, content FROM memories WHERE memory_id IN ({marks})",
                batch,
            ):
                result[str(memory_id)] = str(content)
        missing = memory_ids - set(result)
        if missing:
            raise ValueError(
                f"{len(missing)} read memory IDs missing from database; examples: "
                + ", ".join(sorted(missing)[:5])
            )
        return result
    finally:
        connection.close()


def expected_result_path(root: Path, state: dict[str, Any], replica: str) -> Path:
    question_hash = hashlib.sha256(state["question_id"].encode()).hexdigest()[:12]
    return (
        root
        / "probes-v2"
        / question_hash
        / f"step-{int(state['decision_step']):03d}"
        / replica
        / "result.json"
    )


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


def coverage_distribution(values: Iterable[float]) -> dict[str, int]:
    counts = Counter(f"{value:.6g}" for value in values)
    return dict(sorted(counts.items(), key=lambda item: float(item[0])))


def summarize_subset(rows: list[dict[str, Any]]) -> dict[str, Any]:
    values = [float(row["gold_coverage_r"]) for row in rows]
    return {
        "states": len(rows),
        "mean_r": statistics.fmean(values) if values else None,
        "zero_r": sum(value == 0 for value in values),
        "full_r": sum(value == 1 for value in values),
        "distribution": coverage_distribution(values),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--gold-spec", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    root = args.experiment_root.resolve()
    output = (args.output_dir or root / "coverage-v1").resolve()

    manifest = read_json(root / "manifest-full.json")
    manifest_questions = manifest["questions"]
    manifest_by_id = {str(item["id"]): item for item in manifest_questions}
    question_order = [str(item["id"]) for item in manifest_questions]
    if len(manifest_by_id) != len(manifest_questions):
        raise ValueError("manifest contains duplicate question IDs")

    gold_spec = read_json(args.gold_spec)
    gold_by_qa = {
        str(item["qa_pair_id"]): item for item in gold_spec["questions"]
    }
    if len(gold_by_qa) != len(gold_spec["questions"]):
        raise ValueError("gold specification contains duplicate QA IDs")

    states = read_jsonl(root / "decision-states-v2/index.jsonl")
    states_by_question: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for state in states:
        states_by_question[str(state["question_id"])].append(state)
    for question_id, items in states_by_question.items():
        items.sort(key=lambda item: int(item["decision_step"]))
        steps = [int(item["decision_step"]) for item in items]
        if steps != list(range(1, len(items) + 1)):
            raise ValueError(f"non-contiguous decision states for {question_id}: {steps}")
        if any(int(item["decision_state_count"]) != len(items) for item in items):
            raise ValueError(f"wrong decision_state_count for {question_id}")

    audits = map_audits(root)
    scores = load_scores(root)
    expected_questions = set(question_order)
    for label, actual in (
        ("decision states", set(states_by_question)),
        ("wrap audits", set(audits)),
        ("official scores", set(scores)),
    ):
        if actual != expected_questions:
            raise ValueError(
                f"{label} question IDs differ from manifest: "
                f"missing={len(expected_questions-actual)}, extra={len(actual-expected_questions)}"
            )

    all_read_ids: set[str] = set()
    for audit in audits.values():
        for trace_entry in audit["retrieval"]["trace"]:
            all_read_ids.update(read_memory_ids(trace_entry))
    memory_contents = load_memory_contents(
        root / "runtime/memory-service/memory.sqlite", all_read_ids
    )
    state_rows: list[dict[str, Any]] = []
    hop_rows: list[dict[str, Any]] = []
    trace_action_count = 0
    read_evidence_item_count = 0
    truncated_read_evidence_item_count = 0
    for question_id in question_order:
        manifest_item = manifest_by_id[question_id]
        payload = manifest_item["payload"]
        qa_pair_id = str(payload["qa_pair_id"])
        gold = gold_by_qa.get(qa_pair_id)
        if gold is None:
            raise ValueError(f"gold specification missing {qa_pair_id}")
        if normalize_text(str(payload["question"])) != normalize_text(gold["question"]):
            raise ValueError(f"question mismatch for {qa_pair_id}")

        question_states = states_by_question[question_id]
        trajectory_length = len(question_states)
        trace = audits[question_id]["retrieval"]["trace"]
        trace_cursor = 0
        covered: set[int] = set()
        previous_emitted: set[int] = set()
        cumulative_read_ids: list[str] = []
        first_acquisition: dict[int, dict[str, Any]] = {}
        matching_read_ids_by_hop: dict[int, list[str]] = defaultdict(list)
        hops = gold["gold_hops"]

        for state in question_states:
            step = int(state["decision_step"])
            covered_now = sorted(covered)
            newly_available = sorted(covered - previous_emitted)
            previous_emitted = set(covered)
            state_rows.append(
                {
                    "schema_version": 1,
                    "gold_definition": gold_spec["gold_definition"],
                    "question_id": question_id,
                    "qa_pair_id": qa_pair_id,
                    "question_ordinal": int(manifest_item["ordinal"]),
                    "decision_step": step,
                    "decision_state_count": trajectory_length,
                    "normalized_progress": float(state["normalized_progress"]),
                    "capture_id": str(state["capture_id"]),
                    "action_tool_names": [
                        str(call["name"]) for call in state["action_tool_calls"]
                    ],
                    "terminal_trajectory_status": str(
                        state["terminal_trajectory_status"]
                    ),
                    "gold_hop_count": len(hops),
                    "covered_hop_count": len(covered_now),
                    "gold_coverage_r": len(covered_now) / len(hops),
                    "covered_hop_indices": covered_now,
                    "missing_hop_indices": sorted(
                        set(range(1, len(hops) + 1)) - covered
                    ),
                    "newly_available_hop_indices": newly_available,
                    "cumulative_read_memory_count": len(cumulative_read_ids),
                    "cumulative_read_memory_ids": list(cumulative_read_ids),
                    "official_gold_lww_conflicted": bool(
                        gold["official_gold_lww_conflicted"]
                    ),
                    "final_official_score": float(scores[question_id]),
                    "final_correct": float(scores[question_id]) > 0,
                }
            )

            for action in state["action_tool_calls"]:
                if trace_cursor >= len(trace):
                    raise ValueError(f"state actions exceed trace for {question_id}")
                trace_entry = trace[trace_cursor]
                trace_cursor += 1
                trace_action_count += 1
                if str(action["name"]) != str(trace_entry["toolName"]):
                    raise ValueError(
                        f"tool mismatch {question_id} state {step}: "
                        f"capture={action['name']} trace={trace_entry['toolName']}"
                    )
                if action.get("tool_call_id") != trace_entry.get("toolCallId"):
                    raise ValueError(
                        f"tool call ID mismatch {question_id} state {step}"
                    )
                for evidence in read_evidence_items(trace_entry):
                    read_evidence_item_count += 1
                    truncated_read_evidence_item_count += int(
                        bool(evidence.get("truncated"))
                    )
                    memory_id = str(evidence["memoryId"])
                    if memory_id not in cumulative_read_ids:
                        cumulative_read_ids.append(memory_id)
                    memory_text = normalize_text(
                        visible_source_text(evidence, memory_contents[memory_id])
                    )
                    for hop in hops:
                        hop_index = int(hop["hop_index"])
                        if hop["normalized_statement"] not in memory_text:
                            continue
                        if memory_id not in matching_read_ids_by_hop[hop_index]:
                            matching_read_ids_by_hop[hop_index].append(memory_id)
                        if hop_index not in first_acquisition:
                            next_state = step + 1 if step < trajectory_length else None
                            first_acquisition[hop_index] = {
                                "first_read_action_state": step,
                                "first_available_decision_state": next_state,
                                "first_memory_id": memory_id,
                            }
                        covered.add(hop_index)

        if trace_cursor != len(trace):
            raise ValueError(
                f"unconsumed trace actions for {question_id}: "
                f"{trace_cursor}/{len(trace)}"
            )
        for hop in hops:
            hop_index = int(hop["hop_index"])
            acquisition = first_acquisition.get(hop_index, {})
            matching_ids = matching_read_ids_by_hop[hop_index]
            hop_rows.append(
                {
                    "schema_version": 1,
                    "question_id": question_id,
                    "qa_pair_id": qa_pair_id,
                    "question_ordinal": int(manifest_item["ordinal"]),
                    "hop_index": hop_index,
                    "gold_hop_count": len(hops),
                    "gold_statement": hop["statement"],
                    "gold_raw_fact": hop["raw_fact"],
                    "gold_serial_number": int(hop["serial_number"]),
                    "acquired_by_read": bool(matching_ids),
                    "first_read_action_state": acquisition.get(
                        "first_read_action_state"
                    ),
                    "first_available_decision_state": acquisition.get(
                        "first_available_decision_state"
                    ),
                    "matching_read_memory_ids": matching_ids,
                    "official_gold_lww_conflicted": bool(
                        gold["official_gold_lww_conflicted"]
                    ),
                }
            )

    state_by_key = {
        (row["question_id"], row["decision_step"]): row for row in state_rows
    }
    replica_rows: list[dict[str, Any]] = []
    for state in states:
        key = (str(state["question_id"]), int(state["decision_step"]))
        coverage = state_by_key[key]
        for replica in REPLICAS:
            result_path = expected_result_path(root, state, replica)
            if not result_path.exists():
                raise ValueError(f"missing probe result: {result_path}")
            result = read_json(result_path)
            explicit = result["explicit_j"]
            native = result["native_s"]
            logprobs = native["logprobs"]
            if (
                str(result["question_id"]),
                int(result["decision_step"]),
                str(result["replica"]),
            ) != (key[0], key[1], replica):
                raise ValueError(f"probe metadata mismatch: {result_path}")
            margin = float(logprobs["sufficient"]) - float(
                logprobs["insufficient"]
            )
            replica_rows.append(
                {
                    **coverage,
                    "replica": replica,
                    "j_sample_count": int(explicit["sample_count"]),
                    "j_sufficient_count": int(explicit["sufficient_count"]),
                    "j_insufficient_count": int(explicit["insufficient_count"]),
                    "j_sufficient_fraction": float(
                        explicit["sufficient_fraction"]
                    ),
                    "native_sufficient_likelihood": float(
                        native["sufficient_likelihood"]
                    ),
                    "native_sufficient_logprob": float(logprobs["sufficient"]),
                    "native_insufficient_logprob": float(logprobs["insufficient"]),
                    "native_logit_margin": margin,
                    "native_margin_decision": (
                        "sufficient"
                        if margin > 0
                        else "insufficient"
                        if margin < 0
                        else "tie"
                    ),
                }
            )

    monotonic_violations = []
    terminal_rows = []
    initial_rows = []
    for question_id in question_order:
        rows = [row for row in state_rows if row["question_id"] == question_id]
        values = [float(row["gold_coverage_r"]) for row in rows]
        if any(right < left for left, right in zip(values, values[1:])):
            monotonic_violations.append(question_id)
        initial_rows.append(rows[0])
        terminal_rows.append(rows[-1])

    progress = {}
    for band in ("(0,.2]", "(.2,.4]", "(.4,.6]", "(.6,.8]", "(.8,1]"):
        subset = [
            row
            for row in state_rows
            if progress_band(float(row["normalized_progress"])) == band
        ]
        progress[band] = summarize_subset(subset)

    summary = {
        "schema_version": 1,
        "experiment_root": str(root),
        "gold_definition": gold_spec["gold_definition"],
        "coverage_definition": gold_spec["coverage_definition"],
        "alignment_semantics": (
            "Each row describes the frozen context before that state's action. "
            "Evidence read by state t is first included in R at state t+1."
        ),
        "search_previews_count_as_evidence": False,
        "questions": len(question_order),
        "decision_states": len(state_rows),
        "state_replica_rows": len(replica_rows),
        "replicas": list(REPLICAS),
        "j_samples_per_state_replica": sorted(
            set(row["j_sample_count"] for row in replica_rows)
        ),
        "gold_hops": len(hop_rows),
        "read_memory_ids": len(all_read_ids),
        "read_evidence_items": read_evidence_item_count,
        "truncated_read_evidence_items": truncated_read_evidence_item_count,
        "trace_actions": trace_action_count,
        "initial_states": summarize_subset(initial_rows),
        "all_states": summarize_subset(state_rows),
        "terminal_states": summarize_subset(terminal_rows),
        "terminal_questions_full_coverage": sum(
            row["gold_coverage_r"] == 1 for row in terminal_rows
        ),
        "terminal_questions_partial_coverage": sum(
            0 < row["gold_coverage_r"] < 1 for row in terminal_rows
        ),
        "terminal_questions_zero_coverage": sum(
            row["gold_coverage_r"] == 0 for row in terminal_rows
        ),
        "hops_acquired_by_read": sum(row["acquired_by_read"] for row in hop_rows),
        "hops_never_acquired": sum(not row["acquired_by_read"] for row in hop_rows),
        "states_where_r_increases": sum(
            bool(row["newly_available_hop_indices"]) for row in state_rows
        ),
        "monotonicity_violations": monotonic_violations,
        "by_progress_band": progress,
        "by_dataset_status": {
            "lww_clean": summarize_subset(
                [row for row in state_rows if not row["official_gold_lww_conflicted"]]
            ),
            "lww_conflicted": summarize_subset(
                [row for row in state_rows if row["official_gold_lww_conflicted"]]
            ),
        },
        "terminal_by_correctness": {
            "correct": summarize_subset(
                [row for row in terminal_rows if row["final_correct"]]
            ),
            "incorrect": summarize_subset(
                [row for row in terminal_rows if not row["final_correct"]]
            ),
        },
        "validation": {
            "manifest_questions_match_states_audits_scores": True,
            "state_steps_contiguous": True,
            "state_actions_match_trace_names_and_ids": True,
            "all_read_memory_ids_resolved": True,
            "all_excerpt_ranges_valid": True,
            "all_probe_results_present": True,
            "coverage_in_unit_interval": all(
                0 <= float(row["gold_coverage_r"]) <= 1 for row in state_rows
            ),
            "coverage_monotonic_per_question": not monotonic_violations,
            "all_initial_states_zero": all(
                row["gold_coverage_r"] == 0 for row in initial_rows
            ),
        },
        "outputs": {
            "states_jsonl": str(output / "states.jsonl"),
            "states_csv": str(output / "states.csv"),
            "hops_jsonl": str(output / "hops.jsonl"),
            "hops_csv": str(output / "hops.csv"),
            "state_replica_jsonl": str(output / "state-replica.jsonl"),
            "state_replica_csv": str(output / "state-replica.csv"),
        },
    }

    atomic_jsonl(output / "states.jsonl", state_rows)
    atomic_csv(output / "states.csv", state_rows)
    atomic_jsonl(output / "hops.jsonl", hop_rows)
    atomic_csv(output / "hops.csv", hop_rows)
    atomic_jsonl(output / "state-replica.jsonl", replica_rows)
    atomic_csv(output / "state-replica.csv", replica_rows)
    atomic_json(output / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
