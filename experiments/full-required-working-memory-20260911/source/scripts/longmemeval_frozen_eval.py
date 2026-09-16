#!/usr/bin/env python3
"""Frozen-retrieval re-answering and strict LongMemEval judging."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tqdm import tqdm

ANSWER_PROMPT = """You are asked to answer a question based on your memories of a conversation.

<instructions>
1. Use only the provided memories. Prefer the memory that answers the question most directly.
2. Your memories are episodic raw observations. Reason about what they imply. Do not refuse just because the answer is not stated verbatim.
3. The question may contain typos. Match it to the most relevant memory even if the wording differs.
4. When multiple answers are possible, list all supported answers, not just the first.
5. For counts or time intervals, enumerate carefully before answering.
6. Preserve specific names, titles, places, and labels from the memories. Use "Rob" not "a colleague", "Sweden" not "home country".
7. Convert relative times like "yesterday", "last month", and "last year" into dates, months, or years when the memory timestamp makes it clear. Keep week-based expressions relative.
8. If memories conflict, prefer the most recent supported memory.
9. For list questions, include all required items and no extras.
10. Keep the final answer minimal. Do not add explanation, background, or extra dates unless needed for correctness.
</instructions>

<memories>
{{memories}}
</memories>

Question: {{question}}
Answer with the shortest correct phrase or sentence. No preamble, no fluff:"""

SELECTION_V3_ANSWER_PROMPT = ANSWER_PROMPT
SELECTION_V3_PAYLOAD_VERSION = "ldbd-retrieval-package-v1"
EXACT_SEARCH_PAYLOAD_VERSION = "ldbd-exact-searched-memories-v1"

JUDGE_PROMPT = """Your task is to label an answer as \u2019CORRECT\u2019 or \u2019WRONG\u2019 given:
(1) a question,
(2) a gold (ground truth) answer,
(3) a generated answer.

Core principle \u2014 Inclusion + Non-contradiction
- Be GENEROUS: if the generated answer clearly includes the gold\u2019s key content (or a clear paraphrase of the same content) and does not contradict it, mark CORRECT \u2014 even if extra details are added.
- Mark WRONG only when the generated answer does not include the gold\u2019s content, changes it, or contradicts it.

TIME (strict granularity; relative form equivalence; no calendar math)
- Granularity must match exactly: HOUR\u2194HOUR, DAY\u2194DAY, MONTH\u2194MONTH, YEAR\u2194YEAR.
  Do not answer a gold at a different time unit \u2014 even if the numeric value overlaps. Do not answer a month-level gold with a specific day, nor a year with a specific month/day/hour, etc.
  (e.g., gold = "July 26, 2019" [DAY]; generated = "2019-07-26 08:09:17" [includes Second] \u2192 WRONG)
- Do NOT convert relative \u2194 absolute. If the gold uses a relative time expression, the generated answer must also use a relative form (or a clear paraphrase of that same form), not a computed date/range.
- Treat harmless modifiers in relative forms (e.g., “the/last/previous/just prior”) as equivalent when both the anchor date and the time unit are the same.

- Lists of DISTINCT facts:
- If the gold answer lists multiple distinct facts (joined by "and", commas, or slashes), the generated answer must cover **all** of them.
- Extra non-contradictory items **generally count as WRONG**.
    - Example: gold = A, B, C ; gen = A, B, C \u2192 CORRECT
    - Example: gold = A, B, C ; gen = A, B, C, D \u2192 WRONG
- Exception: If a gold element is elaborated or split into finer details in the generated answer (e.g., C \u2192 C, C\u2032), it is still considered CORRECT.

Preference/Benefit Questions (e.g., "what X likes/values most")
- If gold lists multiple reasons/aspects, the generated answer only needs to include **any one** of them without contradiction to be CORRECT.

Now it's time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {generated_answer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label":

