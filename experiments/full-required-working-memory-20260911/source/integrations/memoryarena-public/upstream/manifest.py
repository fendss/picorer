from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from runtime.artifacts import (
    canonical_sha256,
    file_sha256,
    locked_manifest_document,
    validate_locked_manifest,
    write_json_atomic,
)
from runtime.models import TaskSpec

from .assets import validate_official_asset_lock_document

from .contracts import (
    EXPECTED_SUBTASK_TOTAL,
    EXPECTED_SUITE_COUNTS,
    EXPECTED_SUITE_SUBTASK_COUNTS,
    EXPECTED_TASK_TOTAL,
    OFFICIAL_CODE_REVISION,
    PUBLIC_DATA_REVISION,
    PUBLIC_DATASET,
    RELEASE_ID,
    SEARCH_RUNNER_IDS_ORDERED_SHA256,
    SEARCH_TASK_DATA_SHA256,
    SEARCH_TASK_DATA_GIT_OID,
    SUITE_CONTRACTS,
    ManifestMaterializationError,
    SuiteContract,
)


MANIFEST_KIND = "memoryarena-public-task-manifest"
_SHA256 = re.compile(r"[0-9a-f]{64}")


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestMaterializationError(f"cannot read {label} {path}: {error}") from error
    if not isinstance(value, dict):
        raise ManifestMaterializationError(f"{label} must be a JSON object: {path}")
    return value


def _read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    raise ManifestMaterializationError(
                        f"blank line in {label} at {path}:{line_number}"
                    )
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ManifestMaterializationError(
                        f"non-object row in {label} at {path}:{line_number}"
                    )
                rows.append(value)
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestMaterializationError(f"cannot read {label} {path}: {error}") from error
    return rows


def _canonical_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ManifestMaterializationError(f"{label} must be an integer, got {value!r}")
    return value


def _string_list(
    record: Mapping[str, Any], key: str, label: str, *, allow_empty: bool = False
) -> list[str]:
    value = record.get(key)
    if (
        not isinstance(value, list)
        or not value
        or any(
            not isinstance(item, str) or (not allow_empty and not item)
            for item in value
        )
    ):
        raise ManifestMaterializationError(f"{label}.{key} must be a non-empty string list")
    return value


def _nonempty_list(record: Mapping[str, Any], key: str, label: str) -> list[Any]:
    value = record.get(key)
    if not isinstance(value, list) or not value:
        raise ManifestMaterializationError(f"{label}.{key} must be a non-empty list")
    return value


def _validate_record(contract: SuiteContract, record: Mapping[str, Any], line: int) -> int:
    label = f"{contract.name} row {line}"
    identifier = _canonical_integer(record.get("id"), f"{label}.id")
    questions = _string_list(record, "questions", label)
    answers = _nonempty_list(record, "answers", label)
    if len(questions) != len(answers):
        raise ManifestMaterializationError(f"{label} question/answer lengths differ")
    if contract.record_kind == "shopping":
        if (
            len(questions) != 6
            or not isinstance(record.get("category"), str)
            or any(
                not isinstance(answer, Mapping)
                or not isinstance(answer.get("target_asin"), str)
                or not isinstance(answer.get("attributes", []), list)
                for answer in answers
            )
        ):
            raise ManifestMaterializationError(f"{label} is not an official six-step shopping row")
    elif contract.record_kind == "travel":
        if (
            not isinstance(record.get("base_person"), Mapping)
            or any(
                not isinstance(days, list)
                or any(not isinstance(day, Mapping) for day in days)
                for days in answers
            )
        ):
            raise ManifestMaterializationError(f"{label} has no base_person object")
    elif contract.record_kind == "formal":
        backgrounds = _string_list(record, "backgrounds", label, allow_empty=True)
        if (
            len(backgrounds) != len(questions)
            or any(not isinstance(answer, str) for answer in answers)
            or not isinstance(record.get("paper_name"), str)
        ):
            raise ManifestMaterializationError(f"{label} has invalid formal task fields")
    elif any(not isinstance(answer, str) for answer in answers):
        raise ManifestMaterializationError(f"{label}.answers must contain strings")
    return identifier


