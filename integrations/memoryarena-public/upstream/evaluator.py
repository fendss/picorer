from __future__ import annotations

import argparse
import csv
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Mapping, Sequence

from runtime.artifacts import (
    ArtifactStore,
    canonical_sha256,
    file_sha256,
    locked_manifest_document,
    read_json,
    validate_locked_manifest,
    write_json_atomic,
)
from runtime.integrity import require_clean_artifact_inventory, require_complete_run
from runtime.usage import PriceTable, UsageNormalizationError, load_price_table

from .contracts import (
    DEFAULT_LOCAL_ASSETS,
    EXPECTED_SUBTASK_TOTAL,
    EXPECTED_SUITE_COUNTS,
    EXPECTED_SUITE_SUBTASK_COUNTS,
    EXPECTED_TASK_TOTAL,
    OFFICIAL_CODE_REVISION,
    PUBLIC_DATA_REVISION,
    EvaluatorMaterializationError,
)
from .assets import tree_inventory, verify_local_asset_lock
from .manifest import validate_official_locked_task_manifest
from .judge_proxy import JudgeCacheProxy


_EXPECTED_ATTEMPT_CHANGES = {
    "bundled_shopping": {
        "agent.base_url",
        "memory.server_url",
        "output.output_dir",
    },
    "progressive_search": {
        "memory.memory_url",
        "output.output_dir",
        "task_specific.query_ids",
    },
    "group_travel_planner": {
        "agent.base_url",
        "memory.server_url",
        "output.global_csv",
        "output.log_dir",
        "output.output_dir",
    },
    "formal_reasoning_math": {
        "agent.base_url",
        "env.env_config.base_url",
        "memory.base_url",
        "output.json_output_dir",
    },
    "formal_reasoning_phys": {
        "agent.base_url",
        "env.env_config.base_url",
        "memory.base_url",
        "output.json_output_dir",
    },
}


def _accepted_attempt_dir(store: ArtifactStore, record: Mapping[str, Any]) -> Path:
    attempt_id = record.get("accepted_attempt_id")
    if not isinstance(attempt_id, str) or not attempt_id:
        raise EvaluatorMaterializationError("success record has no accepted_attempt_id")
    matches = list(store.attempts_dir.glob(f"*/{attempt_id}"))
    if len(matches) != 1:
        raise EvaluatorMaterializationError(
            f"cannot resolve accepted attempt directory: {attempt_id}"
        )
    return matches[0]


def _copy(source: Path, target: Path) -> dict[str, Any]:
    if not source.is_file() or source.is_symlink():
        raise EvaluatorMaterializationError(f"required accepted raw file is missing: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return {
        "path": target.as_posix(),
        "size": target.stat().st_size,
        "sha256": file_sha256(target),
    }


def _official_inventory(record: Mapping[str, Any], attempt_dir: Path) -> None:
    metadata = record.get("metadata")
    inventory = metadata.get("raw_output_inventory") if isinstance(metadata, Mapping) else None
    if not isinstance(inventory, list) or not inventory:
        raise EvaluatorMaterializationError("accepted record lacks raw official inventory")
    root = attempt_dir / "upstream" / "official"
    for item in inventory:
        if not isinstance(item, Mapping) or not isinstance(item.get("path"), str):
            raise EvaluatorMaterializationError("accepted raw inventory is malformed")
        path = (root / item["path"]).resolve()
        try:
            path.relative_to(root.resolve())
        except ValueError as error:
            raise EvaluatorMaterializationError("accepted inventory path escapes attempt") from error
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size != item.get("size")
            or file_sha256(path) != item.get("sha256")
        ):
            raise EvaluatorMaterializationError(f"accepted raw output drift: {path}")


def _validate_production_attempt(
    task: Any, record: Mapping[str, Any], attempt_dir: Path
) -> None:
    from .executor import PRODUCTION_SEAM_BUNDLE_SHA256

    metadata = record.get("metadata")
    if not isinstance(metadata, Mapping) or (
        metadata.get("official_code_revision") != OFFICIAL_CODE_REVISION
        or metadata.get("official_data_revision") != PUBLIC_DATA_REVISION
        or metadata.get("production_seam_bundle_sha256")
        != PRODUCTION_SEAM_BUNDLE_SHA256
    ):
        raise EvaluatorMaterializationError(
            f"accepted record was not produced by the current production seam: {task.task_key}"
        )
    expected_artifacts = {
        "worker_response_sha256": attempt_dir / "upstream/worker-response.json",
        "memory_audit_sha256": attempt_dir / "upstream/memory-audit.json",
        "picorer_wrap_audit_sha256": attempt_dir / "upstream/picorer-wrap-audits.jsonl",
    }
    for field, path in expected_artifacts.items():
        if not path.is_file() or metadata.get(field) != file_sha256(path):
            raise EvaluatorMaterializationError(
                f"accepted production artifact binding mismatch: {task.task_key}/{field}"
            )
    trajectory = metadata.get("raw_trajectory_inventory")
    trajectory_path = attempt_dir / "upstream/picorer-wrap-audits.jsonl"
    if (
        not isinstance(trajectory, Mapping)
        or trajectory.get("path") != "upstream/picorer-wrap-audits.jsonl"
        or trajectory.get("sha256") != file_sha256(trajectory_path)
        or trajectory.get("size") != trajectory_path.stat().st_size
        or not isinstance(trajectory.get("record_count"), int)
        or trajectory["record_count"] <= 0
        or trajectory["record_count"]
        != sum(
            bool(line.strip())
            for line in trajectory_path.read_text(encoding="utf-8").splitlines()
        )
    ):
        raise EvaluatorMaterializationError(
            f"accepted raw Picorer trajectory binding mismatch: {task.task_key}"
        )
    try:
        attempt = read_json(attempt_dir / "attempt.json")
        provenance = read_json(
            attempt_dir / "upstream/attempt-config.provenance.json"
        )
        config_path = attempt_dir / "upstream/attempt-config.json"
        source_path = Path(str(provenance["source"]))
        source_manifest_path = Path(str(provenance["source_manifest"]))
        source_provenance = read_json(source_manifest_path)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        raise EvaluatorMaterializationError(
            f"accepted attempt config provenance is unreadable: {task.task_key}: {error}"
        ) from error
    if (
        provenance.get("task_key") != task.task_key
        or provenance.get("memory_scope") != attempt.get("memory_scope")
        or provenance.get("attempt_sha256") != file_sha256(config_path)
        or not source_path.is_file()
        or provenance.get("source_sha256") != file_sha256(source_path)
        or not source_manifest_path.is_file()
        or provenance.get("source_manifest_sha256") != file_sha256(source_manifest_path)
        or set(provenance.get("changed_paths", ())) != _EXPECTED_ATTEMPT_CHANGES[task.domain]
        or set(metadata.get("attempt_config_changed_paths", ()))
        != _EXPECTED_ATTEMPT_CHANGES[task.domain]
        or source_provenance.get("suite") != task.domain
        or source_provenance.get("code_revision") != OFFICIAL_CODE_REVISION
        or source_provenance.get("data_revision") != PUBLIC_DATA_REVISION
        or source_provenance.get("official_config_unchanged") is not True
        or source_provenance.get("evaluator_policy") != "official_only"
        or source_provenance.get("effective_config_sha256") != file_sha256(source_path)
    ):
        raise EvaluatorMaterializationError(
            f"accepted attempt config provenance mismatch: {task.task_key}"
        )


