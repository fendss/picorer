#!/usr/bin/env python3
"""Stratified two-upstream replay audit for saved S/J measurements."""

from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import math
from pathlib import Path
from typing import Any

import requests


def load_measurement_module(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("sufficiency_measurement", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def requested_logprob(top: dict[str, float], token: str) -> float:
    if token not in top:
        raise RuntimeError(f"token {token!r} missing from returned logprobs {top}")
    return float(top[token])


def replay_one_endpoint(
    module: Any,
    endpoint: str,
    ca_bundle: str,
    probe: dict[str, Any],
    capture_dir: Path,
) -> dict[str, Any]:
    client = module.ProbeClient(endpoint, ca_bundle, 600)
    request = json.loads((capture_dir / "request.body").read_text())
    sufficient_tokens, _ = module.render_finish(client, request, "sufficient")
    insufficient_tokens, _ = module.render_finish(client, request, "insufficient")
    difference = module.first_difference(sufficient_tokens, insufficient_tokens)
    sufficient_token = int(sufficient_tokens[difference])
    insufficient_token = int(insufficient_tokens[difference])
    prompt = sufficient_tokens[:difference]
    sufficient_text = client.detokenize(str(request["model"]), sufficient_token)
    insufficient_text = client.detokenize(str(request["model"]), insufficient_token)

    s_response = client.post(
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
    top = s_response["choices"][0]["logprobs"]["top_logprobs"][0]
    sufficient_logprob = requested_logprob(top, sufficient_text)
    insufficient_logprob = requested_logprob(top, insufficient_text)
    maximum = max(sufficient_logprob, insufficient_logprob)
    s_value = math.exp(sufficient_logprob - maximum) / (
        math.exp(sufficient_logprob - maximum)
        + math.exp(insufficient_logprob - maximum)
    )

    j_response = client.post(
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
            "seed": int(probe["j"]["seed"]),
        },
    ).json()
    sampled_tokens = [
        int(choice["token_ids"][0]) for choice in j_response["choices"]
    ]
    return {
        "status_branch_position": difference,
        "status_branch_tokens": [sufficient_token, insufficient_token],
        "sufficient_logprob": sufficient_logprob,
        "insufficient_logprob": insufficient_logprob,
        "sufficient_likelihood": s_value,
        "sampled_token_ids": sampled_tokens,
        "sufficient_count": sampled_tokens.count(sufficient_token),
        "insufficient_count": sampled_tokens.count(insufficient_token),
    }


def replay_state(
    module: Any,
    endpoints: list[str],
    ca_bundle: str,
    probe: dict[str, Any],
    index: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    state = index[str(probe["capture_id"])]
    by_endpoint = {
        endpoint: replay_one_endpoint(
            module, endpoint, ca_bundle, probe, Path(state["capture_dir"])
        )
        for endpoint in endpoints
    }
    stored_s = float(probe["s"]["sufficient_likelihood"])
    stored_count = int(probe["j"]["sufficient_count"])
    first, second = (by_endpoint[endpoint] for endpoint in endpoints)
    return {
        "capture_id": probe["capture_id"],
        "question_id": probe["question_id"],
        "decision_step": probe["decision_step"],
        "stored": {
            "sufficient_likelihood": stored_s,
            "sufficient_count": stored_count,
            "seed": probe["j"]["seed"],
        },
        "replay": by_endpoint,
        "checks": {
            "stored_s_matches_both": all(
                abs(result["sufficient_likelihood"] - stored_s) < 1e-10
                for result in by_endpoint.values()
            ),
            "stored_j_count_matches_both": all(
                result["sufficient_count"] == stored_count
                for result in by_endpoint.values()
            ),
            "two_upstream_s_values_equal": abs(
                first["sufficient_likelihood"] - second["sufficient_likelihood"]
            )
            < 1e-12,
            "two_upstream_sample_sequences_equal": (
                first["sampled_token_ids"] == second["sampled_token_ids"]
            ),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--measurement-module", type=Path, required=True)
    parser.add_argument("--ca-bundle", required=True)
    parser.add_argument("--endpoint", action="append", required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if len(args.endpoint) != 2:
        raise RuntimeError("replay audit requires exactly two endpoints")
    root = args.experiment_root.resolve()
    module = load_measurement_module(args.measurement_module.resolve())
    probes = [
        json.loads(path.read_text())
        for path in (root / "probes").glob("*/step-*.json")
    ]
    probes.sort(key=lambda probe: float(probe["s"]["sufficient_likelihood"]))
    quantiles = [0.0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1.0]
    selected_indices = sorted(
        {round(quantile * (len(probes) - 1)) for quantile in quantiles}
    )
    selected = [probes[index] for index in selected_indices]
    index = {
        str(row["capture_id"]): row
        for row in (
            json.loads(line)
            for line in (root / "decision-states" / "index.jsonl").read_text().splitlines()
        )
    }

    endpoint_metadata = {}
    for endpoint in args.endpoint:
        models = requests.get(endpoint + "/v1/models", timeout=60).json()
        version = requests.get(endpoint + "/version", timeout=60).json()
        endpoint_metadata[endpoint] = {"models": models, "version": version}

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [
            executor.submit(
                replay_state,
                module,
                args.endpoint,
                args.ca_bundle,
                probe,
                index,
            )
            for probe in selected
        ]
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda result: result["stored"]["sufficient_likelihood"])
    check_names = list(results[0]["checks"])
    report = {
        "schema_version": 1,
        "selection": "11 quantiles of saved S over all 694 decision states",
        "selected_state_count": len(results),
        "endpoint_metadata": endpoint_metadata,
        "aggregate_checks": {
            check: all(result["checks"][check] for result in results)
            for check in check_names
        },
        "results": results,
    }
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    print(json.dumps(report["aggregate_checks"], indent=2))


if __name__ == "__main__":
    main()
