#!/usr/bin/env python3
"""Index captured Picorer states and measure native finish sufficiency offline."""

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


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
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
        active = rows.get("queued", 0) + rows.get("running", 0)
        if active == 0 and rows.get("completed", 0) > 0:
            return
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
    result = []
    for call in calls:
        function = call.get("function") or {}
        result.append(
            {
                "name": function.get("name"),
                "arguments": function.get("arguments"),
                "tool_call_id": call.get("id"),
            }
        )
    return result


def artifact_records(root: Path) -> dict[str, str]:
    records: dict[str, str] = {}
    for shard in (root / "artifacts-canary", root / "artifacts-main"):
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
        raise RuntimeError(f"retrieval artifact coverage mismatch missing={missing} extra={extra}")

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
                f"audit query maps to {len(matches)} manifest questions: {formatted_query[-300:]}"
            )
        question_id = matches[0]
        if question_id in audit_by_question:
            raise RuntimeError(f"duplicate successful wrap audit for {question_id}")
        audit_by_question[question_id] = audit
    if set(audit_by_question) != set(expected_ids):
        raise RuntimeError(
            f"wrap audit coverage mismatch: {len(audit_by_question)} of {len(expected_ids)}"
        )

    captures_by_question: dict[str, list[dict[str, Any]]] = {
        question_id: [] for question_id in expected_ids
    }
    transport_failures: list[dict[str, Any]] = []
    capture_root = root / "captures"
    for meta_path in capture_root.glob("*/meta.json"):
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
                f"tool trace mismatch for {question_id}: trace={trace_names} capture={captured_names}"
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
            calls = response_tool_calls(capture["response"])
            states.append(
                {
                    "schema_version": 1,
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
                    "action_tool_calls": calls,
                    "terminal_trajectory_status": audit["retrieval"]["status"],
                }
            )

    index_root = root / "decision-states"
    index_root.mkdir(exist_ok=True)
    with (index_root / "index.jsonl").open("w", encoding="utf-8") as handle:
        for state in states:
            handle.write(json.dumps(state, ensure_ascii=False, sort_keys=True) + "\n")
    write_json_atomic(
        index_root / "validation.json",
        {
            "schema_version": 1,
            "question_count": len(expected_ids),
            "decision_state_count": len(states),
            "transport_failures": transport_failures,
            "per_question": alignments,
        },
    )
    return states


class ProbeClient:
    def __init__(self, endpoint: str, ca_bundle: str, timeout: float) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.ca_bundle = ca_bundle
        self.timeout = timeout
        self.local = threading.local()
        self.decode_lock = threading.Lock()
        self.decoded_tokens: dict[int, str] = {}

    def session(self) -> requests.Session:
        session = getattr(self.local, "session", None)
        if session is None:
            session = requests.Session()
            session.headers.update({"Authorization": "Bearer local-no-key"})
            self.local.session = session
        return session

    def post(self, path: str, payload: dict[str, Any]) -> requests.Response:
        last_error: BaseException | None = None
        for attempt in range(1, 4):
            try:
                response = self.session().post(
                    self.endpoint + path,
                    json=payload,
                    verify=self.ca_bundle,
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
            if attempt < 3:
                time.sleep(attempt * 2)
        assert last_error is not None
        raise last_error

    def detokenize(self, model: str, token_id: int) -> str:
        with self.decode_lock:
            cached = self.decoded_tokens.get(token_id)
        if cached is not None:
            return cached
        response = self.post(
            "/detokenize", {"model": model, "tokens": [token_id]}
        ).json()
        decoded = str(response["prompt"])
        with self.decode_lock:
            self.decoded_tokens[token_id] = decoded
        return decoded


def render_finish(
    client: ProbeClient,
    captured_request: dict[str, Any],
    status: str,
) -> tuple[list[int], str | None]:
    request = json.loads(json.dumps(captured_request))
    request["messages"].append(
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
                            {"status": status}, separators=(",", ":")
                        ),
                    },
                }
            ],
        }
    )
    request["add_generation_prompt"] = False
    response = client.post("/v1/chat/completions/render", request)
    return response.json()["token_ids"], response.headers.get("X-Qwen-Upstream")