def _one(paths: Sequence[Path], label: str) -> Path:
    if len(paths) != 1:
        raise EvaluatorMaterializationError(f"expected one {label}, found {len(paths)}")
    return paths[0]


def _materialize_shopping(
    task: Any,
    record: Mapping[str, Any],
    attempt: Path,
    target: Path,
    published_root: Path,
) -> list[dict[str, Any]]:
    official = attempt / "upstream" / "official"
    source_result = _one(list(official.rglob("step_results/*.json")), "shopping result")
    source_task = attempt / "upstream" / "official-task.json"
    task_value = read_json(source_task)
    if task_value.get("metadata", {}).get("hf_id") != task.metadata["record_id"]:
        raise EvaluatorMaterializationError("shopping task asset differs from TaskSpec")
    local_task = target / "shopping" / "tasks" / f"{task.task_key.rsplit('/', 1)[-1]}.json"
    copied = [_copy(source_task, local_task)]
    result_value = read_json(source_result)
    result_value["source_file"] = os.fspath(
        (published_root / local_task.relative_to(target)).resolve()
    )
    local_result = target / "shopping" / "run" / "step_results" / (
        task.task_key.replace("/", "-") + ".json"
    )
    write_json_atomic(local_result, result_value)
    copied.append(
        {
            "path": local_result.as_posix(),
            "size": local_result.stat().st_size,
            "sha256": file_sha256(local_result),
        }
    )
    return copied


def _materialize_search(
    task: Any, record: Mapping[str, Any], attempt: Path, target: Path
) -> list[dict[str, Any]]:
    query_id = str(task.metadata["official_query_id"])
    final_dir = (
        attempt
        / "upstream"
        / "official"
        / f"query_{query_id}"
        / "final_query"
    )
    source = _one(list(final_dir.glob("*.json")), "search final raw provider file")
    destination = target / "progressive_search" / "input" / f"query_{query_id}.json"
    return [_copy(source, destination)]


def _materialize_travel(
    task: Any, record: Mapping[str, Any], attempt: Path, target: Path
) -> list[dict[str, Any]]:
    record_id = int(task.metadata["record_id"])
    source = (
        attempt / "upstream" / "official" / f"generated_plan_{record_id}.json"
    )
    destination = (
        target
        / "group_travel_planner"
        / "generated"
        / f"generated_plan_{record_id}.json"
    )
    return [_copy(source, destination)]