def _search_runner_ids(
    records: Sequence[Mapping[str, Any]],
    task_data_path: Path,
    *,
    expected_sha256: str = SEARCH_TASK_DATA_SHA256,
) -> dict[int, str]:
    if file_sha256(task_data_path) != expected_sha256:
        raise ManifestMaterializationError(
            "browsecomp_all_jsons.jsonl is not the pinned websearch-embeddings blob"
        )
    task_rows = _read_jsonl(task_data_path, "pinned search task decomposition")
    by_payload: dict[tuple[tuple[str, ...], tuple[str, ...]], str] = {}
    seen_runner_ids: set[str] = set()
    for line, row in enumerate(task_rows, start=1):
        questions = row.get("question", row.get("questions"))
        answers = row.get("answer", row.get("answers"))
        if (
            not isinstance(questions, list)
            or not isinstance(answers, list)
            or not questions
            or len(questions) != len(answers)
            or any(not isinstance(item, str) for item in questions + answers)
        ):
            raise ManifestMaterializationError(
                f"invalid search decomposition row at {task_data_path}:{line}"
            )
        raw_id = row.get("id")
        if isinstance(raw_id, bool) or not isinstance(raw_id, (str, int)):
            raise ManifestMaterializationError(f"invalid official search query id: {raw_id!r}")
        runner_id = str(raw_id)
        if not runner_id or runner_id in seen_runner_ids:
            raise ManifestMaterializationError(f"duplicate official search query id {runner_id!r}")
        key = (tuple(questions), tuple(answers))
        if key in by_payload:
            raise ManifestMaterializationError("search decomposition payloads are not one-to-one")
        by_payload[key] = runner_id
        seen_runner_ids.add(runner_id)

    if len(task_rows) != len(records):
        raise ManifestMaterializationError(
            "pinned search decomposition count differs from progressive_search"
        )
    mapping: dict[int, str] = {}
    for ordinal, record in enumerate(records):
        key = (tuple(record["questions"]), tuple(record["answers"]))
        runner_id = by_payload.get(key)
        if runner_id is None:
            raise ManifestMaterializationError(
                f"progressive_search row {ordinal} has no exact pinned runner-id match"
            )
        mapping[ordinal] = runner_id
    if len(set(mapping.values())) != len(records):
        raise ManifestMaterializationError("progressive_search runner-id mapping is not bijective")
    return mapping


def _subtask_ids(suite: str, record_id: int, count: int) -> tuple[str, ...]:
    key = f"{suite}/{record_id:03d}"
    if suite == "bundled_shopping":
        return tuple(f"{key}/step/{index}" for index in range(1, count + 1))
    if suite == "progressive_search":
        return tuple(
            [f"{key}/subquery/{index}" for index in range(1, count)] + [f"{key}/final"]
        )
    if suite == "group_travel_planner":
        return tuple(f"{key}/person/{index}" for index in range(1, count + 1))
    return tuple(f"{key}/query/{index}" for index in range(count))


def _load_asset_lock_hash(
    asset_lock: Mapping[str, Any] | Path, *, require_official: bool
) -> str:
    value = _read_json(asset_lock, "local asset lock") if isinstance(asset_lock, Path) else dict(asset_lock)
    try:
        document = validate_locked_manifest(value)
    except ValueError as error:
        raise ManifestMaterializationError(f"invalid local asset lock: {error}") from error
    if document.get("kind") != "memoryarena-public-local-assets":
        raise ManifestMaterializationError("unexpected local asset lock kind")
    if document.get("code_revision") != OFFICIAL_CODE_REVISION:
        raise ManifestMaterializationError("local assets use another code revision")
    if document.get("data_revision") != PUBLIC_DATA_REVISION:
        raise ManifestMaterializationError("local assets use another data revision")
    if require_official:
        try:
            validate_official_asset_lock_document(document)
        except Exception as error:
            raise ManifestMaterializationError(
                f"local asset lock lacks pinned snapshot provenance: {error}"
            ) from error
    return str(document["manifest_sha256"])


