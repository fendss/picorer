#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib
from importlib.machinery import PathFinder
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from runtime.artifacts import (  # type: ignore
        ArtifactStore,
        canonical_sha256,
        file_sha256,
        locked_manifest_document,
        read_json,
        validate_locked_manifest,
    )
    from runtime.integrity import (  # type: ignore
        IntegrityError,
        require_clean_artifact_inventory,
        validate_release_task_manifest,
    )
    from runtime.runner import (  # type: ignore
        MemoryArenaRunner,
        RunnerPolicy,
        RunSummary,
        TaskExecutor,
    )
    from runtime.usage import PriceTable, load_price_table  # type: ignore
else:
    from .artifacts import (
        ArtifactStore,
        canonical_sha256,
        file_sha256,
        locked_manifest_document,
        read_json,
        validate_locked_manifest,
    )
    from .integrity import (
        IntegrityError,
        require_clean_artifact_inventory,
        validate_release_task_manifest,
    )
    from .runner import MemoryArenaRunner, RunnerPolicy, RunSummary, TaskExecutor
    from .usage import PriceTable, load_price_table


class CliContractError(RuntimeError):
    pass


def _load_locked_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = read_json(path.resolve())
        return validate_locked_manifest(value)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise CliContractError(f"invalid locked {label} at {path}: {error}") from error


def _executor_parts(reference: str) -> tuple[str, str]:
    if reference.count(":") != 1:
        raise CliContractError("--executor must use module:function")
    module_name, attribute_name = reference.split(":", 1)
    if not module_name or not attribute_name:
        raise CliContractError("--executor must use module:function")
    return module_name, attribute_name


def executor_implementation_sha256(reference: str) -> str:
    """Hash an executor implementation without importing benchmark code.

    Package executors are a code bundle: helpers and locked JSON descriptors
    can change behavior even when the referenced module itself does not.  Hash
    every Python/JSON file in that package; standalone test/plugin modules keep
    the narrower single-file identity.
    """

    module_name, _ = _executor_parts(reference)
    search_path = None
    spec = None
    for index, component in enumerate(module_name.split(".")):
        if index > 0 and search_path is None:
            raise CliContractError(f"cannot resolve executor module {module_name}")
        spec = PathFinder.find_spec(component, search_path)
        if spec is None:
            raise CliContractError(f"cannot resolve executor module {module_name}")
        search_path = spec.submodule_search_locations
    origin = None if spec is None else spec.origin
    if origin in {None, "built-in", "frozen"}:
        raise CliContractError(
            f"executor module must have a hashable implementation file: {module_name}"
        )
    path = Path(origin).resolve()
    if not path.is_file():
        raise CliContractError(f"executor implementation file is missing: {path}")
    package_root = path.parent
    if "." not in module_name or not (package_root / "__init__.py").is_file():
        return file_sha256(path)
    files = sorted(
        candidate
        for candidate in package_root.rglob("*")
        if candidate.is_file()
        and candidate.suffix in {".py", ".json"}
        and "__pycache__" not in candidate.parts
    )
    if path not in files:
        raise CliContractError("executor package identity omitted its module file")
    return canonical_sha256([
        {
            "path": candidate.relative_to(package_root).as_posix(),
            "sha256": file_sha256(candidate),
        }
        for candidate in files
    ])


def load_executor(
    reference: str, *, expected_implementation_sha256: Optional[str] = None
) -> TaskExecutor:
    module_name, attribute_name = _executor_parts(reference)
    current_hash = executor_implementation_sha256(reference)
    if (
        expected_implementation_sha256 is not None
        and current_hash != expected_implementation_sha256
    ):
        raise CliContractError("executor implementation changed before import")
    try:
        module = importlib.import_module(module_name)
        executor = getattr(module, attribute_name)
    except (ImportError, AttributeError) as error:
        raise CliContractError(f"cannot load executor {reference}: {error}") from error
    if not callable(executor):
        raise CliContractError(f"executor is not callable: {reference}")
    if getattr(executor, "__module__", None) != module_name:
        raise CliContractError(
            "executor must be defined in the referenced module so its implementation "
            "hash is unambiguous"
        )
    if executor_implementation_sha256(reference) != current_hash:
        raise CliContractError("executor implementation changed during import")
    return executor


def _runtime_value(
    supplied: Optional[int],
    *,
    key: str,
    source_manifest: Mapping[str, Any],
    existing_manifest: Optional[Mapping[str, Any]],
    default: int,
) -> int:
    if supplied is not None:
        return supplied
    if existing_manifest is not None:
        execution = existing_manifest.get("runtime_execution")
        if isinstance(execution, Mapping) and execution.get(key) is not None:
            return int(execution[key])
    defaults = source_manifest.get("runtime_defaults")
    if isinstance(defaults, Mapping) and defaults.get(key) is not None:
        return int(defaults[key])
    return default