def _materialize_formal(
    task: Any, record: Mapping[str, Any], attempt: Path, target: Path
) -> list[dict[str, Any]]:
    paper = str(task.metadata["paper_name"])
    candidates = list(
        (attempt / "upstream" / "official").glob(f"picorer/{paper}/result.jsonl")
    )
    source = _one(candidates, "formal result.jsonl")
    lines = [line for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(lines) != len(task.subtask_ids):
        raise EvaluatorMaterializationError(f"formal evaluator input incomplete: {task.task_key}")
    destination = target / task.domain / "picorer" / paper / "result.jsonl"
    return [_copy(source, destination)]


def materialize_official_evaluator_inputs(
    run_dir: Path,
    output_dir: Path,
    *,
    checkout: Path,
    asset_lock: Path,
    search_ground_truth: Path,
    search_qrels: Path,
    shopping_product_catalog: Path,
    shopping_domain_data: Path,
) -> dict[str, Any]:
    """Gate all 701 accepted records, then arrange only official evaluator inputs."""

    from .executor import PRODUCTION_SEAM_BUNDLE_SHA256

    run_root = run_dir.resolve()
    output = output_dir.resolve()
    if output.exists():
        raise EvaluatorMaterializationError(f"evaluator output already exists: {output}")
    try:
        run_manifest = read_json(run_root / "run-manifest.json")
        task_manifest = read_json(run_root / "task-manifest.json")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise EvaluatorMaterializationError(f"cannot read runtime manifests: {error}") from error
    tasks = validate_official_locked_task_manifest(task_manifest)
    if len(tasks) != EXPECTED_TASK_TOTAL or sum(len(task.subtask_ids) for task in tasks) != EXPECTED_SUBTASK_TOTAL:
        raise EvaluatorMaterializationError("official evaluator gate is not 701/4,850")
    try:
        asset_document = verify_local_asset_lock(
            asset_lock.resolve(),
            checkout=checkout.resolve(),
            expected_manifest_sha256=str(task_manifest["local_asset_manifest_sha256"]),
        )
    except Exception as error:
        raise EvaluatorMaterializationError(
            f"official evaluator assets do not match the accepted release: {error}"
        ) from error
    locked_assets = asset_document["assets"]
    expected_ground_truth = (
        checkout.resolve() / str(locked_assets["search_ground_truth"]["path"])
    ).resolve()
    shopping_root = (
        checkout.resolve() / str(locked_assets["shopping_product_db"]["path"])
    ).resolve()
    locked_qrels = locked_assets.get("search_qrels")
    if not isinstance(locked_qrels, Mapping):
        raise EvaluatorMaterializationError(
            "verified evaluator asset lock has no pinned search qrels"
        )
    expected_qrels = (
        checkout.resolve() / str(locked_qrels.get("path", ""))
    ).resolve()
    if (
        search_ground_truth.resolve() != expected_ground_truth
        or search_qrels.resolve() != expected_qrels
        or shopping_product_catalog.resolve() != shopping_root / "product_catalog"
        or shopping_domain_data.resolve() != shopping_root / "domain_data.json"
    ):
        raise EvaluatorMaterializationError(
            "evaluator assets must resolve to the exact asset-lock paths"
        )
    try:
        catalog_inventory, catalog_tree_sha256 = tree_inventory(
            shopping_product_catalog.resolve()
        )
    except Exception as error:
        raise EvaluatorMaterializationError(
            f"shopping product catalog cannot be proven: {error}"
        ) from error
    if not shopping_domain_data.is_file() or not search_ground_truth.is_file():
        raise EvaluatorMaterializationError("required evaluator reference asset is missing")
    if search_qrels.is_symlink() or not search_qrels.is_file():
        raise EvaluatorMaterializationError("pinned search qrel asset is missing")
    qrel_descriptor: dict[str, Any] = {
        "path": os.fspath(expected_qrels),
        "locked_path": str(locked_qrels["path"]),
        "kind": locked_qrels["kind"],
        "revision": locked_qrels["revision"],
        "size": locked_qrels["size"],
        "sha256": locked_qrels["sha256"],
        "source_repo": locked_qrels["source_repo"],
        "source_path": locked_qrels["source_path"],
        "source_revision": locked_qrels["source_revision"],
        "git_oid": locked_qrels["git_oid"],
        "coverage": locked_qrels["coverage"],
    }
    run_id = run_manifest.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise EvaluatorMaterializationError("run manifest lacks run_id")
    store = ArtifactStore(run_root, run_id)
    try:
        store.load_manifests()
        require_clean_artifact_inventory(store, task_manifest)
        report = require_complete_run(store, task_manifest)
    except Exception as error:
        raise EvaluatorMaterializationError(f"run is not complete and clean: {error}") from error
    if len(report.succeeded) != EXPECTED_TASK_TOTAL:
        raise EvaluatorMaterializationError("evaluator inputs require all 701 accepted records")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    )
    copied: list[dict[str, Any]] = []
    record_hashes: dict[str, str] = {}
    suite_counts: dict[str, int] = {suite: 0 for suite in EXPECTED_SUITE_COUNTS}
    try:
        for task in tasks:
            record = store.load_success(task.task_key)
            if record is None:
                raise EvaluatorMaterializationError(f"accepted record missing: {task.task_key}")
            if (
                record.get("source_record_hash") != task.source_record_hash
                or tuple(record.get("completed_subtask_ids", ())) != task.subtask_ids
            ):
                raise EvaluatorMaterializationError(
                    f"accepted record provenance mismatch: {task.task_key}"
                )
            attempt = _accepted_attempt_dir(store, record)
            _validate_production_attempt(task, record, attempt)
            _official_inventory(record, attempt)
            if task.domain == "bundled_shopping":
                files = _materialize_shopping(
                    task, record, attempt, staging, output
                )
            elif task.domain == "progressive_search":
                files = _materialize_search(task, record, attempt, staging)
            elif task.domain == "group_travel_planner":
                files = _materialize_travel(task, record, attempt, staging)
            else:
                files = _materialize_formal(task, record, attempt, staging)
            copied.extend(files)
            record_hashes[task.task_key] = str(record["record_sha256"])
            suite_counts[task.domain] += 1
        if suite_counts != dict(EXPECTED_SUITE_COUNTS):
            raise EvaluatorMaterializationError("evaluator suite counts differ from release")

        evaluator_plan = locked_manifest_document(
            {
                "schema_version": 1,
                "kind": "memoryarena-public-official-evaluator-inputs",
                "run_id": run_id,
                "code_revision": OFFICIAL_CODE_REVISION,
                "data_revision": PUBLIC_DATA_REVISION,
                "production_seam_bundle_sha256": PRODUCTION_SEAM_BUNDLE_SHA256,
                "task_manifest_sha256": task_manifest["manifest_sha256"],
                "task_count": EXPECTED_TASK_TOTAL,
                "subtask_count": EXPECTED_SUBTASK_TOTAL,
                "suite_counts": suite_counts,
                "accepted_record_hashes": record_hashes,
                "files": [
                    {
                        **entry,
                        "path": Path(str(entry["path"]))
                        .relative_to(staging)
                        .as_posix(),
                    }
                    for entry in copied
                ],
                "evaluator_asset_provenance": {
                    "local_asset_manifest_sha256": asset_document["manifest_sha256"],
                    "asset_lock_sha256": file_sha256(asset_lock.resolve()),
                    "shopping_product_catalog": {
                        "path": os.fspath(shopping_product_catalog.resolve()),
                        "file_count": len(catalog_inventory),
                        "tree_sha256": catalog_tree_sha256,
                    },
                    "shopping_domain_data": {
                        "path": os.fspath(shopping_domain_data.resolve()),
                        "size": shopping_domain_data.stat().st_size,
                        "sha256": file_sha256(shopping_domain_data),
                    },
                    "search_ground_truth": {
                        "path": os.fspath(search_ground_truth.resolve()),
                        "size": search_ground_truth.stat().st_size,
                        "sha256": file_sha256(search_ground_truth),
                    },
                    "search_qrels": qrel_descriptor,
                },
                "official_evaluators": {
                    "bundled_shopping": {
                        "script": os.fspath(
                            checkout
                            / "env/env_systems/web_shopping_env/compute_reward.py"
                        ),
                        "input": "shopping/run",
                        "product_catalog": os.fspath(shopping_product_catalog),
                        "domain_data": os.fspath(shopping_domain_data),
                    },
                    "progressive_search": {
                        "script": os.fspath(
                            checkout
                            / "env/env_systems/web_search_env/evaluate_with_openai.py"
                        ),
                        "input": "progressive_search/input",
                        "ground_truth": os.fspath(search_ground_truth),
                        "qrel_evidence": os.fspath(expected_qrels),
                    },
                    "group_travel_planner": {
                        "combiner": os.fspath(
                            checkout
                            / "env/env_systems/travel_planner_env/combination.py"
                        ),
                        "evaluator": os.fspath(
                            checkout / "env/env_systems/travel_planner_env/eval.py"
                        ),
                        "input": "group_travel_planner/generated",
                    },
                    "formal_reasoning_math": {
                        "evaluator": os.fspath(
                            checkout / "env/env_systems/formal_reasoning_env/eval.py"
                        ),
                        "input": "formal_reasoning_math",
                    },
                    "formal_reasoning_phys": {
                        "evaluator": os.fspath(
                            checkout / "env/env_systems/formal_reasoning_env/eval.py"
                        ),
                        "input": "formal_reasoning_phys",
                    },
                },
                "scoring_performed": False,
            }
        )
        write_json_atomic(staging / "evaluator-plan.json", evaluator_plan)
        staging.rename(output)
        return evaluator_plan
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _run_stage(
    name: str,
    command: Sequence[str],
    *,
    checkout: Path,
    environment: Mapping[str, str],
    log_dir: Path,
) -> dict[str, Any]:
    stdout_path = log_dir / f"{name}.stdout.log"
    stderr_path = log_dir / f"{name}.stderr.log"
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        process = subprocess.run(
            list(command),
            cwd=checkout,
            env=dict(environment),
            stdout=stdout,
            stderr=stderr,
            check=False,
        )
    result = {
        "stage": name,
        "command_sha256": canonical_sha256(list(command)),
        "return_code": process.returncode,
        "stdout_sha256": file_sha256(stdout_path),
        "stderr_sha256": file_sha256(stderr_path),
    }
    if process.returncode != 0:
        detail = stderr_path.read_text(encoding="utf-8", errors="replace")[-2000:]
        raise EvaluatorMaterializationError(
            f"pinned official evaluator stage {name} failed ({process.returncode}): {detail}"
        )
    return result


