#!/usr/bin/env python3
"""Exercise forced-finish sampling and logprob support on a captured state."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import requests


def first_chat_request(capture_root: Path) -> tuple[str, dict[str, Any]]:
    for meta_path in sorted(capture_root.glob("*/meta.json")):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if (
            meta.get("path") == "/v1/chat/completions"
            and meta.get("capture_state") == "complete"
            and meta.get("response_status") == 200
        ):
            request = json.loads(
                (meta_path.parent / "request.body").read_text(encoding="utf-8")
            )
            return str(meta["request_id"]), request
    raise RuntimeError("no completed chat request capture found")


def finish_status(choice: dict[str, Any]) -> str | None:
    calls = choice.get("message", {}).get("tool_calls") or []
    for call in calls:
        function = call.get("function") or {}
        if function.get("name") != "finish":
            continue
        try:
            arguments = json.loads(function.get("arguments", "{}"))
        except json.JSONDecodeError:
            return None
        status = arguments.get("status")
        return status if isinstance(status, str) else None
    return None


def compact_response(response: requests.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {"http_status": response.status_code, "text": response.text[:2000]}
    choices = body.get("choices") or []
    messages = [choice.get("message") for choice in choices]
    compact_logprobs = []
    for choice in choices:
        content = (choice.get("logprobs") or {}).get("content") or []
        interesting = []
        for index, entry in enumerate(content):
            token = str(entry.get("token", ""))
            alternatives = entry.get("top_logprobs") or []
            relevant_alternatives = [
                {"token": item.get("token"), "logprob": item.get("logprob")}
                for item in alternatives
                if any(
                    marker in str(item.get("token", "")).lower()
                    for marker in ("sufficient", "insufficient")
                )
            ]
            if relevant_alternatives or any(
                marker in token.lower()
                for marker in ("sufficient", "insufficient", "status", "finish", "tool_call")
            ):
                interesting.append(
                    {
                        "index": index,
                        "token": token,
                        "logprob": entry.get("logprob"),
                        "relevant_top_logprobs": relevant_alternatives,
                    }
                )
        compact_logprobs.append(
            {
                "token_count": len(content),
                "generated_text": "".join(str(item.get("token", "")) for item in content),
                "interesting": interesting,
            }
        )
    return {
        "http_status": response.status_code,
        "response_headers": {
            key.lower(): value
            for key, value in response.headers.items()
            if key.lower() in {"x-qwen-upstream", "x-request-id"}
        },
        "choice_count": len(choices),
        "statuses": [finish_status(choice) for choice in choices],
        "finish_reasons": [choice.get("finish_reason") for choice in choices],
        "messages": messages,
        "logprobs": compact_logprobs,
        "usage": body.get("usage"),
        "error": body.get("error"),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture-root", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--ca-bundle", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    capture_id, captured = first_chat_request(args.capture_root)
    base = json.loads(json.dumps(captured))
    base["max_completion_tokens"] = min(
        int(base.get("max_completion_tokens", 512)), 512
    )
    base["tools"] = [
        tool
        for tool in base.get("tools", [])
        if tool.get("function", {}).get("name") == "finish"
    ]
    if len(base["tools"]) != 1:
        raise RuntimeError("captured state does not contain exactly one finish tool")
    base["tool_choice"] = "required"
    base["parallel_tool_calls"] = False

    sampling = {**base, "n": 3, "temperature": 0.8}
    sampling_response = requests.post(
        args.endpoint,
        headers={"Authorization": "Bearer local-no-key"},
        json=sampling,
        timeout=600,
        verify=args.ca_bundle,
    )

    likelihood = {
        **base,
        "n": 1,
        "temperature": 0,
        "logprobs": True,
        "top_logprobs": 20,
    }
    likelihood_response = requests.post(
        args.endpoint,
        headers={"Authorization": "Bearer local-no-key"},
        json=likelihood,
        timeout=600,
        verify=args.ca_bundle,
    )

    output = {
        "schema_version": 1,
        "source_capture_id": capture_id,
        "same_messages_as_captured_state": True,
        "tool_protocol": "original Picorer finish schema only; tool_choice=required",
        "added_control_fields": {
            "sampling": [
                "tools restricted to original finish schema",
                "tool_choice",
                "parallel_tool_calls",
                "n",
                "temperature",
            ],
            "likelihood": [
                "tools restricted to original finish schema",
                "tool_choice",
                "parallel_tool_calls",
                "n",
                "temperature",
                "logprobs",
                "top_logprobs",
            ],
        },
        "forced_finish_sampling": compact_response(sampling_response),
        "forced_finish_likelihood": compact_response(likelihood_response),
    }
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