def materialize_locked_task_manifest(
    data_root: Path,
    *,
    search_task_data_path: Path,
    local_asset_lock: Mapping[str, Any] | Path,
    contracts: Mapping[str, SuiteContract] = SUITE_CONTRACTS,
    production: bool = True,
    expected_search_task_sha256: str = SEARCH_TASK_DATA_SHA256,
) -> dict[str, Any]:
    """Inspect every source row and emit the concrete, immutable TaskSpec set."""

    if production and contracts != SUITE_CONTRACTS:
        raise ManifestMaterializationError("production materialization requires official suite contracts")
    asset_hash = _load_asset_lock_hash(local_asset_lock, require_official=production)
    all_records: dict[str, list[dict[str, Any]]] = {}
    source_files: dict[str, dict[str, Any]] = {}
    for suite, contract in contracts.items():
        path = contract.data_path(data_root)
        if not path.is_file():
            raise ManifestMaterializationError(f"missing pinned suite data: {path}")
        actual_hash = file_sha256(path)
        if production and actual_hash != contract.data_sha256:
            raise ManifestMaterializationError(f"pinned suite data hash mismatch: {suite}")
        rows = _read_jsonl(path, f"{suite} source")
        identifiers = [_validate_record(contract, row, line) for line, row in enumerate(rows, 1)]
        if tuple(identifiers) != contract.expected_ids:
            raise ManifestMaterializationError(
                f"{suite} actual ordered ids differ from the release contract"
            )
        all_records[suite] = rows
        source_files[suite] = {
            "relative_path": contract.data_relative_path,
            "sha256": actual_hash,
            "git_oid": contract.data_git_oid,
            "row_count": len(rows),
        }

    search_mapping = _search_runner_ids(
        all_records["progressive_search"],
        search_task_data_path,
        expected_sha256=expected_search_task_sha256,
    )
    ordered_search_ids = [search_mapping[index] for index in range(len(search_mapping))]
    if production and canonical_sha256(ordered_search_ids) != SEARCH_RUNNER_IDS_ORDERED_SHA256:
        raise ManifestMaterializationError("official search runner-id ordering changed")
    tasks: list[TaskSpec] = []
    for suite in contracts:
        contract = contracts[suite]
        for ordinal, record in enumerate(all_records[suite]):
            record_id = int(record["id"])
            key = f"{suite}/{record_id:03d}"
            metadata: dict[str, Any] = {
                "release_id": RELEASE_ID,
                "suite": suite,
                "record_kind": contract.record_kind,
                "record_id": record_id,
                "ordinal": ordinal,
                "source": {
                    "relative_path": contract.data_relative_path,
                    "line_number": ordinal + 1,
                    "file_sha256": source_files[suite]["sha256"],
                    "data_git_oid": contract.data_git_oid,
                },
                "code_revision": OFFICIAL_CODE_REVISION,
                "data_revision": PUBLIC_DATA_REVISION,
                "official_runner": contract.official_runner,
                "local_asset_manifest_sha256": asset_hash,
            }
            if suite == "progressive_search":
                metadata["official_query_id"] = search_mapping[ordinal]
            elif suite == "bundled_shopping":
                metadata["category"] = record["category"]
            elif contract.record_kind == "formal":
                metadata["paper_name"] = record["paper_name"]
            tasks.append(
                TaskSpec(
                    task_key=key,
                    domain=suite,
                    subtask_ids=_subtask_ids(suite, record_id, len(record["questions"])),
                    source_record_hash=canonical_sha256(record),
                    metadata=metadata,
                )
            )

    tasks.sort(key=lambda task: task.task_key)
    suite_counts = Counter(task.domain for task in tasks)
    suite_subtasks = Counter()
    for task in tasks:
        suite_subtasks[task.domain] += len(task.subtask_ids)
    if production and (
        len(tasks) != EXPECTED_TASK_TOTAL
        or sum(len(task.subtask_ids) for task in tasks) != EXPECTED_SUBTASK_TOTAL
        or dict(suite_counts) != dict(EXPECTED_SUITE_COUNTS)
        or dict(suite_subtasks) != dict(EXPECTED_SUITE_SUBTASK_COUNTS)
    ):
        raise ManifestMaterializationError("source records do not satisfy the 701/4,850 release")

    body = {
        "schema_version": 2,
        "kind": MANIFEST_KIND,
        "benchmark_name": "MemoryArena Public",
        "release_id": RELEASE_ID,
        "code_revision": OFFICIAL_CODE_REVISION,
        "data_repository": PUBLIC_DATASET,
        "data_revision": PUBLIC_DATA_REVISION,
        "local_asset_manifest_sha256": asset_hash,
        "task_count": len(tasks),
        "total_subtasks": sum(len(task.subtask_ids) for task in tasks),
        "suite_counts": dict(suite_counts),
        "domain_counts": dict(suite_counts),
        "suite_subtask_counts": dict(suite_subtasks),
        "source_files": source_files,
        "search_runner_ids_source": {
            "relative_path": "env/env_systems/web_search_env/data/browsecomp_all_jsons.jsonl",
            "sha256": expected_search_task_sha256,
            "git_oid": SEARCH_TASK_DATA_GIT_OID,
            "row_count": len(ordered_search_ids),
            "ordered_ids_sha256": canonical_sha256(ordered_search_ids),
        },
        "tasks": [task.to_manifest_entry() for task in tasks],
    }
    document = locked_manifest_document(body)
    if production:
        validate_official_locked_task_manifest(document)
    return document


