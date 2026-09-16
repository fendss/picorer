from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Mapping, Sequence

from runtime.artifacts import canonical_sha256, file_sha256, write_json_atomic


class WorkerProtocolError(RuntimeError):
    pass


def _load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise WorkerProtocolError(f"cannot load {label}: {error}") from error
    if not isinstance(value, dict):
        raise WorkerProtocolError(f"{label} must be a JSON object")
    return value


def _write(path: Path, value: Mapping[str, Any]) -> None:
    write_json_atomic(path, dict(value))


def _json_inventory(root: Path) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    if not root.exists():
        return inventory
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise WorkerProtocolError(f"official output contains a symlink: {path}")
        if path.is_file():
            inventory.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "size": path.stat().st_size,
                    "sha256": file_sha256(path),
                }
            )
    return inventory


def _load_json_files(root: Path) -> list[tuple[Path, Any]]:
    values: list[tuple[Path, Any]] = []
    for path in sorted(root.rglob("*.json")):
        try:
            values.append((path, json.loads(path.read_text(encoding="utf-8"))))
        except (OSError, json.JSONDecodeError) as error:
            raise WorkerProtocolError(f"invalid official JSON output {path}: {error}") from error
    return values


def _scoped_uuid(scope: str, label: str) -> SimpleNamespace:
    counter = 0

    def uuid4() -> str:
        nonlocal counter
        counter += 1
        return f"{scope}::{label}-{counter}"

    return SimpleNamespace(uuid4=uuid4)


def _agent_model(config: Mapping[str, Any]) -> str:
    agent = config.get("agent")
    return str(agent.get("model_name", "unknown")) if isinstance(agent, Mapping) else "unknown"


def _travel_usage_event(
    usage_path: Path, output_root: Path, model: str
) -> dict[str, Any]:
    """Expose token totals without promoting the official local cost estimate."""

    raw = _load_object(usage_path, "official travel usage")
    return {
        "stage": "official-travel-agent",
        "model": model,
        "usage": {
            "input_tokens": raw.get("total_input_tokens", 0),
            "output_tokens": raw.get("total_output_tokens", 0),
        },
        "source": usage_path.relative_to(output_root).as_posix(),
        # total_cost is retained only as an upstream diagnostic. It comes from
        # MemoryArena's hard-coded CostTracker, not from the provider response.
        "raw": raw,
    }


def _travel_usage_coverage() -> dict[str, Any]:
    return {
        "status": "partial",
        "official-agent": (
            "partial: aggregate tokens include only responses whose usage was "
            "exposed by the pinned client; provider-attempt denominator is unavailable"
        ),
        "official-judge": "not called in judgement_mode=none; full evaluator deferred",
        "gaps": ["external provider-attempt ledger reconciliation is absent"],
    }


def _verify_provider_proxy_environment(request: Mapping[str, Any]) -> None:
    expected = request.get("provider_proxy_url")
    if not isinstance(expected, str) or any(
        os.environ.get(variable, "").rstrip("/") != expected.rstrip("/")
        for variable in ("OPENAI_BASE_URL", "OPENAI_API_BASE")
    ):
        raise WorkerProtocolError("provider metering proxy env mismatch")