def _runtime_float_value(
    supplied: Optional[float],
    *,
    key: str,
    source_manifest: Mapping[str, Any],
    existing_manifest: Optional[Mapping[str, Any]],
    default: float,
) -> float:
    if supplied is not None:
        return supplied
    if existing_manifest is not None:
        execution = existing_manifest.get("runtime_execution")
        if isinstance(execution, Mapping) and execution.get(key) is not None:
            return float(execution[key])
    defaults = source_manifest.get("runtime_defaults")
    if isinstance(defaults, Mapping) and defaults.get(key) is not None:
        return float(defaults[key])
    return default


def effective_run_manifest(
    source_manifest: Mapping[str, Any],
    *,
    task_manifest_sha256: str,
    executor_reference: str,
    slots: int,
    attempts: int,
    retry_initial_delay_seconds: float,
    retry_max_delay_seconds: float,
    price_table: Optional[PriceTable],
    executor_implementation_hash: str,
) -> dict[str, Any]:
    source = validate_locked_manifest(source_manifest)
    source_hash = str(source["manifest_sha256"])
    body = dict(source)
    body.pop("manifest_sha256", None)
    if body.get("benchmark_name") != "MemoryArena Public":
        raise CliContractError("run manifest benchmark_name must be MemoryArena Public")
    if not isinstance(body.get("run_id"), str) or not body["run_id"]:
        raise CliContractError("run manifest must contain a non-empty run_id")
    locked_task_hash = body.get("task_manifest_sha256")
    if locked_task_hash is not None and locked_task_hash != task_manifest_sha256:
        raise CliContractError("source run manifest references another task manifest")
    locked_price_hash = body.get("price_table_sha256")
    actual_price_hash = price_table.sha256 if price_table else None
    if locked_price_hash is not None and locked_price_hash != actual_price_hash:
        raise CliContractError("source run manifest references another price table")
    if "runtime_execution" in body or "source_run_manifest_sha256" in body:
        raise CliContractError(
            "source run manifest uses fields reserved for the local runtime"
        )
    body["task_manifest_sha256"] = task_manifest_sha256
    body["source_run_manifest_sha256"] = source_hash
    body["runtime_execution"] = {
        "schema_version": 1,
        "executor": executor_reference,
        "executor_implementation_sha256": executor_implementation_hash,
        "slots": slots,
        "attempts_per_invocation": attempts,
        "task_retry_initial_delay_seconds": retry_initial_delay_seconds,
        "task_retry_max_delay_seconds": retry_max_delay_seconds,
        "price_table_sha256": price_table.sha256 if price_table else None,
    }
    return locked_manifest_document(body)


def _runtime_artifacts_exist(run_dir: Path) -> bool:
    runtime_paths = (
        run_dir / "run-manifest.json",
        run_dir / "task-manifest.json",
        run_dir / "records",
        run_dir / "attempts",
        run_dir / "judge-cache",
        run_dir / "usage",
        run_dir / "indexes",
    )
    return any(path.exists() for path in runtime_paths)