def _expect_exact(value: Any, expected: Any, label: str) -> None:
    if value != expected:
        raise ManifestMaterializationError(f"official task manifest {label} mismatch")


def validate_official_locked_task_manifest(
    value: Mapping[str, Any] | Path,
    *,
    data_root: Path | None = None,
    search_task_data_path: Path | None = None,
) -> tuple[TaskSpec, ...]:
    """Hard gate: a self-signed subset is never an eligible public release."""

    raw = _read_json(value, "task manifest") if isinstance(value, Path) else dict(value)
    try:
        document = validate_locked_manifest(raw)
    except ValueError as error:
        raise ManifestMaterializationError(f"invalid locked task manifest: {error}") from error
    exact_fields = {
        "schema_version": 2,
        "kind": MANIFEST_KIND,
        "benchmark_name": "MemoryArena Public",
        "release_id": RELEASE_ID,
        "code_revision": OFFICIAL_CODE_REVISION,
        "data_repository": PUBLIC_DATASET,
        "data_revision": PUBLIC_DATA_REVISION,
        "task_count": EXPECTED_TASK_TOTAL,
        "total_subtasks": EXPECTED_SUBTASK_TOTAL,
        "suite_counts": dict(EXPECTED_SUITE_COUNTS),
        "domain_counts": dict(EXPECTED_SUITE_COUNTS),
        "suite_subtask_counts": dict(EXPECTED_SUITE_SUBTASK_COUNTS),
    }
    for key, expected in exact_fields.items():
        _expect_exact(document.get(key), expected, key)
    asset_hash = document.get("local_asset_manifest_sha256")
    if not isinstance(asset_hash, str) or not _SHA256.fullmatch(asset_hash):
        raise ManifestMaterializationError("official task manifest has no local asset binding")
    _expect_exact(
        document.get("search_runner_ids_source"),
        {
            "relative_path": "env/env_systems/web_search_env/data/browsecomp_all_jsons.jsonl",
            "sha256": SEARCH_TASK_DATA_SHA256,
            "git_oid": SEARCH_TASK_DATA_GIT_OID,
            "row_count": 221,
            "ordered_ids_sha256": SEARCH_RUNNER_IDS_ORDERED_SHA256,
        },
        "search_runner_ids_source",
    )

    raw_tasks = document.get("tasks")
    if not isinstance(raw_tasks, list) or len(raw_tasks) != EXPECTED_TASK_TOTAL:
        raise ManifestMaterializationError("official task manifest must contain exactly 701 tasks")
    try:
        tasks = tuple(TaskSpec.from_manifest_entry(entry) for entry in raw_tasks)
    except (KeyError, TypeError, ValueError) as error:
        raise ManifestMaterializationError(f"invalid TaskSpec entry: {error}") from error
    if [task.task_key for task in tasks] != sorted(task.task_key for task in tasks):
        raise ManifestMaterializationError("official TaskSpecs are not sorted")
    if len({task.task_key for task in tasks}) != len(tasks):
        raise ManifestMaterializationError("official TaskSpecs contain duplicate keys")

    by_suite: dict[str, list[TaskSpec]] = {suite: [] for suite in SUITE_CONTRACTS}
    for task in tasks:
        if task.domain not in by_suite:
            raise ManifestMaterializationError(f"unknown official domain: {task.domain}")
        metadata = task.metadata
        suite = task.domain
        if (
            metadata.get("suite") != suite
            or metadata.get("release_id") != RELEASE_ID
            or metadata.get("code_revision") != OFFICIAL_CODE_REVISION
            or metadata.get("data_revision") != PUBLIC_DATA_REVISION
            or metadata.get("local_asset_manifest_sha256") != asset_hash
        ):
            raise ManifestMaterializationError(f"TaskSpec provenance mismatch: {task.task_key}")
        by_suite[suite].append(task)
    for suite, contract in SUITE_CONTRACTS.items():
        actual_ids = tuple(int(task.metadata.get("record_id")) for task in by_suite[suite])
        if actual_ids != contract.expected_ids:
            raise ManifestMaterializationError(f"TaskSpec ordered ids mismatch: {suite}")
        for ordinal, task in enumerate(by_suite[suite]):
            expected_key = f"{suite}/{contract.expected_ids[ordinal]:03d}"
            if task.task_key != expected_key or task.metadata.get("ordinal") != ordinal:
                raise ManifestMaterializationError(f"TaskSpec identity mismatch: {task.task_key}")
            expected_subtasks = _subtask_ids(
                suite, contract.expected_ids[ordinal], len(task.subtask_ids)
            )
            if task.subtask_ids != expected_subtasks:
                raise ManifestMaterializationError(f"TaskSpec subtask ordering mismatch: {task.task_key}")
            if suite == "progressive_search" and not isinstance(
                task.metadata.get("official_query_id"), str
            ):
                raise ManifestMaterializationError(f"search TaskSpec lacks runner id: {task.task_key}")
    if sum(len(task.subtask_ids) for task in tasks) != EXPECTED_SUBTASK_TOTAL:
        raise ManifestMaterializationError("TaskSpec subtask total is not 4,850")
    ordered_runner_ids = [
        str(task.metadata["official_query_id"])
        for task in by_suite["progressive_search"]
    ]
    if canonical_sha256(ordered_runner_ids) != SEARCH_RUNNER_IDS_ORDERED_SHA256:
        raise ManifestMaterializationError("TaskSpec official search query ids are not release-bound")

    if data_root is not None or search_task_data_path is not None:
        if data_root is None or search_task_data_path is None:
            raise ManifestMaterializationError(
                "source revalidation requires both data_root and search_task_data_path"
            )
        # Rebuild from source while retaining the already-validated asset binding.
        fake_asset_lock = locked_manifest_document(
            {
                "schema_version": 1,
                "kind": "memoryarena-public-local-assets",
                "code_revision": OFFICIAL_CODE_REVISION,
                "data_revision": PUBLIC_DATA_REVISION,
                "assets": {},
            }
        )
        # Preserve the actual bound hash without accepting a second, self-signed
        # asset document: rebuild the manifest body directly then swap the binding.
        rebuilt = materialize_locked_task_manifest(
            data_root,
            search_task_data_path=search_task_data_path,
            local_asset_lock=fake_asset_lock,
            production=False,
        )
        rebuilt_body = dict(rebuilt)
        rebuilt_body.pop("manifest_sha256", None)
        rebuilt_body["local_asset_manifest_sha256"] = asset_hash
        for entry in rebuilt_body["tasks"]:
            entry["metadata"]["local_asset_manifest_sha256"] = asset_hash
        rebuilt = locked_manifest_document(rebuilt_body)
        if rebuilt != document:
            raise ManifestMaterializationError("task manifest differs from hydrated pinned records")
    return tasks


def write_task_manifest(path: Path, document: Mapping[str, Any]) -> None:
    validate_official_locked_task_manifest(document)
    write_json_atomic(path, dict(document))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Materialize the concrete 701-task release")
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--search-task-data", type=Path, required=True)
    parser.add_argument("--asset-lock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        document = materialize_locked_task_manifest(
            args.data_root.resolve(),
            search_task_data_path=args.search_task_data.resolve(),
            local_asset_lock=args.asset_lock.resolve(),
        )
        write_task_manifest(args.output.resolve(), document)
    except ManifestMaterializationError as error:
        print(f"MemoryArena manifest error: {error}")
        return 2
    print(document["manifest_sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