def first_difference(left: list[int], right: list[int]) -> int:
    for index, (left_token, right_token) in enumerate(zip(left, right)):
        if left_token != right_token:
            return index
    raise RuntimeError("rendered sufficient and insufficient calls do not diverge")


def status_logprob(
    top_logprobs: dict[str, float], decoded_token: str
) -> float:
    if decoded_token not in top_logprobs:
        raise RuntimeError(
            f"requested status token {decoded_token!r} missing from {top_logprobs}"
        )
    return float(top_logprobs[decoded_token])


def measure_state(
    client: ProbeClient,
    root: Path,
    state: dict[str, Any],
    samples: int,
) -> dict[str, Any]:
    question_hash = hashlib.sha256(state["question_id"].encode()).hexdigest()[:12]
    output_path = (
        root
        / "probes"
        / question_hash
        / f"step-{state['decision_step']:03d}.json"
    )
    if output_path.exists():
        existing = read_json(output_path)
        if (
            existing.get("capture_id") == state["capture_id"]
            and existing.get("j", {}).get("sample_count") == samples
        ):
            return {"status": "reused", "path": str(output_path)}

    captured_request = read_json(Path(state["capture_dir"]) / "request.body")
    sufficient_tokens, render_upstream_s = render_finish(
        client, captured_request, "sufficient"
    )
    insufficient_tokens, render_upstream_i = render_finish(
        client, captured_request, "insufficient"
    )
    difference = first_difference(sufficient_tokens, insufficient_tokens)
    sufficient_branch = sufficient_tokens[difference]
    insufficient_branch = insufficient_tokens[difference]
    if sufficient_branch == insufficient_branch:
        raise RuntimeError("status branch token ids are equal")
    prompt_tokens = sufficient_tokens[:difference]
    model = str(captured_request["model"])
    sufficient_text = client.detokenize(model, sufficient_branch)
    insufficient_text = client.detokenize(model, insufficient_branch)

    likelihood_payload = {
        "model": model,
        "prompt": prompt_tokens,
        "max_tokens": 1,
        "temperature": 1.0,
        "top_p": 1.0,
        "logprobs": 1,
        "logprob_token_ids": [sufficient_branch, insufficient_branch],
        "return_token_ids": True,
    }
    likelihood_response = client.post("/v1/completions", likelihood_payload)
    likelihood_body = likelihood_response.json()
    top_logprobs = likelihood_body["choices"][0]["logprobs"]["top_logprobs"][0]
    sufficient_logprob = status_logprob(top_logprobs, sufficient_text)
    insufficient_logprob = status_logprob(top_logprobs, insufficient_text)
    maximum = max(sufficient_logprob, insufficient_logprob)
    sufficient_likelihood = math.exp(sufficient_logprob - maximum) / (
        math.exp(sufficient_logprob - maximum)
        + math.exp(insufficient_logprob - maximum)
    )

    seed = int(hashlib.sha256(state["capture_id"].encode()).hexdigest()[:8], 16)
    sampling_payload = {
        "model": model,
        "prompt": prompt_tokens,
        "max_tokens": 1,
        "n": samples,
        "temperature": 1.0,
        "top_p": 1.0,
        "allowed_token_ids": [sufficient_branch, insufficient_branch],
        "return_token_ids": True,
        "seed": seed,
    }
    sampling_response = client.post("/v1/completions", sampling_payload)
    sampling_body = sampling_response.json()
    sampled_tokens = [
        int(choice["token_ids"][0]) for choice in sampling_body.get("choices", [])
    ]
    if len(sampled_tokens) != samples:
        raise RuntimeError(
            f"expected {samples} status samples, received {len(sampled_tokens)}"
        )
    invalid_tokens = sorted(
        set(sampled_tokens) - {sufficient_branch, insufficient_branch}
    )
    if invalid_tokens:
        raise RuntimeError(f"invalid constrained status tokens: {invalid_tokens}")
    sufficient_count = sampled_tokens.count(sufficient_branch)
    prefixes = {
        str(size): sampled_tokens[:size].count(sufficient_branch) / size
        for size in (7, 15, 31, 63)
        if size <= samples
    }

    result = {
        "schema_version": 1,
        "question_id": state["question_id"],
        "decision_step": state["decision_step"],
        "decision_state_count": state["decision_state_count"],
        "normalized_progress": state["normalized_progress"],
        "capture_id": state["capture_id"],
        "request_sha256": state["request_sha256"],
        "protocol": {
            "name": "native-finish-prefix-v1",
            "extra_sufficiency_prompt": False,
            "agent_messages_changed": False,
            "finish_schema": "captured Picorer v1.0.0 finish tool",
            "conditioning": "native rendered finish call through status field prefix",
            "status_branch_position": difference,
            "status_branch_tokens": {
                "sufficient": {
                    "id": sufficient_branch,
                    "text": sufficient_text,
                },
                "insufficient": {
                    "id": insufficient_branch,
                    "text": insufficient_text,
                },
            },
        },
        "s": {
            "sufficient_likelihood": sufficient_likelihood,
            "sufficient_logprob": sufficient_logprob,
            "insufficient_logprob": insufficient_logprob,
            "native_generated_token_ids": likelihood_body["choices"][0].get(
                "token_ids"
            ),
            "usage": likelihood_body.get("usage"),
            "upstream": likelihood_response.headers.get("X-Qwen-Upstream"),
        },
        "j": {
            "sample_count": samples,
            "sufficient_count": sufficient_count,
            "insufficient_count": samples - sufficient_count,
            "sufficient_fraction": sufficient_count / samples,
            "prefix_estimates": prefixes,
            "seed": seed,
            "temperature": 1.0,
            "top_p": 1.0,
            "usage": sampling_body.get("usage"),
            "upstream": sampling_response.headers.get("X-Qwen-Upstream"),
        },
        "render_upstreams": [render_upstream_s, render_upstream_i],
    }
    write_json_atomic(output_path, result)
    return {"status": "completed", "path": str(output_path)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--wait-state", type=Path)
    parser.add_argument("--poll-seconds", type=float, default=30)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--ca-bundle", required=True)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--samples", type=int, default=63)
    parser.add_argument("--timeout-seconds", type=float, default=600)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = args.experiment_root.resolve()
    if args.wait_state is not None:
        wait_for_retrieval(args.wait_state.resolve(), args.poll_seconds)
    states = build_decision_state_index(root)
    print(
        json.dumps(
            {
                "event": "measurement_started",
                "states": len(states),
                "workers": args.workers,
                "samples_per_state": args.samples,
            }
        ),
        flush=True,
    )
    client = ProbeClient(args.endpoint, args.ca_bundle, args.timeout_seconds)
    completed = 0
    reused = 0
    failures: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_state = {
            executor.submit(measure_state, client, root, state, args.samples): state
            for state in states
        }
        for future in concurrent.futures.as_completed(future_to_state):
            state = future_to_state[future]
            try:
                outcome = future.result()
                if outcome["status"] == "reused":
                    reused += 1
                else:
                    completed += 1
            except BaseException as error:
                failures.append(
                    {
                        "question_id": state["question_id"],
                        "decision_step": state["decision_step"],
                        "capture_id": state["capture_id"],
                        "error_type": type(error).__name__,
                        "error": repr(error),
                    }
                )
            processed = completed + reused + len(failures)
            if processed % 25 == 0 or processed == len(states):
                print(
                    json.dumps(
                        {
                            "event": "measurement_progress",
                            "processed": processed,
                            "total": len(states),
                            "completed": completed,
                            "reused": reused,
                            "failed": len(failures),
                        }
                    ),
                    flush=True,
                )
    summary = {
        "schema_version": 1,
        "decision_state_count": len(states),
        "samples_per_state": args.samples,
        "completed": completed,
        "reused": reused,
        "failed": len(failures),
        "failures": failures,
    }
    write_json_atomic(root / "measurement-summary.json", summary)
    if failures:
        raise RuntimeError(f"{len(failures)} decision-state measurements failed")


if __name__ == "__main__":
    main()