def execute_from_args(args: argparse.Namespace) -> RunSummary:
    task_source = _load_locked_json(args.task_manifest, "task manifest")
    if task_source.get("test_fixture") is True:
        raise CliContractError(
            "production CLI refuses task manifests marked test_fixture=true"
        )
    tasks = validate_release_task_manifest(task_source)
    run_source = _load_locked_json(args.run_manifest, "run manifest")
    run_dir = args.run_dir.resolve()
    existing_manifest: Optional[dict[str, Any]] = None

    if args.resume:
        if not (run_dir / "run-manifest.json").is_file() or not (
            run_dir / "task-manifest.json"
        ).is_file():
            raise CliContractError("--resume requires an initialized runtime run directory")
        existing_manifest = read_json(run_dir / "run-manifest.json")
    elif _runtime_artifacts_exist(run_dir):
        raise CliContractError(
            "runtime artifacts already exist; pass --resume after verifying provenance"
        )

    slots = _runtime_value(
        args.slots,
        key="slots",
        source_manifest=run_source,
        existing_manifest=existing_manifest,
        default=1,
    )
    attempts = _runtime_value(
        args.attempts,
        key="attempts_per_invocation",
        source_manifest=run_source,
        existing_manifest=existing_manifest,
        default=3,
    )
    retry_initial_delay_seconds = _runtime_float_value(
        args.retry_initial_delay_seconds,
        key="task_retry_initial_delay_seconds",
        source_manifest=run_source,
        existing_manifest=existing_manifest,
        default=1.0,
    )
    retry_max_delay_seconds = _runtime_float_value(
        args.retry_max_delay_seconds,
        key="task_retry_max_delay_seconds",
        source_manifest=run_source,
        existing_manifest=existing_manifest,
        default=60.0,
    )
    if slots < 1 or attempts < 1:
        raise CliContractError("slots and attempts must be positive")
    if retry_initial_delay_seconds < 0:
        raise CliContractError("retry initial delay must be non-negative")
    if retry_max_delay_seconds < retry_initial_delay_seconds:
        raise CliContractError(
            "retry max delay must be greater than or equal to initial delay"
        )
    executor_hash = executor_implementation_sha256(args.executor)
    price_table = load_price_table(args.price_table) if args.price_table else None
    if existing_manifest is not None:
        previous_execution = existing_manifest.get("runtime_execution")
        previous_price_hash = (
            previous_execution.get("price_table_sha256")
            if isinstance(previous_execution, Mapping)
            else None
        )
        if previous_price_hash is not None and price_table is None:
            raise CliContractError(
                "resume requires the same --price-table used by the original run"
            )
        previous_executor_hash = (
            previous_execution.get("executor_implementation_sha256")
            if isinstance(previous_execution, Mapping)
            else None
        )
        if previous_executor_hash != executor_hash:
            raise CliContractError(
                "resume executor implementation differs from the original run"
            )
        if not isinstance(previous_execution, Mapping) or any(
            key not in previous_execution
            for key in (
                "task_retry_initial_delay_seconds",
                "task_retry_max_delay_seconds",
            )
        ):
            raise CliContractError(
                "resume run manifest is missing the frozen task retry policy"
            )
        previous_retry_policy = (
            float(previous_execution["task_retry_initial_delay_seconds"]),
            float(previous_execution["task_retry_max_delay_seconds"]),
        )
        if previous_retry_policy != (
            retry_initial_delay_seconds,
            retry_max_delay_seconds,
        ):
            raise CliContractError(
                "resume task retry policy differs from the original run"
            )
    effective_manifest = effective_run_manifest(
        run_source,
        task_manifest_sha256=str(task_source["manifest_sha256"]),
        executor_reference=args.executor,
        slots=slots,
        attempts=attempts,
        retry_initial_delay_seconds=retry_initial_delay_seconds,
        retry_max_delay_seconds=retry_max_delay_seconds,
        price_table=price_table,
        executor_implementation_hash=executor_hash,
    )
    run_id = str(effective_manifest["run_id"])
    store = ArtifactStore(run_dir, run_id, price_table=price_table)

    # Install or byte-validate manifests before importing domain code.  A
    # mismatched resume therefore cannot execute any benchmark side effect.
    store.initialize(run_manifest=effective_manifest, task_manifest=task_source)
    _, local_task_manifest = store.load_manifests()
    require_clean_artifact_inventory(store, local_task_manifest)
    executor = load_executor(
        args.executor, expected_implementation_sha256=executor_hash
    )
    runner = MemoryArenaRunner(
        store=store,
        tasks=tasks,
        run_manifest=effective_manifest,
        task_manifest=task_source,
        policy=RunnerPolicy(
            concurrency=slots,
            task_attempts_per_invocation=attempts,
            task_retry_initial_delay_seconds=retry_initial_delay_seconds,
            task_retry_max_delay_seconds=retry_max_delay_seconds,
        ),
        price_table=price_table,
    )
    summary = runner.run(executor)
    require_clean_artifact_inventory(store, local_task_manifest)
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run Picorer on a locked MemoryArena Public task manifest"
    )
    parser.add_argument("--task-manifest", type=Path, required=True)
    parser.add_argument("--run-manifest", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--executor", required=True, help="module:function")
    parser.add_argument("--slots", type=int)
    parser.add_argument("--attempts", type=int)
    parser.add_argument("--retry-initial-delay-seconds", type=float)
    parser.add_argument("--retry-max-delay-seconds", type=float)
    parser.add_argument("--price-table", type=Path)
    parser.add_argument("--resume", action="store_true")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        summary = execute_from_args(args)
    except (CliContractError, IntegrityError, ValueError, RuntimeError) as error:
        print(f"MemoryArena Public runtime error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(summary.to_dict(), ensure_ascii=False, sort_keys=True))
    return 0 if summary.report.eligible_for_scoring else 3


if __name__ == "__main__":
    raise SystemExit(main())