def _travel_model(generated_dir: Path) -> str:
    models: set[str] = set()
    total_persons = 0
    files_by_id: dict[int, Path] = {}
    for path in generated_dir.glob("generated_plan_*.json"):
        try:
            group_id = int(path.stem.removeprefix("generated_plan_"))
        except ValueError as error:
            raise EvaluatorMaterializationError(
                f"travel evaluator input has an invalid group filename: {path}"
            ) from error
        if group_id in files_by_id:
            raise EvaluatorMaterializationError(
                f"travel evaluator input repeats group {group_id}"
            )
        files_by_id[group_id] = path
    expected_group_ids = list(
        range(1, EXPECTED_SUITE_COUNTS["group_travel_planner"] + 1)
    )
    if sorted(files_by_id) != expected_group_ids:
        raise EvaluatorMaterializationError("travel evaluator input is not 270 groups")
    for group_id in expected_group_ids:
        path = files_by_id[group_id]
        value = read_json(path)
        keys = [
            key.removesuffix("_sole-planning_results")
            for key in value
            if isinstance(key, str) and key.endswith("_sole-planning_results")
        ]
        if len(keys) != 1:
            raise EvaluatorMaterializationError(
                f"travel raw output has no unique official model key: {path}"
            )
        models.add(keys[0])
        persons = value.get(f"{keys[0]}_sole-planning_results")
        if not isinstance(persons, list) or not persons:
            raise EvaluatorMaterializationError(
                f"travel raw output has no complete person results: {path}"
            )
        total_persons += len(persons)
    if len(models) != 1:
        raise EvaluatorMaterializationError("travel outputs mix agent model identities")
    if total_persons != EXPECTED_SUITE_SUBTASK_COUNTS["group_travel_planner"]:
        raise EvaluatorMaterializationError("travel evaluator input is not 1,869 persons")
    return next(iter(models))


def _validate_travel_submission(path: Path) -> None:
    if path.is_symlink() or not path.is_file():
        raise EvaluatorMaterializationError("travel official submission is missing")
    try:
        rows = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except (OSError, json.JSONDecodeError) as error:
        raise EvaluatorMaterializationError(
            f"travel official submission is unreadable: {error}"
        ) from error
    expected_group_ids = list(
        range(1, EXPECTED_SUITE_COUNTS["group_travel_planner"] + 1)
    )
    group_ids = [
        row.get("id") if isinstance(row, Mapping) else None for row in rows
    ]
    if any(type(group_id) is not int for group_id in group_ids) or (
        group_ids != expected_group_ids
    ):
        raise EvaluatorMaterializationError(
            "travel official submission group IDs are not exactly 1..270"
        )
    total_persons = 0
    for row in rows:
        persons = row.get("persons")
        if not isinstance(persons, list) or not persons:
            raise EvaluatorMaterializationError(
                f"travel official submission has no persons for group {row['id']}"
            )
        person_ids = [
            person.get("person_idx") if isinstance(person, Mapping) else None
            for person in persons
        ]
        if any(type(person_id) is not int for person_id in person_ids) or (
            person_ids != list(range(1, len(persons) + 1))
        ):
            raise EvaluatorMaterializationError(
                f"travel official submission person IDs are incomplete for group {row['id']}"
            )
        total_persons += len(persons)
    if total_persons != EXPECTED_SUITE_SUBTASK_COUNTS["group_travel_planner"]:
        raise EvaluatorMaterializationError(
            "travel official submission is not 1,869 unique persons"
        )


