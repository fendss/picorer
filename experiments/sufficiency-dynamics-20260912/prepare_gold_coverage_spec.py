#!/usr/bin/env python3
"""Build the official MQuAKE gold-hop specification used to compute state R."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import pyarrow.parquet as parquet


def normalize_text(value: str) -> str:
    return " ".join(value.casefold().strip().rstrip(".").split())


def numbered_lines(context: str) -> dict[str, tuple[int, str]]:
    result: dict[str, tuple[int, str]] = {}
    for raw in context.splitlines():
        match = re.match(r"^(\d+)\.\s*(.*)$", raw)
        if not match:
            continue
        body = match.group(2).strip().rstrip(".")
        key = normalize_text(body)
        # This benchmark contains a small number of verbatim duplicate facts.
        # Match the existing oracle implementation by retaining the last line.
        result[key] = (int(match.group(1)), raw)
    return result


def atomic_json(path: Path, document: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as destination:
        json.dump(document, destination, ensure_ascii=False, indent=2)
        destination.write("\n")
        temporary = Path(destination.name)
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--benchmark-parquet", type=Path, required=True)
    parser.add_argument("--mquake", type=Path, required=True)
    parser.add_argument("--dataset-audit", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    frame = parquet.read_table(args.benchmark_parquet).to_pylist()
    candidates = []
    for row in frame:
        qa_pair_ids = list(row["metadata"]["qa_pair_ids"])
        if qa_pair_ids and str(qa_pair_ids[0]).startswith(
            "factconsolidation_mh_262k_"
        ):
            candidates.append(row)
    if len(candidates) != 1:
        raise ValueError(f"expected one 262k benchmark row, found {len(candidates)}")
    row = candidates[0]

    source = json.loads(args.mquake.read_text(encoding="utf-8"))
    source_by_question = {
        question: case for case in source for question in case.get("questions", [])
    }
    audit = json.loads(args.dataset_audit.read_text(encoding="utf-8"))
    affected = {int(item["index"]): item for item in audit["affected_262k"]}
    facts = numbered_lines(str(row["context"]))

    questions = []
    qa_pair_ids = [str(value) for value in row["metadata"]["qa_pair_ids"]]
    benchmark_questions = [str(value) for value in row["questions"]]
    benchmark_answers = [list(map(str, values)) for values in row["answers"]]
    if not (
        len(qa_pair_ids) == len(benchmark_questions) == len(benchmark_answers) == 100
    ):
        raise ValueError("expected 100 aligned 262k questions, answers, and QA IDs")

    for ordinal, (qa_pair_id, question, answers) in enumerate(
        zip(qa_pair_ids, benchmark_questions, benchmark_answers)
    ):
        case = source_by_question.get(question)
        if case is None:
            raise ValueError(f"MQuAKE case missing for question {ordinal}: {question}")
        hops = []
        for hop_index, hop in enumerate(case["new_single_hops"], start=1):
            statement = f'{str(hop["cloze"]).rstrip()} {hop["answer"]}'
            normalized = normalize_text(statement)
            matched = facts.get(normalized)
            if matched is None:
                raise ValueError(
                    f"gold hop absent from knowledge pool for question {ordinal}: {statement}"
                )
            serial_number, raw_fact = matched
            hops.append(
                {
                    "hop_index": hop_index,
                    "cloze": str(hop["cloze"]),
                    "answer": str(hop["answer"]),
                    "statement": statement,
                    "normalized_statement": normalized,
                    "serial_number": serial_number,
                    "raw_fact": raw_fact,
                }
            )
        affected_item = affected.get(ordinal)
        questions.append(
            {
                "ordinal": ordinal,
                "qa_pair_id": qa_pair_id,
                "question": question,
                "answers": answers,
                "gold_hops": hops,
                "official_gold_lww_conflicted": affected_item is not None,
                "global_lww_complete": (
                    bool(affected_item["global_lww_complete"])
                    if affected_item is not None
                    else True
                ),
                "global_lww_answer": (
                    affected_item.get("global_lww_answer")
                    if affected_item is not None
                    else answers[0]
                ),
            }
        )

    document = {
        "schema_version": 1,
        "benchmark": "AgentMemoryBench fact-mh-262k",
        "gold_definition": "official_mquake_label_chain",
        "coverage_definition": (
            "R(q,t) is the fraction of official MQuAKE gold-hop statements present "
            "in the exact source text visible from successful read calls before decision "
            "state t; query-focused truncation is respected and search previews are excluded"
        ),
        "source_files": {
            "benchmark_parquet": str(args.benchmark_parquet.resolve()),
            "mquake": str(args.mquake.resolve()),
            "dataset_audit": str(args.dataset_audit.resolve()),
        },
        "question_count": len(questions),
        "questions": questions,
    }
    atomic_json(args.output, document)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "questions": len(questions),
                "gold_hops": sum(len(item["gold_hops"]) for item in questions),
                "conflicted_questions": sum(
                    item["official_gold_lww_conflicted"] for item in questions
                ),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