```json
{{
    "label": "CORRECT" or "WRONG"
}}
```"""

REFIND_2026_JUDGE_PROMPT = """Your task is to label an answer to a question as CORRECT or WRONG. You will be given: (1) a question, (2) a gold answer, and (3) a generated answer. The gold answer is concise and contains the ground-truth information. The generated answer might be longer. Be generous: if the generated answer contains the gold answer information (even verbatim inside a longer response), mark it as CORRECT. Otherwise, mark it as WRONG. Respond with either CORRECT or WRONG, and provide a brief reasoning.

Question: {question}
Gold answer: {gold_answer}
Generated answer: {generated_answer}"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare-frozen-input")
    prepare.add_argument("--results", type=Path, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    prepare.add_argument("--include-selection-data", action="store_true")

    reanswer = subparsers.add_parser("reanswer")
    reanswer.add_argument("--input", type=Path, required=True)
    reanswer.add_argument("--output-dir", type=Path, required=True)
    reanswer.add_argument("--slots", type=int, default=32)
    reanswer.add_argument(
        "--mode",
        choices=("exact-searched-memories", "selection-aware-v3"),
        default="exact-searched-memories",
    )

    judge = subparsers.add_parser("judge")
    judge.add_argument("--input", type=Path, required=True)
    judge.add_argument("--output-dir", type=Path, required=True)
    judge.add_argument("--slots", type=int, default=32)
    judge.add_argument("--variant", required=True)
    judge.add_argument(
        "--protocol",
        choices=("strict-v5", "refind-2026"),
        default="strict-v5",
    )
    return parser.parse_args()


def sha256_json(value: Any) -> str:
    serialized = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def safe_name(question_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", question_id).strip("-.")
    return f"{cleaned}-{hashlib.sha256(question_id.encode()).hexdigest()[:12]}.json"


def write_atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def memory_speakers(memories: list[dict[str, Any]]) -> tuple[str, str]:
    for memory in memories:
        session = (memory.get("metadata") or {}).get("session") or {}
        speaker_a = session.get("speakerA")
        speaker_b = session.get("speakerB")
        if isinstance(speaker_a, str) and isinstance(speaker_b, str):
            return speaker_a, speaker_b
    return "User", "Assistant"


def prepare_frozen_input(
    results_path: Path,
    output_path: Path,
    include_selection_data: bool = False,
) -> None:
    payload = read_json(results_path)
    records = payload.get("results")
    if not isinstance(records, list) or not records:
        raise ValueError("Expected a non-empty Picorer result set")

    prepared = []
    seen: set[str] = set()
    for record in records:
        question_id = record["question_id"]
        if question_id in seen:
            raise ValueError(f"Duplicate question ID: {question_id}")
        seen.add(question_id)
        result = record.get("result") or record.get("retrieval")
        if not isinstance(result, dict):
            raise ValueError(f"Missing Picorer retrieval result: {question_id}")
        memories = result["searchedMemories"]
        memory_ids = [memory["memoryId"] for memory in memories]
        if len(memory_ids) != len(set(memory_ids)):
            raise ValueError(f"Duplicate searched memory ID: {question_id}")
        speaker_1, speaker_2 = memory_speakers(memories)
        selection_data = {
            "selection_package": {
                "status": result.get("status"),
                "evidence_summary": result.get("evidenceSummary"),
                "count": result.get("count"),
                "inventory": result.get("inventory") or [],
                "citations": result.get("citations") or [],
            },
            "selected_memories": result.get("evidence") or [],
        }
        prepared.append(
            {
                "question_id": question_id,
                "scope_id": result["scopeId"],
                "question": result["question"],
                "question_date": result.get("questionDate"),
                "speaker_1_name": speaker_1,
                "speaker_2_name": speaker_2,
                "searched_memories": memories,
                "searched_memory_count": len(memories),
                "search_result_hash": sha256_json(
                    [
                        {
                            "memoryId": memory["memoryId"],
                            "contentHash": memory["contentHash"],
                        }
                        for memory in memories
                    ]
                ),
                **(
                    {
                        **selection_data,
                        "selection_data_hash": sha256_json(selection_data),
                    }
                    if include_selection_data
                    else {}
                ),
            }
        )

    write_atomic_json(
        output_path,
        {
            "schema_version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "gold_fields_present": False,
            "original_answer_fields_present": False,
            **(
                {"selection_data_present": True}
                if include_selection_data
                else {}
            ),
            "question_count": len(prepared),
            "records": prepared,
        },
    )


def validate_reanswer_source(
    source: dict[str, Any],
    mode: str,
) -> list[dict[str, Any]]:
    if source.get("gold_fields_present") is not False:
        raise ValueError("Frozen answer input must explicitly exclude gold")
    records = source.get("records")
    if not isinstance(records, list) or not records:
        raise ValueError("Frozen answer input must contain a non-empty record set")
    selection_data_present = source.get("selection_data_present") is True
    if mode == "selection-aware-v3" and not selection_data_present:
        raise ValueError("selection-aware-v3 mode requires prepared selection data")
    if mode == "exact-searched-memories" and selection_data_present:
        raise ValueError("Exact mode requires input without selection data")
    if source.get("question_count") != len(records):
        raise ValueError("Frozen answer input question count is inconsistent")
    return records


def render_memory(memory: dict[str, Any]) -> str:
    metadata = memory.get("metadata") or {}
    turn = metadata.get("turn") or {}
    speaker = turn.get("sourceSpeaker") or memory.get("role") or "unknown"
    timestamp = memory.get("timestamp") or "unknown-time"
    memory_id = memory["memoryId"]
    return f"- [{timestamp}] [{memory_id}] {speaker}: {memory['content']}"


def render_selection_v3_memory(memory: dict[str, Any]) -> str:
    timestamp = memory.get("timestamp")
    time_suffix = "" if timestamp is None else f" time={timestamp}"
    return f"[memoryId={memory['memoryId']}{time_suffix}]\n{memory['content']}"


def selection_v3_answer_prompt(record: dict[str, Any]) -> str:
    package = record.get("selection_package") or {}
    cited_ids = {
        citation.get("memoryId")
        for citation in package.get("citations") or []
    }
    selected = [
        memory for memory in record.get("selected_memories") or []
        if memory.get("memoryId") in cited_ids
    ]
    user_memories = "\n\n".join(
        render_selection_v3_memory(memory)
        for memory in selected
        if memory.get("role") == "user"
    )
    assistant_memories = "\n\n".join(
        render_selection_v3_memory(memory)
        for memory in selected
        if memory.get("role") != "user"
    )
    package_lines = [
        f"status={package.get('status')}",
        f"evidence_summary={package.get('evidence_summary')}",
    ]
    if package.get("count") is not None:
        package_lines.append(f"count={package['count']}")
    for item in package.get("inventory") or []:
        package_lines.append(
            f"inventory={item.get('item')} "
            f"[{', '.join(item.get('memoryIds') or [])}]"
        )
    for citation in package.get("citations") or []:
        package_lines.append(
            f"reference memoryId={citation.get('memoryId')}: "
            f"{citation.get('supports')}"
        )
    memories = "\n".join(
        [
            "<retrieval_package>",
            "\n".join(package_lines),
            "</retrieval_package>",
            "",
            '<source_memories role="user">',
            user_memories or "(none selected)",
            "</source_memories>",
            "",
            '<source_memories role="assistant">',
            assistant_memories or "(none selected)",
            "</source_memories>",
        ]
    )
    return (
        SELECTION_V3_ANSWER_PROMPT
        .replace("{{memories}}", memories or "(none selected)")
        .replace("{{question}}", record["question"])
    )


def answer_prompt(record: dict[str, Any], mode: str) -> str:
    if mode == "selection-aware-v3":
        return selection_v3_answer_prompt(record)
    memories = "\n".join(
        render_memory(memory) for memory in record["searched_memories"]
    )
    return (
        ANSWER_PROMPT.replace("{{memories}}", memories or "(none retrieved)")
        .replace("{{question}}", record["question"])
    )


def endpoint(base_url: str) -> str:
    return f"{base_url.rstrip('/')}/chat/completions"


def returned_model_matches(requested: str, returned: str) -> bool:
    if returned == requested:
        return True
    suffix = returned.removeprefix(f"{requested}-")
    return returned.startswith(f"{requested}-") and bool(
        re.fullmatch(r"\d{4}-\d{2}-\d{2}", suffix)
    )


def blocking_chat(
    *,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    max_tokens: int,
    timeout: int,
    top_p: float | None = None,
) -> dict[str, Any]:
    request_payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    if top_p is not None:
        request_payload["top_p"] = top_p
    body = json.dumps(request_payload).encode("utf-8")
    request = urllib.request.Request(
        endpoint(base_url),
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    content = payload.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Chat endpoint returned no answer content")
    returned_model = payload.get("model")
    if not isinstance(returned_model, str) or not returned_model.strip():
        raise ValueError("Chat endpoint returned no model identity")
    return {
        "content": content.strip(),
        "model": returned_model,
        "usage": payload.get("usage") or {},
    }


async def chat_with_retries(**kwargs: Any) -> dict[str, Any]:
    delay = 1
    while True:
        try:
            return await asyncio.to_thread(blocking_chat, **kwargs)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            status = error.code if isinstance(error, urllib.error.HTTPError) else None
            kind = f"HTTP {status}" if status is not None else type(error).__name__
            print(f"chat retry after {kind}; waiting {delay}s", file=sys.stderr)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)


def ensure_manifest(path: Path, config: dict[str, Any]) -> None:
    if path.exists():
        existing = read_json(path)
        if existing.get("config") != config:
            raise ValueError("Output directory has a different run configuration")
        return
    write_atomic_json(
        path,
        {
            "schema_version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "config": config,
        },
    )


async def run_reanswer(args: argparse.Namespace) -> None:
    if args.slots <= 0:
        raise ValueError("--slots must be positive")
    api_key = os.environ.get("OPENAI_API_KEY", "")
    base_url = os.environ.get("OPENAI_API_BASE", "")
    model = os.environ.get("OPENAI_MODEL", "")
    if not api_key or not base_url or not model:
        raise ValueError("answer.env variables are required")

    source = read_json(args.input)
    records = validate_reanswer_source(source, args.mode)
    expected_count = len(records)

    output_dir: Path = args.output_dir
    records_dir = output_dir / "records"
    records_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output_dir, 0o700)
    os.chmod(records_dir, 0o700)
    prompt_template = (
        SELECTION_V3_ANSWER_PROMPT
        if args.mode == "selection-aware-v3"
        else ANSWER_PROMPT
    )
    run_modes = {
        "exact-searched-memories": "frozen-searched-memories-reanswer",
        "selection-aware-v3": "selection-aware-v3-reanswer",
    }
    config = {
        "mode": run_modes[args.mode],
        "question_count": expected_count,
        "input_hash": sha256_json(source),
        "prompt_hash": hashlib.sha256(prompt_template.encode()).hexdigest(),
        "prompt_builder_version": (
            SELECTION_V3_PAYLOAD_VERSION
            if args.mode == "selection-aware-v3"
            else EXACT_SEARCH_PAYLOAD_VERSION
        ),
        "model": model,
        "slots": args.slots,
        "gold_visible_to_answer_stage": False,
        "original_answer_visible_to_answer_stage": False,
    }
    ensure_manifest(output_dir / "run-manifest.json", config)
    semaphore = asyncio.Semaphore(args.slots)

    async def process(record: dict[str, Any]) -> None:
        path = records_dir / safe_name(record["question_id"])
        if path.exists():
            existing = read_json(path)
            if existing.get("search_result_hash") != record["search_result_hash"]:
                raise ValueError(f"Frozen search hash changed: {record['question_id']}")
            return
        prompt = answer_prompt(record, args.mode)
        started = time.monotonic()
        while True:
            async with semaphore:
                response = await chat_with_retries(
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    prompt=prompt,
                    max_tokens=512,
                    timeout=360,
                )
            if returned_model_matches(model, response["model"]):
                break
            print(
                "answer retry after provider model substitution; waiting 5s",
                file=sys.stderr,
            )
            await asyncio.sleep(5)
        write_atomic_json(
            path,
            {
                "schema_version": 1,
                "question_id": record["question_id"],
                "question": record["question"],
                "response": response["content"],
                "model": response["model"],
                "usage": response["usage"],
                "latency_seconds": time.monotonic() - started,
                "searched_memory_count": record["searched_memory_count"],
                "search_result_hash": record["search_result_hash"],
                **(
                    {
                        "selection_data_hash": record.get("selection_data_hash")
                        or sha256_json(
                            {
                                "selection_package": record.get("selection_package") or {},
                                "selected_memories": record.get("selected_memories") or [],
                            }
                        ),
                        "mode": args.mode,
                    }
                    if args.mode == "selection-aware-v3"
                    else {}
                ),
            },
        )

    tasks = [asyncio.create_task(process(record)) for record in records]
    with tqdm(total=len(tasks), desc="Frozen re-answer", unit="q") as progress:
        for task in asyncio.as_completed(tasks):
            await task
            progress.update(1)

    by_id = {}
    for path in records_dir.glob("*.json"):
        record = read_json(path)
        by_id[record["question_id"]] = record
    if len(by_id) != expected_count:
        raise ValueError(
            f"Expected {expected_count} frozen answers, found {len(by_id)}"
        )
    ordered = [by_id[record["question_id"]] for record in records]
    write_atomic_json(
        output_dir / "results.json",
        {
            "schema_version": 1,
            "result_count": expected_count,
            "results": ordered,
        },
    )
    predictions = "\n".join(
        json.dumps(
            {
                "question_id": record["question_id"],
                "response": record["response"],
                "decision": "answer",
                "citations": [],
            },
            ensure_ascii=False,
        )
        for record in ordered
    ) + "\n"
    predictions_path = output_dir / "predictions.jsonl"
    temporary = predictions_path.with_name(f".{predictions_path.name}.tmp-{os.getpid()}")
    temporary.write_text(predictions, encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, predictions_path)


def parse_label(content: str) -> str:
    candidates = re.findall(r'"label"\s*:\s*"(CORRECT|WRONG)"', content, re.I)
    if len(candidates) != 1:
        raise ValueError("Judge response does not contain exactly one JSON label")
    return candidates[0].upper()


def parse_refind_label(content: str) -> str:
    normalized = content.casefold()
    if "correct" in normalized and "wrong" not in normalized:
        return "CORRECT"
    return "WRONG"


async def run_judge(args: argparse.Namespace) -> None:
    if args.slots <= 0:
        raise ValueError("--slots must be positive")
    api_key = os.environ.get("JUDGER_API_KEY") or os.environ.get("PICORER_JUDGER_API_KEY", "")
    base_url = os.environ.get("JUDGER_API_BASE") or os.environ.get("PICORER_JUDGER_BASE_URL", "")
    model = os.environ.get("JUDGER_MODEL") or os.environ.get("PICORER_JUDGER_MODEL", "")
    if not api_key or not base_url or not model:
        raise ValueError("judger.env variables are required")
    items = read_json(args.input)
    if not isinstance(items, list) or len(items) == 0:
        raise ValueError("Judge input must contain at least one record")
    question_count = len(items)

    output_dir: Path = args.output_dir
    records_dir = output_dir / "records"
    records_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output_dir, 0o700)
    os.chmod(records_dir, 0o700)
    prompt_template = (
        REFIND_2026_JUDGE_PROMPT
        if args.protocol == "refind-2026"
        else JUDGE_PROMPT
    )
    config = {
        "mode": "strict-longmemeval-judge",
        "variant": args.variant,
        "question_count": question_count,
        "input_hash": sha256_json(items),
        "prompt_hash": hashlib.sha256(prompt_template.encode()).hexdigest(),
        "model": model,
        "slots": args.slots,
    }
    if args.protocol == "refind-2026":
        config.update(
            {
                "mode": "refind-2026-longmemeval-judge",
                "protocol": args.protocol,
                "temperature": 0,
                "top_p": 0.9,
            }
        )
    ensure_manifest(output_dir / "run-manifest.json", config)
    semaphore = asyncio.Semaphore(args.slots)

    async def process(item: dict[str, Any]) -> None:
        path = records_dir / safe_name(item["question_id"])
        if path.exists():
            return
        prompt = prompt_template.format(
            question=item["question"],
            gold_answer=item["answer"],
            generated_answer=item.get("response", ""),
        )
        while True:
            started = time.monotonic()
            async with semaphore:
                response = await chat_with_retries(
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    prompt=prompt,
                    max_tokens=256,
                    timeout=60,
                    top_p=0.9 if args.protocol == "refind-2026" else None,
                )
            if not returned_model_matches(model, response["model"]):
                raise ValueError(
                    f"Judge provider substituted model {response['model']}; "
                    f"expected {model}"
                )
            try:
                label = (
                    parse_refind_label(response["content"])
                    if args.protocol == "refind-2026"
                    else parse_label(response["content"])
                )
                break
            except ValueError:
                print("judge label parse retry; waiting 1s", file=sys.stderr)
                await asyncio.sleep(1)
        write_atomic_json(
            path,
            {
                "schema_version": 1,
                "variant": args.variant,
                "question_id": item["question_id"],
                "question_type": item["question_type"],
                "abstention": bool(item.get("abstention")),
                "question": item["question"],
                "gold_answer": item["answer"],
                "generated_answer": item.get("response", ""),
                "label": label,
                "score": 1 if label == "CORRECT" else 0,
                "judge_model": response["model"],
                "judge_response": response["content"],
                "usage": response["usage"],
                "latency_seconds": time.monotonic() - started,
            },
        )

    tasks = [asyncio.create_task(process(item)) for item in items]
    with tqdm(total=len(tasks), desc=f"Judge {args.variant}", unit="q") as progress:
        for task in asyncio.as_completed(tasks):
            await task
            progress.update(1)

    by_id = {}
    for path in records_dir.glob("*.json"):
        record = read_json(path)
        by_id[record["question_id"]] = record
    if len(by_id) != question_count:
        raise ValueError(
            f"Expected {question_count} judge records, found {len(by_id)}"
        )
    ordered = [by_id[item["question_id"]] for item in items]
    buckets: dict[str, list[int]] = defaultdict(list)
    for record in ordered:
        buckets[record["question_type"]].append(record["score"])
        buckets["abstention" if record["abstention"] else "answerable"].append(record["score"])
        buckets["overall"].append(record["score"])
    summary = {
        name: {
            "correct": sum(scores),
            "total": len(scores),
            "accuracy": sum(scores) / len(scores),
        }
        for name, scores in sorted(buckets.items())
    }
    write_atomic_json(
        output_dir / "results.json",
        {
            "schema_version": 1,
            "result_count": question_count,
            "results": ordered,
        },
    )
    write_atomic_json(
        output_dir / "summary.json",
        {
            "schema_version": 1,
            "variant": args.variant,
            "judge_model": model,
            "prompt_hash": config["prompt_hash"],
            "metrics": summary,
        },
    )


async def async_main(args: argparse.Namespace) -> None:
    if args.command == "reanswer":
        await run_reanswer(args)
    elif args.command == "judge":
        await run_judge(args)
    else:
        raise ValueError(f"Unknown async command: {args.command}")


def main() -> None:
    args = parse_args()
    if args.command == "prepare-frozen-input":
        prepare_frozen_input(
            args.results,
            args.output,
            args.include_selection_data,
        )
    else:
        asyncio.run(async_main(args))


if __name__ == "__main__":
    main()
