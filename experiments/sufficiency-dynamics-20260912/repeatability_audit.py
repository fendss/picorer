#!/usr/bin/env python3
"""Repeat one balanced state to quantify backend numerical repeatability."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import math
import statistics
from pathlib import Path
from typing import Any


def load_module(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("measurement", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def repeat_endpoint(
    module: Any,
    endpoint: str,
    ca_bundle: str,
    request: dict[str, Any],
    seed: int,
    repeats: int,
) -> dict[str, Any]:
    client = module.ProbeClient(endpoint, ca_bundle, 600)
    sufficient, _ = module.render_finish(client, request, "sufficient")
    insufficient, _ = module.render_finish(client, request, "insufficient")
    difference = module.first_difference(sufficient, insufficient)
    sufficient_token = int(sufficient[difference])
    insufficient_token = int(insufficient[difference])
    prompt = sufficient[:difference]
    sufficient_text = client.detokenize(str(request["model"]), sufficient_token)
    insufficient_text = client.detokenize(str(request["model"]), insufficient_token)
    s_values = []
    s_logprob_pairs = []
    j_sequences = []
    for _ in range(repeats):
        s_body = client.post(
            "/v1/completions",
            {
                "model": request["model"],
                "prompt": prompt,
                "max_tokens": 1,
                "temperature": 1.0,
                "top_p": 1.0,
                "logprobs": 1,
                "logprob_token_ids": [sufficient_token, insufficient_token],
                "return_token_ids": True,
            },
        ).json()
        top = s_body["choices"][0]["logprobs"]["top_logprobs"][0]
        left = float(top[sufficient_text])
        right = float(top[insufficient_text])
        s_logprob_pairs.append(
            {
                "sufficient": left,
                "insufficient": right,
                "top_logprobs": top,
            }
        )
        maximum = max(left, right)
        s_values.append(
            math.exp(left - maximum)
            / (math.exp(left - maximum) + math.exp(right - maximum))
        )
        j_body = client.post(
            "/v1/completions",
            {
                "model": request["model"],
                "prompt": prompt,
                "max_tokens": 1,
                "n": 63,
                "temperature": 1.0,
                "top_p": 1.0,
                "allowed_token_ids": [sufficient_token, insufficient_token],
                "return_token_ids": True,
                "seed": seed,
            },
        ).json()
        j_sequences.append(
            [int(choice["token_ids"][0]) for choice in j_body["choices"]]
        )
    counts = [sequence.count(sufficient_token) for sequence in j_sequences]
    return {
        "prompt_token_count": len(prompt),
        "prompt_token_sha256": hashlib.sha256(
            b"".join(token.to_bytes(4, "big") for token in prompt)
        ).hexdigest(),
        "status_branch_position": difference,
        "status_branch_tokens": [sufficient_token, insufficient_token],
        "s_values": s_values,
        "s_logprob_pairs": s_logprob_pairs,
        "s_summary": {
            "min": min(s_values),
            "max": max(s_values),
            "mean": statistics.mean(s_values),
            "pstdev": statistics.pstdev(s_values),
        },
        "j_sufficient_counts": counts,
        "j_unique_sequence_count": len({tuple(sequence) for sequence in j_sequences}),
        "j_sequences": j_sequences,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--measurement-module", type=Path, required=True)
    parser.add_argument("--ca-bundle", required=True)
    parser.add_argument("--endpoint", action="append", required=True)
    parser.add_argument("--repeats", type=int, default=10)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.experiment_root.resolve()
    module = load_module(args.measurement_module.resolve())
    probes = [
        json.loads(path.read_text())
        for path in (root / "probes").glob("*/step-*.json")
    ]
    probe = min(
        probes, key=lambda item: abs(float(item["s"]["sufficient_likelihood"]) - 0.5)
    )
    index = {
        row["capture_id"]: row
        for row in (
            json.loads(line)
            for line in (root / "decision-states" / "index.jsonl").read_text().splitlines()
        )
    }
    request = json.loads(
        (Path(index[probe["capture_id"]]["capture_dir"]) / "request.body").read_text()
    )
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(args.endpoint)) as executor:
        futures = {
            endpoint: executor.submit(
                repeat_endpoint,
                module,
                endpoint,
                args.ca_bundle,
                request,
                int(probe["j"]["seed"]),
                args.repeats,
            )
            for endpoint in args.endpoint
        }
        results = {endpoint: future.result() for endpoint, future in futures.items()}
    report = {
        "schema_version": 1,
        "capture_id": probe["capture_id"],
        "question_id": probe["question_id"],
        "decision_step": probe["decision_step"],
        "stored_s": probe["s"]["sufficient_likelihood"],
        "stored_j_sufficient_count": probe["j"]["sufficient_count"],
        "seed": probe["j"]["seed"],
        "repeats": args.repeats,
        "results": results,
    }
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                endpoint: {
                    "s_summary": result["s_summary"],
                    "j_sufficient_counts": result["j_sufficient_counts"],
                    "j_unique_sequence_count": result["j_unique_sequence_count"],
                }
                for endpoint, result in results.items()
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