def _validate_formal_evaluator_input(
    work_root: Path, suite: str, task_manifest: Mapping[str, Any]
) -> tuple[int, int]:
    expected_papers = {
        str(entry["metadata"]["paper_name"]): len(entry["subtask_ids"])
        for entry in task_manifest.get("tasks", [])
        if isinstance(entry, Mapping) and entry.get("domain") == suite
    }
    picorer_root = work_root / "picorer"
    actual_papers = {
        path.name for path in picorer_root.iterdir() if path.is_dir() and not path.is_symlink()
    } if picorer_root.is_dir() else set()
    if (
        len(expected_papers) != EXPECTED_SUITE_COUNTS[suite]
        or sum(expected_papers.values()) != EXPECTED_SUITE_SUBTASK_COUNTS[suite]
        or actual_papers != set(expected_papers)
    ):
        raise EvaluatorMaterializationError(f"formal evaluator input coverage mismatch: {suite}")
    observed = 0
    for paper, expected_count in expected_papers.items():
        path = picorer_root / paper / "result.jsonl"
        if path.is_symlink() or not path.is_file():
            raise EvaluatorMaterializationError(f"formal evaluator input missing: {suite}/{paper}")
        try:
            rows = [
                json.loads(line)
                for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
        except (OSError, json.JSONDecodeError) as error:
            raise EvaluatorMaterializationError(
                f"formal evaluator input is unreadable: {suite}/{paper}: {error}"
            ) from error
        if (
            len(rows) != expected_count
            or any(
                not isinstance(row, Mapping)
                or not isinstance(row.get("is_correct"), bool)
                for row in rows
            )
            or any(type(row.get("query_id")) is not int for row in rows)
            or [row.get("query_id") for row in rows]
            != list(range(expected_count))
        ):
            raise EvaluatorMaterializationError(
                f"formal evaluator input rows are incomplete: {suite}/{paper}"
            )
        observed += len(rows)
    if observed != EXPECTED_SUITE_SUBTASK_COUNTS[suite]:
        raise EvaluatorMaterializationError(f"formal evaluator subtask coverage mismatch: {suite}")
    return min(expected_papers.values()), max(expected_papers.values())


def _validate_formal_evaluator_output(
    path: Path,
    suite: str,
    *,
    expected_min_k: int,
    expected_max_k: int,
) -> None:
    if path.is_symlink() or not path.is_file():
        raise EvaluatorMaterializationError(f"formal official evaluator output missing: {suite}")
    try:
        value = read_json(path)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise EvaluatorMaterializationError(
            f"formal official evaluator output is unreadable: {suite}: {error}"
        ) from error
    required = {
        "overall_average_passrate",
        "avg_progress_score",
        "average_session_time",
        "average_memory_length",
        "average_task_time",
        "memory_length",
        "min_k",
        "passrate_at_k",
        "cummulative_passrate_at_k",
        "passrate_at_min_k",
        "cummulative_passrate_at_min_k",
    }
    if (
        set(value) != required
        or isinstance(value.get("min_k"), bool)
        or value.get("min_k") != expected_min_k
    ):
        raise EvaluatorMaterializationError(
            f"formal official evaluator output schema is incomplete: {suite}"
        )
    for key in required - {"min_k", "passrate_at_k", "cummulative_passrate_at_k", "passrate_at_min_k", "cummulative_passrate_at_min_k"}:
        metric = value.get(key)
        if (
            isinstance(metric, bool)
            or not isinstance(metric, (int, float))
            or not math.isfinite(metric)
        ):
            raise EvaluatorMaterializationError(
                f"formal official evaluator metric is invalid: {suite}/{key}"
            )
    expected_lengths = {
        "passrate_at_k": expected_max_k,
        "cummulative_passrate_at_k": expected_max_k,
        "passrate_at_min_k": expected_min_k,
        "cummulative_passrate_at_min_k": expected_min_k,
    }
    for key, expected_length in expected_lengths.items():
        series = value.get(key)
        if (
            not isinstance(series, list)
            or len(series) != expected_length
            or any(
                isinstance(item, bool)
                or not isinstance(item, (int, float))
                or not math.isfinite(item)
                for item in series
            )
        ):
            raise EvaluatorMaterializationError(
                f"formal official evaluator series coverage is invalid: {suite}/{key}"
            )


def _json_inventory(root: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise EvaluatorMaterializationError(f"evaluator output contains symlink: {path}")
        if path.is_file():
            entries.append({
                "path": path.relative_to(root).as_posix(),
                "size": path.stat().st_size,
                "sha256": file_sha256(path),
            })
    return entries


def _validate_evaluator_asset_provenance(
    plan: Mapping[str, Any], *, checkout: Path
) -> None:
    provenance = plan.get("evaluator_asset_provenance")
    if not isinstance(provenance, Mapping):
        raise EvaluatorMaterializationError("evaluator plan lacks asset provenance")
    catalog = provenance.get("shopping_product_catalog")
    if not isinstance(catalog, Mapping):
        raise EvaluatorMaterializationError("shopping evaluator asset proof is missing")
    catalog_path = Path(str(catalog.get("path", "")))
    try:
        inventory, tree_sha256 = tree_inventory(catalog_path)
    except Exception as error:
        raise EvaluatorMaterializationError(
            f"shopping product catalog is unavailable: {error}"
        ) from error
    if (
        len(inventory) != catalog.get("file_count")
        or tree_sha256 != catalog.get("tree_sha256")
    ):
        raise EvaluatorMaterializationError("shopping product catalog drifted after materialization")
    for name in ("shopping_domain_data", "search_ground_truth"):
        descriptor = provenance.get(name)
        if not isinstance(descriptor, Mapping):
            raise EvaluatorMaterializationError(f"evaluator asset proof is missing: {name}")
        path = Path(str(descriptor.get("path", "")))
        if (
            not path.is_file()
            or path.stat().st_size != descriptor.get("size")
            or file_sha256(path) != descriptor.get("sha256")
        ):
            raise EvaluatorMaterializationError(f"evaluator asset drifted: {name}")
    qrels = provenance.get("search_qrels")
    if not isinstance(qrels, Mapping):
        raise EvaluatorMaterializationError("search qrel provenance is missing")
    expected_qrels = DEFAULT_LOCAL_ASSETS["search_qrels"]
    expected_path = (checkout.resolve() / str(expected_qrels["path"])).resolve()
    qrel_path = Path(str(qrels.get("path", "")))
    locked_fields = (
        "kind",
        "revision",
        "source_repo",
        "source_path",
        "source_revision",
        "sha256",
        "git_oid",
    )
    if (
        qrels.get("locked_path") != expected_qrels["path"]
        or qrel_path.resolve() != expected_path
        or any(qrels.get(field) != expected_qrels[field] for field in locked_fields)
        or qrel_path.is_symlink()
        or not qrel_path.is_file()
        or qrel_path.stat().st_size != qrels.get("size")
        or file_sha256(qrel_path) != qrels.get("sha256")
        or not isinstance(qrels.get("coverage"), Mapping)
    ):
        raise EvaluatorMaterializationError(
            "search qrel asset is not the pinned BrowseComp-Plus Git blob"
        )


def _validate_materialized_input_files(
    plan: Mapping[str, Any], input_root: Path
) -> None:
    descriptors = plan.get("files")
    if not isinstance(descriptors, list) or not descriptors:
        raise EvaluatorMaterializationError("evaluator plan has no materialized files")
    root = input_root.resolve()
    expected_paths: set[str] = set()
    for descriptor in descriptors:
        if not isinstance(descriptor, Mapping) or not isinstance(
            descriptor.get("path"), str
        ):
            raise EvaluatorMaterializationError("evaluator input descriptor is malformed")
        path = (root / str(descriptor["path"])).resolve()
        try:
            path.relative_to(root)
        except ValueError as error:
            raise EvaluatorMaterializationError(
                "evaluator input descriptor escapes materialized root"
            ) from error
        relative = path.relative_to(root).as_posix()
        if relative in expected_paths or relative != descriptor["path"]:
            raise EvaluatorMaterializationError(
                "evaluator input descriptor paths are duplicate or non-canonical"
            )
        expected_paths.add(relative)
        if (
            not path.is_file()
            or path.stat().st_size != descriptor.get("size")
            or file_sha256(path) != descriptor.get("sha256")
        ):
            raise EvaluatorMaterializationError(f"materialized evaluator input drift: {path}")
    actual_paths: set[str] = set()
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise EvaluatorMaterializationError(
                f"materialized evaluator input contains symlink: {relative}"
            )
        if path.is_file() and relative != "evaluator-plan.json":
            actual_paths.add(relative)
    if actual_paths != expected_paths:
        raise EvaluatorMaterializationError(
            "materialized evaluator input inventory differs from the locked plan"
        )


def _verify_input_subset(source: Path, destination: Path, label: str) -> None:
    for path in source.rglob("*"):
        relative = path.relative_to(source)
        if path.is_symlink():
            raise EvaluatorMaterializationError(
                f"{label} materialized input contains symlink: {relative}"
            )
        if not path.is_file():
            continue
        target = destination / relative
        if (
            target.is_symlink()
            or not target.is_file()
            or target.stat().st_size != path.stat().st_size
            or file_sha256(target) != file_sha256(path)
        ):
            raise EvaluatorMaterializationError(
                f"{label} resume work differs from materialized input: {relative}"
            )


def _reset_wrapper_owned_file(
    path: Path, output_root: Path, *, label: str
) -> None:
    """Atomically remove one wrapper-owned output before an official stage."""

    if output_root.is_symlink():
        raise EvaluatorMaterializationError(
            f"refusing to use a symlinked wrapper-owned {label} directory"
        )
    output_root.mkdir(parents=True, exist_ok=True)
    if not output_root.is_dir():
        raise EvaluatorMaterializationError(
            f"wrapper-owned {label} path is not a directory"
        )
    root = output_root.resolve()
    target = path.resolve()
    try:
        target.relative_to(root)
    except ValueError as error:
        raise EvaluatorMaterializationError(
            f"refusing to reset {label} outside wrapper-owned output"
        ) from error
    # Check the lexical path as well: resolve() follows a symlink and could make
    # an attacker-controlled output point at another regular file.
    if path.is_symlink():
        raise EvaluatorMaterializationError(
            f"refusing to reset symlinked wrapper-owned {label}"
        )
    if path.exists():
        if not path.is_file():
            raise EvaluatorMaterializationError(
                f"wrapper-owned {label} path is not a regular file"
            )
        # POSIX unlink is an atomic namespace operation. The official evaluator
        # then creates a fresh file instead of appending a second resume row.
        path.unlink()


def _reset_wrapper_owned_csv(path: Path, output_root: Path) -> None:
    """Start each travel evaluation with one fresh append-only CSV."""

    _reset_wrapper_owned_file(path, output_root, label="travel CSV")


def _validate_travel_csv(path: Path, model: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise EvaluatorMaterializationError("travel official evaluator CSV is missing")
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
    except (OSError, csv.Error) as error:
        raise EvaluatorMaterializationError(
            f"travel official evaluator CSV is unreadable: {error}"
        ) from error
    try:
        metrics = [float(rows[0][name]) for name in ("PS", "SPS", "SR")]
    except (IndexError, KeyError, TypeError, ValueError):
        metrics = []
    if (
        len(rows) != 1
        or rows[0].get("model_name") != model
        or rows[0].get("memory_system") != "picorer"
        or rows[0].get("total_groups") != "270"
        or len(metrics) != 3
        or any(not math.isfinite(metric) or not 0 <= metric <= 100 for metric in metrics)
    ):
        raise EvaluatorMaterializationError(
            "travel official evaluator CSV is not one complete 270-group result"
        )


def _judge_usage_coverage(
    events: Sequence[Mapping[str, Any]],
) -> tuple[list[str], int, int, str]:
    provider_events = [
        event
        for event in events
        if event.get("billed_this_request") is not False
        or event.get("cache") == "error"
    ]
    observed_provider_cache_keys = {
        str(event["cache_key"])
        for event in provider_events
        if event.get("cache_key")
    }
    cache_origin_gaps = sorted({
        f"cache-origin-{event['cache_key']}"
        for event in events
        if event.get("cache") == "hit"
        and event.get("cache_key")
        and str(event["cache_key"]) not in observed_provider_cache_keys
    })
    gaps = [
        str(
            event.get("cache_key")
            or event.get("request_sha256")
            or f"audit-sequence-{event.get('sequence')}"
        )
        for event in provider_events
        if event.get("usage_normalized") is not True
    ] + cache_origin_gaps
    normalized_count = sum(
        event.get("usage_normalized") is True for event in provider_events
    )
    status = (
        "complete"
        if not gaps
        else (
            "unknown"
            if normalized_count == 0 and (provider_events or gaps)
            else "partial"
        )
    )
    return gaps, len(provider_events), normalized_count, status


def _shopping_attribution_markers(
    shopping_work: Path, product_catalog: Path
) -> list[tuple[str, str]]:
    names: dict[str, str] = {}
    for path in sorted(product_catalog.glob("*.json")):
        try:
            rows = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            asin = row.get("asin")
            name = row.get("name")
            if asin and name:
                names.setdefault(str(asin).strip().upper(), str(name))
    markers: list[tuple[str, str]] = []
    for result_path in sorted((shopping_work / "step_results").glob("*.json")):
        result = read_json(result_path)
        source_path = Path(str(result.get("source_file", "")))
        source = read_json(source_path)
        record_id = source.get("metadata", {}).get("hf_id")
        if not isinstance(record_id, int):
            raise EvaluatorMaterializationError(
                f"shopping attribution source lacks pinned hf id: {source_path}"
            )
        task_key = f"bundled_shopping/{record_id:03d}"
        ground = {
            item.get("step"): item
            for item in source.get("steps", [])
            if isinstance(item, Mapping)
        }
        for step in result.get("steps", []):
            if not isinstance(step, Mapping):
                continue
            gt = ground.get(step.get("step"), {})
            requirements = gt.get("requirements", {}) if isinstance(gt, Mapping) else {}
            attributes = requirements.get("attributes", []) if isinstance(requirements, Mapping) else []
            purchased_name = step.get("purchased_name")
            if not purchased_name and step.get("purchased_asin"):
                purchased_name = names.get(str(step["purchased_asin"]).strip().upper())
            if not attributes or not purchased_name:
                continue
            prompt = (
                "Product name:\n"
                f"{purchased_name}\n\nAttributes:\n"
                + "\n".join(f"- {attribute}" for attribute in attributes)
                + '\n\nReturn JSON: {"matches":[{"attribute":"...","has_attribute":true/false}]}'
            )
            markers.append((prompt, task_key))
    return markers


def _search_attribution_markers(
    ground_truth: Path, task_manifest: Mapping[str, Any]
) -> list[tuple[str, str]]:
    by_id = {
        str(entry["metadata"]["official_query_id"]): str(entry["task_key"])
        for entry in task_manifest["tasks"]
        if entry.get("domain") == "progressive_search"
    }
    markers: list[tuple[str, str]] = []
    with ground_truth.open("r", encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            query_id = str(row.get("query_id"))
            query = row.get("query")
            if query_id in by_id and isinstance(query, str) and query:
                markers.append((f"[question]: {query}\n", by_id[query_id]))
    if len(markers) != EXPECTED_SUITE_COUNTS["progressive_search"]:
        raise EvaluatorMaterializationError("cannot attribute all 221 official search judge prompts")
    return markers


def run_official_evaluators(
    run_dir: Path,
    evaluator_input_dir: Path,
    output_dir: Path,
    *,
    checkout: Path,
    python: str = sys.executable,
    price_table: PriceTable | None = None,
) -> dict[str, Any]:
    """Invoke all five pinned official evaluators after the 701-result gate."""

    from .executor import PRODUCTION_SEAM_BUNDLE_SHA256, _verify_checkout

    run_root = run_dir.resolve()
    input_root = evaluator_input_dir.resolve()
    output = output_dir.resolve()
    try:
        plan = validate_locked_manifest(read_json(input_root / "evaluator-plan.json"))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise EvaluatorMaterializationError(f"invalid evaluator input plan: {error}") from error
    if (
        plan.get("kind") != "memoryarena-public-official-evaluator-inputs"
        or plan.get("code_revision") != OFFICIAL_CODE_REVISION
        or plan.get("data_revision") != PUBLIC_DATA_REVISION
        or plan.get("production_seam_bundle_sha256")
        != PRODUCTION_SEAM_BUNDLE_SHA256
        or plan.get("task_count") != EXPECTED_TASK_TOTAL
        or plan.get("subtask_count") != EXPECTED_SUBTASK_TOTAL
        or plan.get("suite_counts") != dict(EXPECTED_SUITE_COUNTS)
        or plan.get("scoring_performed") is not False
    ):
        raise EvaluatorMaterializationError("evaluator plan is not the complete public release")
    _validate_materialized_input_files(plan, input_root)
    _validate_evaluator_asset_provenance(plan, checkout=checkout.resolve())
    _verify_checkout(checkout.resolve())
    run_manifest = read_json(run_root / "run-manifest.json")
    if plan.get("run_id") != run_manifest.get("run_id"):
        raise EvaluatorMaterializationError("evaluator plan belongs to another run")
    price_hash = run_manifest.get("runtime_execution", {}).get("price_table_sha256")
    if price_hash != (price_table.sha256 if price_table is not None else None):
        raise EvaluatorMaterializationError(
            "evaluator price table must exactly match the SHA-bound run price table"
        )
    store = ArtifactStore(run_root, str(plan["run_id"]), price_table=price_table)
    store.load_manifests()
    output.mkdir(parents=True, exist_ok=True)
    logs = output / "logs"
    stages: list[dict[str, Any]] = []
    environment = os.environ.copy()
    api_key = environment.get("OPENAI_API_KEY")
    if not api_key:
        raise EvaluatorMaterializationError(
            "OPENAI_API_KEY is required by the pinned shopping/search evaluators"
        )
    infrastructure = run_manifest.get("infrastructure")
    locked_provider_base = (
        infrastructure.get("provider_proxy_url")
        if isinstance(infrastructure, Mapping)
        else None
    )
    upstream_base = environment.get("OPENAI_BASE_URL")
    api_base_alias = environment.get("OPENAI_API_BASE")
    if (
        not isinstance(locked_provider_base, str)
        or not locked_provider_base
        or not upstream_base
        or upstream_base.rstrip("/") != locked_provider_base.rstrip("/")
        or (
            api_base_alias is not None
            and api_base_alias.rstrip("/") != locked_provider_base.rstrip("/")
        )
    ):
        raise EvaluatorMaterializationError(
            "OPENAI_BASE_URL must equal the provider proxy locked in the run manifest"
        )
    task_manifest = read_json(run_root / "task-manifest.json")
    shopping_plan = plan["official_evaluators"]["bundled_shopping"]
    shopping_work = output / "bundled_shopping" / "run"
    if not shopping_work.exists():
        shopping_work.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(input_root / "shopping/run", shopping_work)
    else:
        _verify_input_subset(
            input_root / "shopping/run", shopping_work, "shopping evaluator"
        )
    attribution_markers = {
        "/v1/chat/completions": _shopping_attribution_markers(
            shopping_work, Path(str(shopping_plan["product_catalog"]))
        ),
        "/v1/responses": _search_attribution_markers(
            Path(str(plan["official_evaluators"]["progressive_search"]["ground_truth"])),
            task_manifest,
        ),
    }
    audit_dir = output / "evaluation-attempts"
    audit_path = audit_dir / f"judge-proxy-{uuid.uuid4().hex}.json"
    proxy = JudgeCacheProxy(
        upstream_base_url=upstream_base,
        api_key=api_key,
        store=store,
        adapter_version=PRODUCTION_SEAM_BUNDLE_SHA256,
        audit_path=audit_path,
        attribution_markers=attribution_markers,
        price_table=price_table,
    )
    proxy.start()
    try:
        judge_environment = dict(environment)
        judge_environment["OPENAI_BASE_URL"] = proxy.url
        judge_environment["OPENAI_API_BASE"] = proxy.url
        judge_environment["OPENAI_API_KEY"] = api_key
        judge_environment["WEBSHOP_CATALOG_CACHE_DIR"] = str(
            output / ".shopping-catalog-cache"
        )

        shopping = shopping_plan
        stages.append(_run_stage(
            "bundled-shopping",
            [
                python,
                str(shopping["script"]),
                "--run-dir", str(shopping_work),
                "--product-catalog-dir", str(shopping["product_catalog"]),
                "--domain-data", str(shopping["domain_data"]),
                "--force",
            ],
            checkout=checkout,
            environment=judge_environment,
            log_dir=logs,
        ))

        search = plan["official_evaluators"]["progressive_search"]
        search_output = output / "progressive_search"
        stages.append(_run_stage(
            "progressive-search",
            [
                python,
                str(search["script"]),
                "--input_dir", str(input_root / str(search["input"])),
                "--ground_truth", str(search["ground_truth"]),
                "--eval_dir", str(search_output),
                "--qrel_evidence", str(search["qrel_evidence"]),
                "--force",
            ],
            checkout=checkout,
            environment=judge_environment,
            log_dir=logs,
        ))
    finally:
        proxy.close()

    bad_judge_events = [
        event for event in proxy.events
        if event.get("cache") == "error"
        or int(event.get("status_code", 500)) >= 400
    ]
    if bad_judge_events:
        raise EvaluatorMaterializationError(
            "official evaluator swallowed or received an invalid judge response; rerun is safe via cache"
        )
    if not proxy.events:
        raise EvaluatorMaterializationError("official LLM evaluators made no attributable judge calls")

    all_judge_events: list[Mapping[str, Any]] = []
    for path in sorted(audit_dir.glob("judge-proxy-*.json")):
        value = read_json(path)
        events = value.get("events")
        if not isinstance(events, list) or any(not isinstance(event, Mapping) for event in events):
            raise EvaluatorMaterializationError(f"judge proxy audit is corrupt: {path}")
        all_judge_events.extend(events)

    reward = shopping_work / "reward_report.json"
    judgement_log = shopping_work / "llm_attribute_judgments.json"
    if not reward.is_file() or not judgement_log.is_file():
        raise EvaluatorMaterializationError("shopping official evaluator output is incomplete")
    reward_value = read_json(reward)
    summary = reward_value.get("summary")
    if not isinstance(summary, Mapping) or (
        summary.get("total_items") != EXPECTED_SUITE_COUNTS["bundled_shopping"]
        or summary.get("total_steps") != 900
    ):
        raise EvaluatorMaterializationError("shopping official evaluator coverage is not 150/900")

    search_evals = list((output / "progressive_search").rglob("*_eval.json"))
    if len(search_evals) != EXPECTED_SUITE_COUNTS["progressive_search"]:
        raise EvaluatorMaterializationError("search official evaluator coverage is not 221")
    search_ids = {str(read_json(path).get("query_id")) for path in search_evals}
    expected_search_ids = {
        str(item["metadata"]["official_query_id"])
        for item in read_json(run_root / "task-manifest.json")["tasks"]
        if item.get("domain") == "progressive_search"
    }
    if search_ids != expected_search_ids:
        raise EvaluatorMaterializationError("search evaluator query-id coverage differs from release")

    travel = plan["official_evaluators"]["group_travel_planner"]
    travel_model = _travel_model(input_root / str(travel["input"]))
    travel_output = output / "group_travel_planner"
    submission_dir = travel_output / "submission"
    stages.append(_run_stage(
        "group-travel-combination",
        [python, str(travel["combiner"]), "--model_name", travel_model,
         "--output_dir", str(input_root / str(travel["input"])),
         "--submission_file_dir", str(submission_dir), "--mode", "sole_planning"],
        checkout=checkout, environment=environment, log_dir=logs,
    ))
    submission = submission_dir / f"{travel_model}_submission.jsonl"
    _validate_travel_submission(submission)
    travel_global_csv = travel_output / "global.csv"
    _reset_wrapper_owned_csv(travel_global_csv, travel_output)
    stages.append(_run_stage(
        "group-travel-evaluator",
        [python, str(travel["evaluator"]), "--submission_path", str(submission),
         "--model_name", travel_model, "--memory_system", "picorer",
         "--global_csv", str(travel_global_csv)],
        checkout=checkout, environment=environment, log_dir=logs,
    ))
    _validate_travel_csv(travel_global_csv, travel_model)

    for suite in ("formal_reasoning_math", "formal_reasoning_phys"):
        formal = plan["official_evaluators"][suite]
        work_root = output / suite / "input"
        if not work_root.exists():
            shutil.copytree(input_root / str(formal["input"]), work_root)
        else:
            _verify_input_subset(
                input_root / str(formal["input"]), work_root, f"{suite} evaluator"
            )
        expected_min_k, expected_max_k = _validate_formal_evaluator_input(
            work_root, suite, task_manifest
        )
        config = output / suite / "official-eval-config.json"
        write_json_atomic(config, {"output": {"json_output_dir": str(work_root)}})
        result = work_root / "picorer/all_results.json"
        _reset_wrapper_owned_file(
            result, work_root, label=f"{suite} evaluator result"
        )
        stages.append(_run_stage(
            suite.replace("_", "-"),
            [python, str(formal["evaluator"]), str(config)],
            checkout=checkout, environment=environment, log_dir=logs,
        ))
        _validate_formal_evaluator_output(
            result,
            suite,
            expected_min_k=expected_min_k,
            expected_max_k=expected_max_k,
        )

    _verify_checkout(checkout.resolve())
    (
        coverage_gaps,
        provider_attempt_count,
        usage_count,
        coverage_status,
    ) = _judge_usage_coverage(all_judge_events)
    miss_count = sum(event.get("cache") == "miss" for event in all_judge_events)
    response_cache_inventory = _json_inventory(proxy.response_cache_dir)
    response_cache_index = locked_manifest_document({
        "schema_version": 1,
        "kind": "memoryarena-public-judge-response-cache-index",
        "run_id": plan["run_id"],
        "entries": response_cache_inventory,
    })
    write_json_atomic(output / "judge-response-cache-index.json", response_cache_index)
    root_index = store.generate_indexes()
    execution = locked_manifest_document({
        "schema_version": 1,
        "kind": "memoryarena-public-official-evaluation",
        "run_id": plan["run_id"],
        "evaluator_input_manifest_sha256": plan["manifest_sha256"],
        "code_revision": OFFICIAL_CODE_REVISION,
        "production_seam_bundle_sha256": PRODUCTION_SEAM_BUNDLE_SHA256,
        "stages": stages,
        "judge_cache": {
            "requests": len(all_judge_events),
            "invocations": len(list(audit_dir.glob("judge-proxy-*.json"))),
            "hits": sum(event.get("cache") == "hit" for event in all_judge_events),
            "misses": miss_count,
            "provider_attempts": provider_attempt_count,
            "normalized_usage_requests": usage_count,
            "usage_coverage": coverage_status,
            "usage_missing_request_ids": coverage_gaps,
            "response_cache_index_sha256": response_cache_index["manifest_sha256"],
            "price_table_sha256": price_table.sha256 if price_table else None,
        },
        "runtime_artifact_index": {
            "path": "indexes/artifacts.json",
            "sha256": file_sha256(store.indexes_dir / "artifacts.json"),
            "manifest_sha256": root_index["manifest_sha256"],
        },
        "official_output_inventory": [
            entry
            for entry in _json_inventory(output)
            if entry["path"] != "official-evaluation.json"
        ],
        "scoring_performed": True,
    })
    write_json_atomic(output / "official-evaluation.json", execution)
    return execution


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Materialize and run the five pinned official MemoryArena evaluators"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    materialize = commands.add_parser("materialize", help="gate 701 results and stage official inputs")
    materialize.add_argument("--run-dir", type=Path, required=True)
    materialize.add_argument("--output-dir", type=Path, required=True)
    materialize.add_argument("--checkout", type=Path, required=True)
    materialize.add_argument("--asset-lock", type=Path, required=True)
    materialize.add_argument("--search-ground-truth", type=Path, required=True)
    materialize.add_argument("--search-qrels", type=Path, required=True)
    materialize.add_argument("--shopping-product-catalog", type=Path, required=True)
    materialize.add_argument("--shopping-domain-data", type=Path, required=True)
    execute = commands.add_parser("run", help="execute/resume all official evaluator stages")
    execute.add_argument("--run-dir", type=Path, required=True)
    execute.add_argument("--input-dir", type=Path, required=True)
    execute.add_argument("--output-dir", type=Path, required=True)
    execute.add_argument("--checkout", type=Path, required=True)
    execute.add_argument("--python", default=sys.executable)
    execute.add_argument("--price-table", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "materialize":
            document = materialize_official_evaluator_inputs(
                args.run_dir,
                args.output_dir,
                checkout=args.checkout.resolve(),
                asset_lock=args.asset_lock.resolve(),
                search_ground_truth=args.search_ground_truth.resolve(),
                search_qrels=args.search_qrels.resolve(),
                shopping_product_catalog=args.shopping_product_catalog.resolve(),
                shopping_domain_data=args.shopping_domain_data.resolve(),
            )
        else:
            price_table = load_price_table(args.price_table) if args.price_table else None
            document = run_official_evaluators(
                args.run_dir,
                args.input_dir,
                args.output_dir,
                checkout=args.checkout.resolve(),
                python=args.python,
                price_table=price_table,
            )
    except (EvaluatorMaterializationError, UsageNormalizationError) as error:
        print(f"MemoryArena official evaluator error: {error}")
        return 2
    print(document["manifest_sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