def _search_usage(output_root: Path, model: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    # The raw search-agent files are the only non-aggregate source.  Do not use
    # run_search's final summary as well or final-query usage would be doubled.
    for path, value in _load_json_files(output_root):
        if "query_" not in path.as_posix() or not isinstance(value, Mapping):
            continue
        usage = value.get("usage")
        if isinstance(usage, Mapping) and usage:
            events.append(
                {
                    "stage": "official-search-agent",
                    "model": str(value.get("model") or model),
                    "response_model": value.get("response_model"),
                    "request_id": value.get("request_id"),
                    "usage": dict(usage),
                    "source": path.relative_to(output_root).as_posix(),
                }
            )
    return events


def _shopping(request: Mapping[str, Any], record: Mapping[str, Any]) -> dict[str, Any]:
    checkout = Path(request["checkout"])
    output_root = Path(request["output_dir"])
    config_path = Path(request["config"])
    scope = str(request["memory_scope"])

    from env.env_systems.web_shopping_env.runtime.runner.task_files import (
        _reconstruct_task_def_from_hf_row,
    )
    import run_shopping
    _verify_provider_proxy_environment(request)

    task_def = _reconstruct_task_def_from_hf_row(dict(record))
    if task_def.get("metadata", {}).get("hf_id") != record.get("id"):
        raise WorkerProtocolError("official shopping reconstruction changed source identity")
    task_file = output_root.parent / "official-task.json"
    _write(task_file, task_def)

    original_user_id = run_shopping.task_memory_user_id
    run_shopping.task_memory_user_id = lambda args, task, path: (
        f"{scope}::{original_user_id(args, task, path)}"
    )
    argv = [
        os.fspath(checkout / "run_shopping.py"),
        "--config",
        os.fspath(config_path),
        "--task-file",
        os.fspath(task_file),
        "--output-dir",
        os.fspath(output_root),
    ]
    with contextlib.ExitStack():
        previous = sys.argv
        try:
            sys.argv = argv
            run_shopping.main()
        finally:
            sys.argv = previous

    step_results: list[tuple[Path, Mapping[str, Any]]] = []
    interaction_turns = 0
    swallowed_errors: list[str] = []
    for path, value in _load_json_files(output_root):
        if not isinstance(value, Mapping):
            continue
        if "step_results" in path.parts and isinstance(value.get("steps"), list):
            step_results.append((path, value))
        if "interaction_history" in path.parts:
            turns = value.get("turns")
            if isinstance(turns, list):
                interaction_turns += len(turns)
            if value.get("error"):
                swallowed_errors.append(str(value["error"]))
    if len(step_results) != 1:
        raise WorkerProtocolError(
            f"shopping emitted {len(step_results)} task results instead of one"
        )
    result = dict(step_results[0][1])
    steps = result.get("steps")
    if not isinstance(steps, list) or len(steps) != len(record["questions"]):
        raise WorkerProtocolError("shopping task result is incomplete")
    if interaction_turns < len(steps):
        raise WorkerProtocolError("shopping raw interactions are incomplete")
    return {
        "result": result,
        "completed_count": len(steps),
        "expected_shopping_adds": interaction_turns,
        "usage": [],
        "usage_coverage": {
            "official-agent": "unknown: pinned shopping runner does not expose provider usage",
            "official-judge": "unknown: environment judge usage is not returned",
        },
        "swallowed_errors": swallowed_errors,
    }


def _search(request: Mapping[str, Any], record: Mapping[str, Any]) -> dict[str, Any]:
    output_root = Path(request["output_dir"])
    config_path = Path(request["config"])
    query_id = str(request["official_query_id"])
    scope = str(request["memory_scope"])
    config = _load_object(config_path, "attempt search config")

    import run_search
    _verify_provider_proxy_environment(request)

    run_search.uuid = _scoped_uuid(scope, "search")
    previous = sys.argv
    try:
        sys.argv = [os.fspath(Path(request["checkout"]) / "run_search.py"), "--config", os.fspath(config_path)]
        run_search.main()
    finally:
        sys.argv = previous

    summary_path = output_root / f"query_{query_id}_result.json"
    summary = _load_object(summary_path, "official search result")
    if summary.get("query_ids") != [query_id]:
        raise WorkerProtocolError("official search runner did not execute exactly one query id")
    per_query = summary.get("per_query")
    if not isinstance(per_query, Mapping) or set(per_query) != {query_id}:
        raise WorkerProtocolError("official search output has an invalid per_query set")
    item = per_query[query_id]
    if not isinstance(item, Mapping) or not isinstance(item.get("result"), Mapping):
        raise WorkerProtocolError("official search output has no raw result")
    raw_result = item["result"]
    judgement = raw_result.get("judgement")
    if not isinstance(judgement, Mapping) or "correct" not in judgement:
        raise WorkerProtocolError("official search judge output is missing")
    # The pinned evaluator counts a successfully returned but unparseable judge
    # response as incorrect.  Preserve that model output instead of retrying it.
    expected_dirs = [
        output_root / f"query_{query_id}" / "subqueries" / f"subquery_{index}"
        for index in range(1, len(record["questions"]))
    ] + [output_root / f"query_{query_id}" / "final_query"]
    for directory in expected_dirs:
        if not directory.is_dir() or not list(directory.glob("*.json")):
            raise WorkerProtocolError(f"official search raw output missing: {directory}")
    return {
        "result": summary,
        "completed_count": len(record["questions"]),
        "usage": _search_usage(output_root, _agent_model(config)),
        "usage_coverage": {
            "official-agent": "observed from raw per-query provider files when emitted",
            "official-judge": "unknown: pinned BrowseComp judge discards response usage",
        },
        "swallowed_errors": [],
    }


def _travel(request: Mapping[str, Any], record: Mapping[str, Any]) -> dict[str, Any]:
    output_root = Path(request["output_dir"])
    config_path = Path(request["config"])
    scope = str(request["memory_scope"])
    config = _load_object(config_path, "attempt travel config")

    import run_travel
    from env.env_systems.travel_planner_env.data_loader import _convert_row
    _verify_provider_proxy_environment(request)

    converted = _convert_row(dict(record))
    run_travel.load_travel_data = lambda: [converted]
    original_memory = run_travel.get_memory_system
    run_travel.get_memory_system = lambda name, user_id, server_url: original_memory(
        name, f"{scope}::{user_id}", server_url
    )

    original_client = run_travel.EnvironmentClient

    class VerifyingEnvironmentClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self._inner = original_client(*args, **kwargs)

        def reset(self, *args: Any, **kwargs: Any) -> Any:
            observation = self._inner.reset(*args, **kwargs)
            for key in ("base_person", "questions", "answers"):
                if observation.get(key) != converted[key]:
                    raise WorkerProtocolError(
                        f"travel environment data differs from pinned source: {key}"
                    )
            if observation.get("group_id", observation.get("id")) != converted["id"]:
                raise WorkerProtocolError("travel environment selected another group")
            return observation

        def step(self, *args: Any, **kwargs: Any) -> Any:
            return self._inner.step(*args, **kwargs)

        def close(self) -> Any:
            return self._inner.close()

    run_travel.EnvironmentClient = VerifyingEnvironmentClient
    evaluator_calls: list[dict[str, Any]] = []

    def defer_evaluator(**kwargs: Any) -> dict[str, Any]:
        evaluator_calls.append(dict(kwargs))
        return {"deferred_until_701_complete": True}

    run_travel.evaluate = defer_evaluator
    previous = sys.argv
    try:
        sys.argv = [os.fspath(Path(request["checkout"]) / "run_travel.py"), "--config", os.fspath(config_path)]
        run_travel.main()
    finally:
        sys.argv = previous
    if len(evaluator_calls) != 1:
        raise WorkerProtocolError("travel runner evaluator boundary changed")

    generated = _load_object(
        output_root / f"generated_plan_{record['id']}.json", "official travel output"
    )
    model = _agent_model(config)
    final = generated.get(f"{model}_sole-planning_results")
    if not isinstance(final, list) or len(final) != len(record["questions"]):
        raise WorkerProtocolError("official travel group output is incomplete")
    usage_path = output_root / "stats_results" / "usage_stats.json"
    usage_events = [_travel_usage_event(usage_path, output_root, model)]
    return {
        "result": generated,
        "completed_count": len(final),
        "usage": usage_events,
        "usage_coverage": _travel_usage_coverage(),
        "swallowed_errors": [
            str(item.get("error_message"))
            for item in generated.get("scratchpads", [])
            if isinstance(item, Mapping) and item.get("success") is False
        ],
    }


def _formal(request: Mapping[str, Any], record: Mapping[str, Any]) -> dict[str, Any]:
    config_path = Path(request["config"])
    output_root = Path(request["output_dir"])
    scope = str(request["memory_scope"])
    config = _load_object(config_path, "attempt formal config")

    import run_math
    _verify_provider_proxy_environment(request)

    run_math.uuid = _scoped_uuid(scope, "formal")
    tasks = list(zip(record["questions"], record["answers"], record["backgrounds"]))
    # This is the official inner task-group function.  Calling run_math.main()
    # would trigger its known duplicate-main bug and unpinned HF loader.
    logs = run_math.run_task_with_memory_and_env(config, tasks, str(record["paper_name"]))
    if not isinstance(logs, list) or len(logs) != len(tasks):
        raise WorkerProtocolError("official formal task-group output is incomplete")
    if [item.get("query_id") for item in logs] != list(range(len(tasks))):
        raise WorkerProtocolError("official formal query ids are incomplete or reordered")
    for item in logs:
        judge = item.get("judge_result")
        if not isinstance(judge, Mapping) or "is_correct" not in judge:
            raise WorkerProtocolError("official formal judge output is missing")
    return {
        "result": {"paper_name": record["paper_name"], "logs": logs},
        "completed_count": len(logs),
        "usage": [],
        "usage_coverage": {
            "official-agent": "unknown: pinned formal runner does not expose provider usage",
            "official-judge": "unknown: environment response omits judge provider usage",
        },
        "swallowed_errors": [],
    }


_DISPATCH: Mapping[str, Callable[[Mapping[str, Any], Mapping[str, Any]], dict[str, Any]]] = {
    "bundled_shopping": _shopping,
    "progressive_search": _search,
    "group_travel_planner": _travel,
    "formal_reasoning_math": _formal,
    "formal_reasoning_phys": _formal,
}


def _partial_usage(request: Mapping[str, Any], output_root: Path) -> list[dict[str, Any]]:
    suite = str(request.get("suite"))
    try:
        config = _load_object(Path(request["config"]), "attempt config")
        model = _agent_model(config)
        if suite == "progressive_search":
            return _search_usage(output_root, model)
        if suite == "group_travel_planner":
            usage_path = output_root / "stats_results/usage_stats.json"
            if usage_path.is_file():
                return [_travel_usage_event(usage_path, output_root, model)]
    except Exception:
        return []
    return []


def execute_request(request_path: Path, response_path: Path) -> int:
    request = _load_object(request_path, "worker request")
    seam_bundle_sha256 = request.get("seam_bundle_sha256")
    if (
        not isinstance(seam_bundle_sha256, str)
        or len(seam_bundle_sha256) != 64
        or request.get("worker_sha256") != file_sha256(Path(__file__).resolve())
    ):
        _write(
            response_path,
            {"status": "protocol_error", "error": "production seam/worker hash mismatch"},
        )
        return 2
    try:
        _verify_provider_proxy_environment(request)
    except WorkerProtocolError:
        _write(
            response_path,
            {"status": "protocol_error", "error": "provider metering proxy env mismatch"},
        )
        return 2
    checkout = Path(request.get("checkout", "")).resolve()
    if not checkout.is_dir() or not (checkout / "run_search.py").is_file():
        _write(response_path, {"status": "protocol_error", "error": "invalid checkout"})
        return 2
    sys.path.insert(0, os.fspath(checkout))
    output_root = Path(request["output_dir"]).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    try:
        record = _load_object(Path(request["record"]), "pinned source record")
        if canonical_sha256(record) != request.get("source_record_hash"):
            raise WorkerProtocolError("worker source record differs from TaskSpec hash")
        suite = str(request.get("suite"))
        dispatcher = _DISPATCH.get(suite)
        if dispatcher is None:
            raise WorkerProtocolError(f"unsupported official suite: {suite}")
        result = dispatcher(request, record)
        swallowed = result.get("swallowed_errors")
        status = "infra_error" if isinstance(swallowed, list) and swallowed else "ok"
        response = {
            "schema_version": 1,
            "status": status,
            "seam_bundle_sha256": seam_bundle_sha256,
            **result,
            "output_inventory": _json_inventory(output_root),
        }
        _write(response_path, response)
        return 0 if status == "ok" else 3
    except WorkerProtocolError as error:
        _write(
            response_path,
            {
                "schema_version": 1,
                "status": "protocol_error",
                "seam_bundle_sha256": seam_bundle_sha256,
                "error": str(error),
                "usage": _partial_usage(request, output_root),
                "usage_coverage": {
                    "partial_failure": "observed raw usage only; unavailable calls remain unknown"
                },
                "output_inventory": _json_inventory(output_root),
            },
        )
        return 2
    except Exception as error:
        _write(
            response_path,
            {
                "schema_version": 1,
                "status": "infra_error",
                "seam_bundle_sha256": seam_bundle_sha256,
                "error_type": type(error).__name__,
                "error": str(error)[:4000],
                "traceback": traceback.format_exc()[-12000:],
                "usage": _partial_usage(request, output_root),
                "usage_coverage": {
                    "partial_failure": "observed raw usage only; unavailable calls remain unknown"
                },
                "output_inventory": _json_inventory(output_root),
            },
        )
        return 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Isolated pinned MemoryArena task-group worker")
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--response", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return execute_request(args.request.resolve(), args.response.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
