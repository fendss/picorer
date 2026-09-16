#!/usr/bin/env python3
"""Measure independent explicit J and native finish S at every Picorer state.

The script preserves every render/completion request and response.  Explicit J
adds one fixed user prompt and samples a constrained binary label.  Native S
uses the untouched captured agent context and the existing Picorer finish tool.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import requests


EXPLICIT_SUFFICIENCY_PROMPT = (
    "Judge whether the evidence currently available in the conversation is "
    "sufficient to answer the original user question correctly. Respond with "
    "exactly one label: sufficient or insufficient."
)
LABELS = ("sufficient", "insufficient")
PREFIX_SAMPLE_SIZES = (11, 31, 63, 101)


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def wait_for_retrieval(state_path: Path, poll_seconds: float) -> None:
    while True:
        connection = sqlite3.connect(f"file:{state_path}?mode=ro", uri=True)
        try:
            rows = dict(
                connection.execute(
                    "SELECT status, COUNT(*) FROM question_stages "
                    "WHERE stage = 'retrieval' GROUP BY status"
                ).fetchall()
            )
        finally:
            connection.close()
        print(json.dumps({"event": "acquisition_status", "counts": rows}), flush=True)
        if rows.get("failed", 0):
            raise RuntimeError(f"acquisition has failed retrievals: {rows}")
        if rows.get("queued", 0) + rows.get("running", 0) == 0:
            if rows.get("completed", 0) == 100:
                return
            raise RuntimeError(f"acquisition ended without 100 completions: {rows}")
        time.sleep(poll_seconds)


def recursive_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(recursive_text(item) for item in value)
    if isinstance(value, dict):
        return "\n".join(recursive_text(item) for item in value.values())
    return ""


def response_tool_calls(response: dict[str, Any]) -> list[dict[str, Any]]:
    choices = response.get("choices") or []
    if not choices:
        return []
    calls = choices[0].get("message", {}).get("tool_calls") or []
    return [
        {
            "name": (call.get("function") or {}).get("name"),
            "arguments": (call.get("function") or {}).get("arguments"),
            "tool_call_id": call.get("id"),
        }
        for call in calls
    ]


def artifact_records(root: Path) -> dict[str, str]:
    records: dict[str, str] = {}
    for shard_name in ("artifacts-canary", "artifacts-main", "artifacts-full"):
        shard = root / shard_name
        if not shard.exists():
            continue
        for path in shard.glob("*/retrieval.json"):
            artifact = read_json(path)
            question_id = str(artifact["question_id"])
            formatted_query = str(artifact["output"]["formatted_query"])
            if question_id in records and records[question_id] != formatted_query:
                raise RuntimeError(f"conflicting query text for {question_id}")
            records[question_id] = formatted_query
    return records


def build_decision_state_index(root: Path) -> list[dict[str, Any]]:
    manifest = read_json(root / "manifest-full.json")
    expected_ids = [str(question["id"]) for question in manifest["questions"]]
    formatted_by_id = artifact_records(root)
    if set(formatted_by_id) != set(expected_ids):
        missing = sorted(set(expected_ids) - set(formatted_by_id))
        extra = sorted(set(formatted_by_id) - set(expected_ids))
        raise RuntimeError(
            f"retrieval artifact coverage mismatch missing={missing} extra={extra}"
        )

    audit_path = root / "runtime" / "memory-service" / "wrap-audits.jsonl"
    audits = [json.loads(line) for line in audit_path.read_text().splitlines() if line]
    audit_by_question: dict[str, dict[str, Any]] = {}
    for audit in audits:
        formatted_query = str(audit["question"])
        matches = [
            question_id
            for question_id, expected in formatted_by_id.items()
            if expected == formatted_query
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"audit query maps to {len(matches)} manifest questions: "
                f"{formatted_query[-300:]}"
            )
        question_id = matches[0]
        if question_id in audit_by_question:
            raise RuntimeError(f"duplicate successful wrap audit for {question_id}")
        audit_by_question[question_id] = audit
    if set(audit_by_question) != set(expected_ids):
        raise RuntimeError(
            f"wrap audit coverage mismatch: {len(audit_by_question)} of "
            f"{len(expected_ids)}"
        )

    captures_by_question: dict[str, list[dict[str, Any]]] = {
        question_id: [] for question_id in expected_ids
    }
    transport_failures: list[dict[str, Any]] = []
    for meta_path in (root / "captures").glob("*/meta.json"):
        meta = read_json(meta_path)
        if meta.get("path") != "/v1/chat/completions":
            continue
        request = read_json(meta_path.parent / "request.body")
        message_text = recursive_text(request.get("messages", []))
        matches = [
            question_id
            for question_id, formatted_query in formatted_by_id.items()
            if formatted_query in message_text
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"capture {meta['request_id']} maps to {len(matches)} questions"
            )
        question_id = matches[0]
        if meta.get("capture_state") != "complete" or meta.get("response_status") != 200:
            transport_failures.append(
                {
                    "question_id": question_id,
                    "request_id": meta["request_id"],
                    "capture_state": meta.get("capture_state"),
                    "response_status": meta.get("response_status"),
                    "request_sha256": meta.get("request_sha256"),
                }
            )
            continue
        response = read_json(meta_path.parent / "response.body")
        captures_by_question[question_id].append(
            {
                "meta": meta,
                "request": request,
                "response": response,
                "capture_dir": str(meta_path.parent.resolve()),
            }
        )

    states: list[dict[str, Any]] = []
    alignments: dict[str, Any] = {}
    for question_id in expected_ids:
        captures = sorted(
            captures_by_question[question_id],
            key=lambda capture: capture["meta"]["request_started_at_unix"],
        )
        if not captures:
            raise RuntimeError(f"no successful decision states for {question_id}")
        audit = audit_by_question[question_id]
        trace_names = [entry.get("toolName") for entry in audit["retrieval"]["trace"]]
        captured_names = [
            call["name"]
            for capture in captures
            for call in response_tool_calls(capture["response"])
        ]
        if trace_names != captured_names:
            raise RuntimeError(
                f"tool trace mismatch for {question_id}: "
                f"trace={trace_names} capture={captured_names}"
            )
        total = len(captures)
        alignments[question_id] = {
            "decision_state_count": total,
            "tool_call_count": len(captured_names),
            "trace_aligned": True,
            "terminal_status": audit["retrieval"]["status"],
        }
        for offset, capture in enumerate(captures, start=1):
            meta = capture["meta"]
            states.append(
                {
                    "schema_version": 2,
                    "question_id": question_id,
                    "decision_step": offset,
                    "decision_state_count": total,
                    "normalized_progress": offset / total,
                    "capture_id": meta["request_id"],
                    "capture_dir": capture["capture_dir"],
                    "request_sha256": meta["request_sha256"],
                    "response_sha256": meta["response_sha256"],
                    "request_started_at_unix": meta["request_started_at_unix"],
                    "duration_seconds": meta["duration_seconds"],
                    "acquisition_upstream": meta.get("response_headers", {}).get(
                        "x-qwen-upstream"
                    ),
                    "message_count": len(capture["request"].get("messages", [])),
                    "action_tool_calls": response_tool_calls(capture["response"]),
                    "terminal_trajectory_status": audit["retrieval"]["status"],
                }
            )

    index_root = root / "decision-states-v2"
    index_root.mkdir(exist_ok=True)
    index_path = index_root / "index.jsonl"
    temporary_path = index_root / ".index.jsonl.tmp"
    with temporary_path.open("w", encoding="utf-8") as handle:
        for state in states:
            handle.write(json.dumps(state, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_path, index_path)
    write_json_atomic(
        index_root / "validation.json",
        {
            "schema_version": 2,
            "question_count": len(expected_ids),
            "decision_state_count": len(states),
            "successful_capture_count": len(states),
            "failed_capture_count": len(transport_failures),
            "transport_failures": transport_failures,
            "per_question": alignments,
        },
    )
    return states


class ProbeClient:
    def __init__(self, endpoint: str, timeout: float) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.timeout = timeout
        self.local = threading.local()

    def session(self) -> requests.Session:
        session = getattr(self.local, "session", None)
        if session is None:
            session = requests.Session()
            session.headers.update({"Authorization": "Bearer local-no-key"})
            self.local.session = session
        return session

    def post(self, path: str, payload: dict[str, Any]) -> requests.Response:
        last_error: BaseException | None = None
        for attempt in range(1, 5):
            try:
                response = self.session().post(
                    self.endpoint + path,
                    json=payload,
                    timeout=self.timeout,
                )
                if response.status_code < 500:
                    response.raise_for_status()
                    return response
                last_error = RuntimeError(
                    f"HTTP {response.status_code}: {response.text[:1000]}"
                )
            except (requests.RequestException, RuntimeError) as error:
                last_error = error
            if attempt < 4:
                time.sleep(attempt * 2)
        assert last_error is not None
        raise last_error


def response_record(response: requests.Response) -> dict[str, Any]:
    return {
        "status_code": response.status_code,
        "headers": dict(response.headers),
        "body": response.json(),
    }


def first_difference(left: list[int], right: list[int]) -> int:
    for index, (left_token, right_token) in enumerate(zip(left, right)):
        if left_token != right_token:
            return index
    raise RuntimeError("rendered sufficient and insufficient outputs do not diverge")


def render_request(
    client: ProbeClient,
    payload: dict[str, Any],
    output_dir: Path,
    stem: str,
) -> list[int]:
    write_json_atomic(output_dir / f"{stem}.request.json", payload)
    response = client.post("/v1/chat/completions/render", payload)
    record = response_record(response)
    write_json_atomic(output_dir / f"{stem}.response.json", record)
    return [int(token) for token in record["body"]["token_ids"]]


def branch_spec(
    client: ProbeClient,
    captured_request: dict[str, Any],
    output_dir: Path,
    kind: str,
) -> dict[str, Any]:
    rendered: dict[str, list[int]] = {}
    for label in LABELS:
        payload = json.loads(json.dumps(captured_request))
        if kind == "native":
            payload["messages"].append(
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "sufficiency-probe-finish",
                            "type": "function",
                            "function": {
                                "name": "finish",
                                "arguments": json.dumps(
                                    {"status": label}, separators=(",", ":")
                                ),
                            },
                        }
                    ],
                }
            )
        elif kind == "explicit":
            payload["messages"].append(
                {"role": "user", "content": EXPLICIT_SUFFICIENCY_PROMPT}
            )
            payload["messages"].append({"role": "assistant", "content": label})
        else:
            raise ValueError(f"unknown branch kind {kind}")
        payload["add_generation_prompt"] = False
        rendered[label] = render_request(
            client, payload, output_dir, f"{kind}-{label}.render"
        )

    difference = first_difference(rendered["sufficient"], rendered["insufficient"])
    sufficient_token = rendered["sufficient"][difference]
    insufficient_token = rendered["insufficient"][difference]
    if sufficient_token == insufficient_token:
        raise RuntimeError(f"equal {kind} branch tokens")
    return {
        "prompt_token_ids": rendered["sufficient"][:difference],
        "branch_position": difference,
        "branch_token_ids": {
            "sufficient": sufficient_token,
            "insufficient": insufficient_token,
        },
        "rendered_token_counts": {
            label: len(rendered[label]) for label in LABELS
        },
    }


def completion_request(
    client: ProbeClient,
    payload: dict[str, Any],
    output_dir: Path,
    stem: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    write_json_atomic(output_dir / f"{stem}.request.json", payload)
    response = client.post("/v1/completions", payload)
    record = response_record(response)
    write_json_atomic(output_dir / f"{stem}.response.json", record)
    return record["body"], record["headers"]


def requested_logprob(
    top_logprobs: dict[str, float], decoded_token: str
) -> float:
    if decoded_token not in top_logprobs:
        raise RuntimeError(
            f"requested token {decoded_token!r} missing from {top_logprobs}"
        )
    return float(top_logprobs[decoded_token])


def masked_branch_logprobs(
    body: dict[str, Any], branch_token_ids: dict[str, int]
) -> dict[str, float]:
    """Recover both masked branch logits without trusting token display text.

    vLLM's legacy completions response occasionally renders a candidate token
    using its prompt-conditioned text rather than the same string returned by
    the standalone detokenize endpoint (for example token id 82 can appear as
    ``status`` instead of ``s``).  With an exact two-token mask, the generated
    token id identifies one branch and the sole remaining top-logprob value
    identifies the other branch unambiguously.
    """
    choice = body["choices"][0]
    generated_ids = choice.get("token_ids") or []
    token_logprobs = choice["logprobs"].get("token_logprobs") or []
    top_logprobs = choice["logprobs"]["top_logprobs"][0]
    if len(generated_ids) != 1 or len(token_logprobs) != 1:
        raise RuntimeError(
            "masked branch request did not return one generated token and logprob"
        )
    if len(top_logprobs) != 2:
        raise RuntimeError(
            f"expected two masked top logprobs, received {top_logprobs}"
        )
    generated_id = int(generated_ids[0])
    matching_labels = [
        label for label, token_id in branch_token_ids.items() if token_id == generated_id
    ]
    if len(matching_labels) != 1:
        raise RuntimeError(
            f"generated token id {generated_id} does not identify one branch"
        )
    generated_label = matching_labels[0]
    other_label = next(label for label in LABELS if label != generated_label)
    generated_logprob = float(token_logprobs[0])
    displayed_values = [float(value) for value in top_logprobs.values()]
    if not any(math.isclose(value, generated_logprob, abs_tol=1e-6) for value in displayed_values):
        raise RuntimeError(
            f"generated logprob {generated_logprob} missing from {top_logprobs}"
        )
    other_logprob = sum(displayed_values) - generated_logprob
    return {
        generated_label: generated_logprob,
        other_label: other_logprob,
    }


def detokenize(
    client: ProbeClient,
    model: str,
    token_ids: dict[str, int],
    output_dir: Path,
    stem: str,
) -> dict[str, str]:
    result: dict[str, str] = {}
    for label, token_id in token_ids.items():
        payload = {"model": model, "tokens": [token_id]}
        write_json_atomic(output_dir / f"{stem}-{label}.request.json", payload)
        response = client.post("/detokenize", payload)
        record = response_record(response)
        write_json_atomic(output_dir / f"{stem}-{label}.response.json", record)
        result[label] = str(record["body"]["prompt"])
    return result


def stable_seed(capture_id: str, replica: str) -> int:
    material = f"explicit-j-v2\0{replica}\0{capture_id}".encode()
    return int(hashlib.sha256(material).hexdigest()[:8], 16)


def state_output_dir(root: Path, state: dict[str, Any], replica: str) -> Path:
    question_hash = hashlib.sha256(state["question_id"].encode()).hexdigest()[:12]
    return (
        root
        / "probes-v2"
        / question_hash
        / f"step-{state['decision_step']:03d}"
        / replica
    )


def measure_state_replica(
    client: ProbeClient,
    root: Path,
    state: dict[str, Any],
    replica: str,
    samples: int,
) -> dict[str, Any]:
    output_dir = state_output_dir(root, state, replica)
    result_path = output_dir / "result.json"
    if result_path.exists():
        existing = read_json(result_path)
        if (
            existing.get("capture_id") == state["capture_id"]
            and existing.get("explicit_j", {}).get("sample_count") == samples
            and existing.get("replica") == replica
        ):
            return {"status": "reused", "path": str(result_path)}

    output_dir.mkdir(parents=True, exist_ok=True)
    write_json_atomic(output_dir / "input-state.json", state)
    captured_request = read_json(Path(state["capture_dir"]) / "request.body")
    model = str(captured_request["model"])

    native = branch_spec(client, captured_request, output_dir, "native")
    native_text = detokenize(
        client,
        model,
        native["branch_token_ids"],
        output_dir,
        "native-branch.detokenize",
    )
    native_payload = {
        "model": model,
        "prompt": native["prompt_token_ids"],
        "max_tokens": 1,
        "temperature": 1.0,
        "top_p": 1.0,
        # The two-label mask preserves their relative logits and guarantees that
        # both appear in top_logprobs.  The deployed vLLM build currently raises
        # HTTP 500 for its non-standard logprob_token_ids extension.
        "allowed_token_ids": list(native["branch_token_ids"].values()),
        "logprobs": 2,
        "return_token_ids": True,
    }
    native_body, native_headers = completion_request(
        client, native_payload, output_dir, "native-s"
    )
    native_lp = masked_branch_logprobs(native_body, native["branch_token_ids"])
    native_max = max(native_lp.values())
    native_s = math.exp(native_lp["sufficient"] - native_max) / sum(
        math.exp(value - native_max) for value in native_lp.values()
    )

    explicit = branch_spec(client, captured_request, output_dir, "explicit")
    explicit_text = detokenize(
        client,
        model,
        explicit["branch_token_ids"],
        output_dir,
        "explicit-branch.detokenize",
    )
    seed = stable_seed(state["capture_id"], replica)
    explicit_payload = {
        "model": model,
        "prompt": explicit["prompt_token_ids"],
        "max_tokens": 1,
        "n": samples,
        "temperature": 1.0,
        "top_p": 1.0,
        "allowed_token_ids": list(explicit["branch_token_ids"].values()),
        "return_token_ids": True,
        "seed": seed,
    }
    explicit_body, explicit_headers = completion_request(
        client, explicit_payload, output_dir, "explicit-j"
    )
    sampled_tokens = [
        int(choice["token_ids"][0]) for choice in explicit_body.get("choices", [])
    ]
    if len(sampled_tokens) != samples:
        raise RuntimeError(
            f"expected {samples} explicit labels, received {len(sampled_tokens)}"
        )
    allowed = set(explicit["branch_token_ids"].values())
    invalid_tokens = sorted(set(sampled_tokens) - allowed)
    if invalid_tokens:
        raise RuntimeError(f"invalid explicit label tokens: {invalid_tokens}")
    sufficient_token = explicit["branch_token_ids"]["sufficient"]
    sufficient_count = sampled_tokens.count(sufficient_token)
    prefix_estimates = {
        str(size): sampled_tokens[:size].count(sufficient_token) / size
        for size in PREFIX_SAMPLE_SIZES
        if size <= samples
    }

    result = {
        "schema_version": 2,
        "protocol": "explicit-j-native-s-v2",
        "question_id": state["question_id"],
        "decision_step": state["decision_step"],
        "decision_state_count": state["decision_state_count"],
        "normalized_progress": state["normalized_progress"],
        "capture_id": state["capture_id"],
        "request_sha256": state["request_sha256"],
        "replica": replica,
        "model": model,
        "native_s": {
            "extra_sufficiency_prompt": False,
            "agent_context_changed": False,
            "finish_schema": "captured Picorer v1.0.0 finish tool",
            "branch_position": native["branch_position"],
            "branch_token_ids": native["branch_token_ids"],
            "branch_token_text": native_text,
            "logprobs": native_lp,
            "sufficient_likelihood": native_s,
            "generated_token_ids": native_body["choices"][0].get("token_ids"),
            "usage": native_body.get("usage"),
            "response_headers": native_headers,
        },
        "explicit_j": {
            "prompt": EXPLICIT_SUFFICIENCY_PROMPT,
            "prompt_added_after_frozen_agent_context": True,
            "branch_position": explicit["branch_position"],
            "branch_token_ids": explicit["branch_token_ids"],
            "branch_token_text": explicit_text,
            "sample_count": samples,
            "sampled_token_ids": sampled_tokens,
            "sufficient_count": sufficient_count,
            "insufficient_count": samples - sufficient_count,
            "sufficient_fraction": sufficient_count / samples,
            "prefix_estimates": prefix_estimates,
            "seed": seed,
            "temperature": 1.0,
            "top_p": 1.0,
            "usage": explicit_body.get("usage"),
            "response_headers": explicit_headers,
        },
        "raw_files": sorted(
            path.name for path in output_dir.glob("*.json") if path.name != "result.json"
        ),
    }
    write_json_atomic(result_path, result)
    return {"status": "completed", "path": str(result_path)}


def parse_replica(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("replica must be LABEL=URL")
    label, endpoint = value.split("=", 1)
    if not label or not endpoint:
        raise argparse.ArgumentTypeError("replica must be LABEL=URL")
    if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for character in label):
        raise argparse.ArgumentTypeError("replica label contains unsafe characters")
    return label, endpoint


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--wait-state", type=Path)
    parser.add_argument("--poll-seconds", type=float, default=30)
    parser.add_argument("--replica", action="append", type=parse_replica, required=True)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--samples", type=int, default=101)
    parser.add_argument("--timeout-seconds", type=float, default=900)
    parser.add_argument("--limit-states", type=int)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.samples < 1:
        raise ValueError("--samples must be positive")
    root = args.experiment_root.resolve()
    if args.wait_state is not None:
        wait_for_retrieval(args.wait_state.resolve(), args.poll_seconds)
    states = build_decision_state_index(root)
    if args.limit_states is not None:
        states = states[: args.limit_states]
    clients = {
        label: ProbeClient(endpoint, args.timeout_seconds)
        for label, endpoint in args.replica
    }
    jobs = [
        (state, replica)
        for state in states
        for replica in clients
    ]
    print(
        json.dumps(
            {
                "event": "measurement_started",
                "states": len(states),
                "replicas": list(clients),
                "jobs": len(jobs),
                "workers": args.workers,
                "samples_per_state_per_replica": args.samples,
                "explicit_prompt": EXPLICIT_SUFFICIENCY_PROMPT,
            }
        ),
        flush=True,
    )
    completed = 0
    reused = 0
    failures: list[dict[str, Any]] = []
    index_records: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_job = {
            executor.submit(
                measure_state_replica,
                clients[replica],
                root,
                state,
                replica,
                args.samples,
            ): (state, replica)
            for state, replica in jobs
        }
        for future in concurrent.futures.as_completed(future_to_job):
            state, replica = future_to_job[future]
            try:
                outcome = future.result()
                if outcome["status"] == "reused":
                    reused += 1
                else:
                    completed += 1
                index_records.append(
                    {
                        "question_id": state["question_id"],
                        "decision_step": state["decision_step"],
                        "capture_id": state["capture_id"],
                        "replica": replica,
                        "status": outcome["status"],
                        "result_path": outcome["path"],
                    }
                )
            except BaseException as error:
                failure = {
                    "question_id": state["question_id"],
                    "decision_step": state["decision_step"],
                    "capture_id": state["capture_id"],
                    "replica": replica,
                    "error_type": type(error).__name__,
                    "error": repr(error),
                }
                failures.append(failure)
                index_records.append({**failure, "status": "failed"})
            processed = completed + reused + len(failures)
            if processed % 25 == 0 or processed == len(jobs):
                print(
                    json.dumps(
                        {
                            "event": "measurement_progress",
                            "processed": processed,
                            "total": len(jobs),
                            "completed": completed,
                            "reused": reused,
                            "failed": len(failures),
                        }
                    ),
                    flush=True,
                )

    index_records.sort(
        key=lambda record: (
            record["question_id"], record["decision_step"], record["replica"]
        )
    )
    probe_root = root / "probes-v2"
    index_path = probe_root / "index.jsonl"
    temporary_path = probe_root / ".index.jsonl.tmp"
    with temporary_path.open("w", encoding="utf-8") as handle:
        for record in index_records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_path, index_path)
    summary = {
        "schema_version": 2,
        "protocol": "explicit-j-native-s-v2",
        "decision_state_count": len(states),
        "replicas": [
            {"label": label, "endpoint": endpoint} for label, endpoint in args.replica
        ],
        "job_count": len(jobs),
        "samples_per_state_per_replica": args.samples,
        "explicit_prompt": EXPLICIT_SUFFICIENCY_PROMPT,
        "completed": completed,
        "reused": reused,
        "failed": len(failures),
        "failures": failures,
    }
    write_json_atomic(root / "measurement-v2-summary.json", summary)
    if failures:
        raise RuntimeError(f"{len(failures)} state-replica measurements failed")


if __name__ == "__main__":
    main()
