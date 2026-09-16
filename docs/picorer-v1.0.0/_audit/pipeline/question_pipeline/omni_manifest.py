from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
from typing import Any

from .artifacts import atomic_json
from .eval_config import bind as bind_eval_config

ADAPTER = "question_pipeline.adapters.omnimemeval:OmniMemEvalAdapter"


def _beam_questions(entry: dict[str, Any], ordinal: int):
    data = Path(entry["data"])
    for raw in data.read_text().splitlines():
        if not raw.strip():
            continue
        conversation = json.loads(raw)
        conv_id = str(conversation["conversation_id"])
        probing = conversation.get("probing_questions", {})
        if isinstance(probing, str):
            probing = ast.literal_eval(probing)
        question_index = 0
        for dimension, values in probing.items():
            for question in values:
                key = (
                    f"beam_exp_user_{entry['service_version']}_{conv_id}"
                    f"__q{question_index}"
                )
                golden = (
                    question.get("answer")
                    or question.get("ideal_response")
                    or question.get("ideal_answer")
                    or question.get("ideal_summary")
                    or question.get("expected_compliance", "")
                )
                yield {
                    "id": f"omnimemeval:beam:{entry['scale']}:{key}",
                    "benchmark": f"BEAM {entry['scale'].upper()}",
                    "adapter": ADAPTER,
                    "ordinal": ordinal,
                    "payload": {
                        "suite": "beam",
                        "omni_root": entry["omni_root"],
                        "env_file": entry["env_file"],
                        "top_k": int(entry.get("top_k", 20)),
                        "scale": entry["scale"],
                        "key": key,
                        "conv_id": conv_id,
                        "user_id": f"beam_exp_user_{entry['service_version']}_{conv_id}",
                        "ingestion_version": entry["ingestion_version"],
                        "question_idx": question_index,
                        "dimension": dimension,
                        "question": question.get("question", ""),
                        "golden_answer": golden,
                        "rubric": question.get("rubric", ""),
                        "difficulty": question.get("difficulty", ""),
                    },
                }
                ordinal += 1
                question_index += 1


def _locomo_questions(entry: dict[str, Any], ordinal: int):
    conversations = json.loads(Path(entry["data"]).read_text())
    version = entry["ingestion_version"]
    service_version = entry["service_version"]
    for group_index, conversation in enumerate(conversations):
        detail = conversation["conversation"]
        for question_index, qa in enumerate(conversation["qa"]):
            if qa.get("category") == 5:
                continue
            yield {
                "id": f"omnimemeval:locomo:{group_index}:{question_index}",
                "benchmark": "LoCoMo",
                "adapter": ADAPTER,
                "ordinal": ordinal,
                "payload": {
                    "suite": "locomo",
                    "omni_root": entry["omni_root"],
                    "env_file": entry["env_file"],
                    "top_k": int(entry.get("top_k", 20)),
                    "group_index": group_index,
                    "question_index": question_index,
                    "speaker_a": detail["speaker_a"],
                    "speaker_b": detail["speaker_b"],
                    "speaker_a_user_id": f"locomo_exp_user_{group_index}_speaker_a_{service_version}",
                    "speaker_b_user_id": f"locomo_exp_user_{group_index}_speaker_b_{service_version}",
                    "ingestion_version": version,
                    "question": str(qa.get("question", "")),
                    "golden_answer": qa.get("answer"),
                    "category": qa.get("category"),
                    "evidence": qa.get("evidence", []),
                },
            }
            ordinal += 1


def build(
    specification: dict[str, Any], eval_config_path: Path | None = None
) -> dict[str, Any]:
    questions = []
    ordinal = 0
    for entry in specification.get("beam", []):
        built = list(_beam_questions(entry, ordinal))
        questions.extend(built)
        ordinal += len(built)
    if entry := specification.get("locomo"):
        built = list(_locomo_questions(entry, ordinal))
        questions.extend(built)
    for question in questions:
        question.update({
            "stages": ["retrieval", "answer", "evaluation"],
            "max_attempts": {
                "retrieval": 2,
                "answer": 3,
                "evaluation": 3 if eval_config_path is not None else 1,
            },
        })
        if eval_config_path is not None:
            payload = question["payload"]
            dataset_id = (
                f"omnimemeval/beam-{payload['scale']}"
                if payload["suite"] == "beam"
                else "omnimemeval/locomo"
            )
            payload["eval_config"] = bind_eval_config(
                eval_config_path, dataset_id
            )
    return {"schema_version": 2, "questions": questions}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--eval-config", type=Path)
    args = parser.parse_args(argv)
    manifest = build(json.loads(args.spec.read_text()), args.eval_config)
    atomic_json(args.output, manifest)
    print(json.dumps({"questions": len(manifest["questions"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
