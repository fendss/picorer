from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from .artifacts import (
    ArtifactStore,
    canonical_sha256,
    file_sha256,
    read_json,
    task_artifact_filename,
)
from .models import TaskSpec, TaskStatus


class IntegrityError(RuntimeError):
    pass


RELEASE_ID = (
    "memoryarena-public@6cd9de14b71915e39ac742a20dc33785e14b6aab+"
    "data.da1a37c8b19280e18627ca01cf368195a5e1d92e"
)
OFFICIAL_CODE_REVISION = "6cd9de14b71915e39ac742a20dc33785e14b6aab"
PUBLIC_DATA_REPOSITORY = "ZexueHe/memoryarena"
PUBLIC_DATA_REVISION = "da1a37c8b19280e18627ca01cf368195a5e1d92e"
RELEASE_TASK_COUNT = 701
RELEASE_SUBTASK_COUNT = 4_850
RELEASE_SUITE_COUNTS = {
    "bundled_shopping": 150,
    "progressive_search": 221,
    "group_travel_planner": 270,
    "formal_reasoning_math": 40,
    "formal_reasoning_phys": 20,
}
RELEASE_SUITE_SUBTASK_COUNTS = {
    "bundled_shopping": 900,
    "progressive_search": 1_641,
    "group_travel_planner": 1_869,
    "formal_reasoning_math": 354,
    "formal_reasoning_phys": 86,
}
SEARCH_RUNNER_IDS_SHA256 = (
    "1d1ff11bfc03020da90f194eeac7833eeb4b466341f509b776368f04a8cde2ce"
)
SEARCH_RUNNER_IDS_SOURCE = {
    "relative_path": (
        "env/env_systems/web_search_env/data/browsecomp_all_jsons.jsonl"
    ),
    "sha256": "6f6b1f6c40ae37196e23fe4053747568ed2031bffd3da3733748f99c6631b46f",
    "git_oid": "a0db15e9178f9362380ac423b180ca6545bef11e",
    "row_count": 221,
    "ordered_ids_sha256": SEARCH_RUNNER_IDS_SHA256,
}
_RELEASE_SUITE_DETAILS = {
    "bundled_shopping": {
        "record_kind": "shopping",
        "id_start": 0,
        "runner": "run_shopping.py",
        "relative_path": "bundled_shopping/data.jsonl",
        "file_sha256": "4411a2da528a33dc6aca519b49cc225895363f18b2d19b191fddb501200134ef",
        "data_git_oid": "5fc6b362fc68cc0724e8d3b5147f550408d2aba8",
    },
    "progressive_search": {
        "record_kind": "search",
        "id_start": 0,
        "runner": "run_search.py",
        "relative_path": "progressive_search/data.jsonl",
        "file_sha256": "b445ee36fa3ccb9ad08eae9e7adda86bbc64f14f1e2a0682a8b2085cdb8e4c0e",
        "data_git_oid": "625bba3fbc13273f2c181f1589ef957d64dc827f",
    },
    "group_travel_planner": {
        "record_kind": "travel",
        "id_start": 1,
        "runner": "run_travel.py",
        "relative_path": "group_travel_planner/data.jsonl",
        "file_sha256": "2f955d444f6f3ad3c5da2064359ab19f8fc1f90621ff9d00723a450a009c3732",
        "data_git_oid": "e3953b64b9559f6343f0e55170238a6260e5e4ff",
    },
    "formal_reasoning_math": {
        "record_kind": "formal",
        "id_start": 0,
        "runner": "run_math.py",
        "relative_path": "formal_reasoning_math/data.jsonl",
        "file_sha256": "ff5b0ad575847c7476a02d1e35661592a833bd0cff384cb54bc6f35b46de7803",
        "data_git_oid": "17c7889589c7820b4e51c953a26fc7f7b5690db8",
    },
    "formal_reasoning_phys": {
        "record_kind": "formal",
        "id_start": 0,
        "runner": "run_math.py",
        "relative_path": "formal_reasoning_phys/data.jsonl",
        "file_sha256": "580862006af2ff2bfc8c5d2d2b9a60bf33a46cbb64f27d60a2bfe039aec61cf6",
        "data_git_oid": "d8bee38750da6699e136a11f33c69eaa673b964c",
    },
}
_SHA256 = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class ArtifactInventoryReport:
    orphan_artifacts: tuple[str, ...]
    corrupt_artifacts: tuple[str, ...]

    @property
    def clean(self) -> bool:
        return not self.orphan_artifacts and not self.corrupt_artifacts

    def to_dict(self) -> dict[str, Any]:
        return {
            "clean": self.clean,
            "orphan_artifacts": list(self.orphan_artifacts),
            "corrupt_artifacts": list(self.corrupt_artifacts),
        }


@dataclass(frozen=True)
class CompletenessReport:
    expected: int
    succeeded: tuple[str, ...]
    failed_retryable: tuple[str, ...]
    blocked: tuple[str, ...]
    pending: tuple[str, ...]
    running: tuple[str, ...]
    invalid: tuple[str, ...]
    unexpected_records: tuple[str, ...]

    @property
    def eligible_for_scoring(self) -> bool:
        return (
            len(self.succeeded) == self.expected
            and not self.failed_retryable
            and not self.blocked
            and not self.pending
            and not self.running
            and not self.invalid
            and not self.unexpected_records
        )

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["eligible_for_scoring"] = self.eligible_for_scoring
        value["counts"] = {
            "expected": self.expected,
            "succeeded": len(self.succeeded),
            "failed_retryable": len(self.failed_retryable),
            "blocked": len(self.blocked),
            "pending": len(self.pending),
            "running": len(self.running),
            "invalid": len(self.invalid),
            "unexpected_records": len(self.unexpected_records),
        }
        return value


def task_specs_from_manifest(task_manifest: Mapping[str, Any]) -> tuple[TaskSpec, ...]:
    if task_manifest.get("benchmark_name") != "MemoryArena Public":
        raise IntegrityError("task manifest benchmark_name must be MemoryArena Public")
    raw_tasks = task_manifest.get("tasks")
    if not isinstance(raw_tasks, list) or not raw_tasks:
        raise IntegrityError("task manifest must contain a non-empty tasks list")
    try:
        tasks = tuple(TaskSpec.from_manifest_entry(item) for item in raw_tasks)
    except (KeyError, TypeError, ValueError) as error:
        raise IntegrityError(f"invalid task manifest entry: {error}") from error
    keys = [task.task_key for task in tasks]
    if len(set(keys)) != len(keys):
        raise IntegrityError("task manifest contains duplicate task keys")
    if keys != sorted(keys):
        raise IntegrityError("task manifest tasks must be sorted by task_key")
    return tasks


def _fixture_task_manifest(
    task_manifest: Mapping[str, Any], tasks: Sequence[TaskSpec]
) -> None:
    if task_manifest.get("test_fixture") is not True:
        raise IntegrityError("test fixture manifests must set test_fixture=true")
    declared_count = task_manifest.get("task_count")
    if isinstance(declared_count, bool) or declared_count != len(tasks):
        raise IntegrityError(
            f"task_count mismatch: declared {declared_count}, found {len(tasks)}"
        )


def _exact_mapping(value: Any, expected: Mapping[str, int], label: str) -> None:
    if not isinstance(value, Mapping):
        raise IntegrityError(f"{label} must be an object")
    actual: dict[str, int] = {}
    for key, item in value.items():
        if isinstance(item, bool) or not isinstance(item, int):
            raise IntegrityError(f"{label}.{key} must be an integer")
        actual[str(key)] = item
    if actual != dict(expected):
        raise IntegrityError(f"{label} differs from the fixed release contract")


def _release_header(task_manifest: Mapping[str, Any]) -> str:
    expected_scalars = {
        "schema_version": 2,
        "kind": "memoryarena-public-task-manifest",
        "benchmark_name": "MemoryArena Public",
        "release_id": RELEASE_ID,
        "code_revision": OFFICIAL_CODE_REVISION,
        "data_repository": PUBLIC_DATA_REPOSITORY,
        "data_revision": PUBLIC_DATA_REVISION,
        "task_count": RELEASE_TASK_COUNT,
        "total_subtasks": RELEASE_SUBTASK_COUNT,
    }
    for key, expected in expected_scalars.items():
        if task_manifest.get(key) != expected:
            raise IntegrityError(
                f"{key} differs from the fixed MemoryArena Public release contract"
            )
    if "test_fixture" in task_manifest:
        raise IntegrityError("production task manifests must not set test_fixture")
    expected_fields = set(expected_scalars) | {
        "local_asset_manifest_sha256",
        "suite_counts",
        "domain_counts",
        "suite_subtask_counts",
        "source_files",
        "search_runner_ids_source",
        "tasks",
        "manifest_sha256",
    }
    if set(task_manifest) != expected_fields:
        raise IntegrityError("production task manifest has unsupported top-level fields")
    _exact_mapping(
        task_manifest.get("suite_counts"), RELEASE_SUITE_COUNTS, "suite_counts"
    )
    _exact_mapping(
        task_manifest.get("domain_counts"), RELEASE_SUITE_COUNTS, "domain_counts"
    )
    _exact_mapping(
        task_manifest.get("suite_subtask_counts"),
        RELEASE_SUITE_SUBTASK_COUNTS,
        "suite_subtask_counts",
    )
    local_asset_hash = task_manifest.get("local_asset_manifest_sha256")
    if not isinstance(local_asset_hash, str) or not _SHA256.fullmatch(
        local_asset_hash
    ):
        raise IntegrityError("local_asset_manifest_sha256 must be a lowercase SHA-256")
    return local_asset_hash


def _release_source_files(task_manifest: Mapping[str, Any]) -> None:
    source_files = task_manifest.get("source_files")
    if not isinstance(source_files, Mapping) or set(source_files) != set(
        RELEASE_SUITE_COUNTS
    ):
        raise IntegrityError("source_files must contain exactly the five release suites")
    for suite, details in _RELEASE_SUITE_DETAILS.items():
        raw = source_files.get(suite)
        if not isinstance(raw, Mapping):
            raise IntegrityError(f"source_files.{suite} must be an object")
        expected = {
            "relative_path": details["relative_path"],
            "sha256": details["file_sha256"],
            "git_oid": details["data_git_oid"],
            "row_count": RELEASE_SUITE_COUNTS[suite],
        }
        if dict(raw) != expected:
            raise IntegrityError(
                f"source_files.{suite} differs from the pinned release file"
            )
    if task_manifest.get("search_runner_ids_source") != SEARCH_RUNNER_IDS_SOURCE:
        raise IntegrityError(
            "search_runner_ids_source differs from the pinned auxiliary file"
        )


def _integer_metadata(metadata: Mapping[str, Any], key: str, task_key: str) -> int:
    value = metadata.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise IntegrityError(f"{task_key} metadata.{key} must be an integer")
    return value


def _validate_subtask_ids(task: TaskSpec, suite: str) -> None:
    key = task.task_key
    actual = task.subtask_ids
    if suite == "bundled_shopping":
        expected = tuple(f"{key}/step/{index}" for index in range(1, 7))
    elif suite == "progressive_search":
        expected = tuple(
            [
                *(f"{key}/subquery/{index}" for index in range(1, len(actual))),
                f"{key}/final",
            ]
        )
    elif suite == "group_travel_planner":
        expected = tuple(
            f"{key}/person/{index}" for index in range(1, len(actual) + 1)
        )
    else:
        expected = tuple(f"{key}/query/{index}" for index in range(len(actual)))
    if actual != expected:
        raise IntegrityError(f"{key} has non-canonical or reordered subtask ids")


def _validate_release_task(
    task: TaskSpec,
    *,
    suite: str,
    expected_record_id: int,
    ordinal: int,
    local_asset_hash: str,
) -> None:
    details = _RELEASE_SUITE_DETAILS[suite]
    expected_key = f"{suite}/{expected_record_id:03d}"
    if task.task_key != expected_key or task.domain != suite:
        raise IntegrityError(
            f"release task order/id mismatch: expected {expected_key}, got {task.task_key}"
        )
    metadata = task.metadata
    expected_common = {
        "release_id": RELEASE_ID,
        "suite": suite,
        "record_kind": details["record_kind"],
        "record_id": expected_record_id,
        "ordinal": ordinal,
        "code_revision": OFFICIAL_CODE_REVISION,
        "data_revision": PUBLIC_DATA_REVISION,
        "official_runner": details["runner"],
        "local_asset_manifest_sha256": local_asset_hash,
    }
    for key, expected in expected_common.items():
        if metadata.get(key) != expected:
            raise IntegrityError(f"{task.task_key} metadata.{key} is not release-bound")
    _integer_metadata(metadata, "record_id", task.task_key)
    _integer_metadata(metadata, "ordinal", task.task_key)
    raw_source = metadata.get("source")
    if not isinstance(raw_source, Mapping):
        raise IntegrityError(f"{task.task_key} metadata.source must be an object")
    expected_source = {
        "relative_path": details["relative_path"],
        "line_number": ordinal + 1,
        "file_sha256": details["file_sha256"],
        "data_git_oid": details["data_git_oid"],
    }
    if dict(raw_source) != expected_source:
        raise IntegrityError(f"{task.task_key} metadata.source is not release-bound")

    allowed = set(expected_common) | {"source"}
    if suite == "bundled_shopping":
        if not isinstance(metadata.get("category"), str) or not metadata["category"]:
            raise IntegrityError(f"{task.task_key} metadata.category is required")
        allowed.add("category")
    elif suite == "progressive_search":
        query_id = metadata.get("official_query_id")
        if not isinstance(query_id, str) or not query_id:
            raise IntegrityError(
                f"{task.task_key} metadata.official_query_id is required"
            )
        allowed.add("official_query_id")
    elif suite.startswith("formal_reasoning_"):
        if not isinstance(metadata.get("paper_name"), str) or not metadata[
            "paper_name"
        ]:
            raise IntegrityError(f"{task.task_key} metadata.paper_name is required")
        allowed.add("paper_name")
    if set(metadata) != allowed:
        raise IntegrityError(f"{task.task_key} metadata contains unsupported fields")
    _validate_subtask_ids(task, suite)


def validate_release_task_manifest(
    task_manifest: Mapping[str, Any],
) -> tuple[TaskSpec, ...]:
    """Validate the one immutable, complete MemoryArena Public release."""

    supplied_hash = task_manifest.get("manifest_sha256")
    body = dict(task_manifest)
    body.pop("manifest_sha256", None)
    if not isinstance(supplied_hash, str) or canonical_sha256(body) != supplied_hash:
        raise IntegrityError("release task manifest is not validly SHA-locked")
    local_asset_hash = _release_header(task_manifest)
    _release_source_files(task_manifest)
    tasks = task_specs_from_manifest(task_manifest)
    if len(tasks) != RELEASE_TASK_COUNT:
        raise IntegrityError(
            f"release task manifest must contain {RELEASE_TASK_COUNT} tasks"
        )
    if len({task.source_record_hash for task in tasks}) != RELEASE_TASK_COUNT:
        raise IntegrityError("release source_record_hash values must be unique")
    by_suite: dict[str, list[TaskSpec]] = {
        suite: [] for suite in RELEASE_SUITE_COUNTS
    }
    for task in tasks:
        if task.domain not in by_suite:
            raise IntegrityError(f"unexpected release domain: {task.domain}")
        by_suite[task.domain].append(task)
    for suite, count in RELEASE_SUITE_COUNTS.items():
        suite_tasks = by_suite[suite]
        if len(suite_tasks) != count:
            raise IntegrityError(f"{suite} must contain exactly {count} tasks")
        start = int(_RELEASE_SUITE_DETAILS[suite]["id_start"])
        for ordinal, task in enumerate(suite_tasks):
            _validate_release_task(
                task,
                suite=suite,
                expected_record_id=start + ordinal,
                ordinal=ordinal,
                local_asset_hash=local_asset_hash,
            )
        subtask_count = sum(len(task.subtask_ids) for task in suite_tasks)
        if subtask_count != RELEASE_SUITE_SUBTASK_COUNTS[suite]:
            raise IntegrityError(
                f"{suite} must contain exactly "
                f"{RELEASE_SUITE_SUBTASK_COUNTS[suite]} subtasks"
            )
    ordered_search_ids = [
        str(task.metadata["official_query_id"])
        for task in by_suite["progressive_search"]
    ]
    if canonical_sha256(ordered_search_ids) != SEARCH_RUNNER_IDS_SHA256:
        raise IntegrityError(
            "progressive_search official_query_id ordering differs from the pinned "
            "runner-id join"
        )
    if sum(len(task.subtask_ids) for task in tasks) != RELEASE_SUBTASK_COUNT:
        raise IntegrityError(
            f"release task manifest must contain {RELEASE_SUBTASK_COUNT} subtasks"
        )
    return tasks


def validate_task_manifest(
    task_manifest: Mapping[str, Any], expected_tasks: Sequence[TaskSpec] | None = None
) -> tuple[TaskSpec, ...]:
    if task_manifest.get("test_fixture") is True:
        tasks = task_specs_from_manifest(task_manifest)
        _fixture_task_manifest(task_manifest, tasks)
    else:
        tasks = validate_release_task_manifest(task_manifest)
    if expected_tasks is not None:
        expected_entries = [task.to_manifest_entry() for task in expected_tasks]
        actual_entries = [task.to_manifest_entry() for task in tasks]
        if actual_entries != expected_entries:
            raise IntegrityError("runtime task list differs from locked task manifest")
    return tasks


def inspect_artifact_inventory(
    store: ArtifactStore,
    task_manifest: Mapping[str, Any] | None = None,
) -> ArtifactInventoryReport:
    """Reject runtime artifacts that cannot be attributed to the locked tasks."""

    if task_manifest is None:
        _, task_manifest = store.load_manifests()
    tasks = validate_task_manifest(task_manifest)
    expected = {task.task_key: task for task in tasks}
    expected_stems = {
        task_artifact_filename(task_key).removesuffix(".json"): task_key
        for task_key in expected
    }
    orphans: list[str] = []
    corrupt: list[str] = []
    attempt_owners: dict[str, str] = {}

    if store.attempts_dir.exists():
        for task_dir in sorted(store.attempts_dir.iterdir()):
            relative_task_dir = str(task_dir.relative_to(store.run_dir))
            task_key = expected_stems.get(task_dir.name)
            if not task_dir.is_dir() or task_key is None:
                orphans.append(relative_task_dir)
                continue
            task = expected[task_key]
            for attempt_dir in sorted(task_dir.iterdir()):
                relative_attempt = str(attempt_dir.relative_to(store.run_dir))
                if not attempt_dir.is_dir():
                    orphans.append(relative_attempt)
                    continue
                attempt_path = attempt_dir / "attempt.json"
                if not attempt_path.is_file():
                    corrupt.append(relative_attempt + "/attempt.json")
                    continue
                try:
                    attempt = read_json(attempt_path)
                    attempt_id = str(attempt["attempt_id"])
                    if (
                        attempt_id != attempt_dir.name
                        or attempt.get("task_key") != task_key
                        or attempt.get("run_id") != store.run_id
                        or attempt.get("source_record_hash") != task.source_record_hash
                    ):
                        raise ValueError("attempt provenance mismatch")
                    if attempt_id in attempt_owners:
                        raise ValueError("duplicate attempt id")
                    attempt_owners[attempt_id] = task_key
                    trajectory_path = attempt_dir / "trajectory.jsonl"
                    expected_trajectory_hash = attempt.get("trajectory_sha256")
                    if expected_trajectory_hash is not None and (
                        not trajectory_path.is_file()
                        or file_sha256(trajectory_path) != expected_trajectory_hash
                    ):
                        raise ValueError("attempt trajectory hash mismatch")
                    if trajectory_path.exists():
                        expected_sequence = 1
                        with trajectory_path.open("r", encoding="utf-8") as handle:
                            for line in handle:
                                if not line.strip():
                                    continue
                                event = json.loads(line)
                                if (
                                    event.get("run_id") != store.run_id
                                    or event.get("task_key") != task_key
                                    or event.get("attempt_id") != attempt_id
                                    or event.get("sequence") != expected_sequence
                                ):
                                    raise ValueError("trajectory event provenance mismatch")
                                expected_sequence += 1
                except (KeyError, OSError, ValueError, json.JSONDecodeError):
                    corrupt.append(relative_attempt + "/attempt.json")

    if store.records_dir.exists():
        for path in sorted(store.records_dir.iterdir()):
            relative = str(path.relative_to(store.run_dir))
            if not path.is_file() or path.suffix != ".json":
                orphans.append(relative)
                continue
            try:
                task_key = read_task_key(path)
                if task_key not in expected or path != store.record_path(task_key):
                    raise KeyError("unrecognized task record")
                store.load_success(task_key)
            except KeyError:
                orphans.append(relative)
            except (IntegrityError, OSError, ValueError, json.JSONDecodeError):
                corrupt.append(relative)

    if store.judge_cache_dir.exists():
        for path in sorted(store.judge_cache_dir.iterdir()):
            relative = str(path.relative_to(store.run_dir))
            if not path.is_file() or path.suffix != ".json":
                orphans.append(relative)
                continue
            try:
                value = read_json(path)
                cache_key = value.get("cache_key")
                if (
                    not isinstance(cache_key, str)
                    or path.stem != cache_key
                    or canonical_sha256(value.get("key_payload")) != cache_key
                    or value.get("status") != "succeeded"
                    or value.get("parse_valid") is not True
                ):
                    raise ValueError("invalid judge cache provenance")
            except (OSError, ValueError, json.JSONDecodeError):
                corrupt.append(relative)

    if store.usage_dir.exists():
        allowed_usage = {"events.jsonl", "summary.json"}
        for path in sorted(store.usage_dir.iterdir()):
            relative = str(path.relative_to(store.run_dir))
            if not path.is_file() or path.name not in allowed_usage:
                orphans.append(relative)
                continue
            if path.name == "summary.json":
                try:
                    summary = read_json(path)
                    if summary.get("run_id") != store.run_id:
                        raise ValueError("usage summary run mismatch")
                except (OSError, ValueError, json.JSONDecodeError):
                    corrupt.append(relative)
                continue
            try:
                with path.open("r", encoding="utf-8") as handle:
                    for line_number, line in enumerate(handle, start=1):
                        if not line.strip():
                            continue
                        event = json.loads(line)
                        task_key = event.get("task_key")
                        attempt_id = event.get("attempt_id")
                        if event.get("run_id") != store.run_id:
                            raise ValueError("usage event run mismatch")
                        if task_key is not None and task_key not in expected:
                            raise ValueError("usage event has unknown task")
                        if attempt_id is not None and attempt_owners.get(str(attempt_id)) != task_key:
                            raise ValueError("usage event has unknown attempt")
                        if attempt_id is None and event.get("disposition_hint") is None:
                            raise ValueError("unscoped usage needs an explicit disposition")
            except (OSError, ValueError, json.JSONDecodeError):
                corrupt.append(relative)

    if store.indexes_dir.exists():
        allowed_indexes = {
            "artifacts.json",
            "tasks.json",
            "trajectories.json",
            "judge-cache.json",
            "usage-cost.json",
        }
        for path in sorted(store.indexes_dir.iterdir()):
            relative = str(path.relative_to(store.run_dir))
            if not path.is_file() or path.name not in allowed_indexes:
                orphans.append(relative)

    return ArtifactInventoryReport(
        orphan_artifacts=tuple(sorted(set(orphans))),
        corrupt_artifacts=tuple(sorted(set(corrupt))),
    )


def require_clean_artifact_inventory(
    store: ArtifactStore,
    task_manifest: Mapping[str, Any] | None = None,
) -> ArtifactInventoryReport:
    report = inspect_artifact_inventory(store, task_manifest)
    if not report.clean:
        raise IntegrityError(
            "runtime artifact inventory is not clean: "
            f"orphans={list(report.orphan_artifacts)}, "
            f"corrupt={list(report.corrupt_artifacts)}"
        )
    return report


def _validate_success_record(
    store: ArtifactStore,
    task: TaskSpec,
    record: Mapping[str, Any],
) -> None:
    if record.get("run_id") != store.run_id:
        raise IntegrityError(f"run id mismatch for {task.task_key}")
    if record.get("task_key") != task.task_key:
        raise IntegrityError(f"task key mismatch for {task.task_key}")
    if record.get("domain") != task.domain:
        raise IntegrityError(f"domain mismatch for {task.task_key}")
    if record.get("source_record_hash") != task.source_record_hash:
        raise IntegrityError(f"source hash mismatch for {task.task_key}")
    if tuple(record.get("completed_subtask_ids", [])) != task.subtask_ids:
        raise IntegrityError(f"subtask coverage mismatch for {task.task_key}")
    attempt_id = record.get("accepted_attempt_id")
    matching = [
        attempt
        for attempt in store.list_attempts(task.task_key)
        if attempt.get("attempt_id") == attempt_id
    ]
    if len(matching) != 1:
        raise IntegrityError(f"accepted attempt is missing for {task.task_key}")
    attempt = matching[0]
    if attempt.get("status") != TaskStatus.SUCCEEDED.value:
        raise IntegrityError(f"accepted attempt did not succeed for {task.task_key}")
    trajectory_path = Path(attempt["_attempt_dir"]) / "trajectory.jsonl"
    expected_hash = record.get("attempt_trajectory_sha256")
    if expected_hash is None:
        if trajectory_path.exists():
            raise IntegrityError(f"unexpected trajectory for {task.task_key}")
    elif not trajectory_path.exists() or file_sha256(trajectory_path) != expected_hash:
        raise IntegrityError(f"trajectory integrity check failed for {task.task_key}")


def audit_run(
    store: ArtifactStore,
    task_manifest: Mapping[str, Any] | None = None,
) -> CompletenessReport:
    if task_manifest is None:
        _, task_manifest = store.load_manifests()
    tasks = validate_task_manifest(task_manifest)
    expected_keys = {task.task_key for task in tasks}
    succeeded: list[str] = []
    failed_retryable: list[str] = []
    blocked: list[str] = []
    pending: list[str] = []
    running: list[str] = []
    invalid: list[str] = []

    for task in tasks:
        try:
            record = store.load_success(task.task_key)
            if record is not None:
                _validate_success_record(store, task, record)
                succeeded.append(task.task_key)
                continue
        except (IntegrityError, OSError, ValueError):
            invalid.append(task.task_key)
            continue

        try:
            attempts = store.list_attempts(task.task_key)
        except (OSError, ValueError):
            invalid.append(task.task_key)
            continue
        if not attempts:
            pending.append(task.task_key)
            continue
        latest_status = attempts[-1].get("status")
        if latest_status == TaskStatus.FAILED_RETRYABLE.value:
            failed_retryable.append(task.task_key)
        elif latest_status == TaskStatus.BLOCKED.value:
            blocked.append(task.task_key)
        elif latest_status == TaskStatus.RUNNING.value:
            running.append(task.task_key)
        else:
            # A succeeded attempt without its atomic success record, or an
            # interrupted/pending attempt, must be re-run rather than scored.
            pending.append(task.task_key)

    unexpected_records: list[str] = []
    for path in store.records_dir.glob("*.json"):
        try:
            task_key = read_task_key(path)
            if path != store.record_path(task_key):
                raise IntegrityError(f"record is stored under a non-canonical name: {path}")
            record = store.load_success(task_key)
        except Exception:
            unexpected_records.append(path.name)
            continue
        task_key = str(record.get("task_key", "")) if record else task_key
        if task_key not in expected_keys:
            unexpected_records.append(task_key or path.name)

    return CompletenessReport(
        expected=len(tasks),
        succeeded=tuple(sorted(succeeded)),
        failed_retryable=tuple(sorted(failed_retryable)),
        blocked=tuple(sorted(blocked)),
        pending=tuple(sorted(pending)),
        running=tuple(sorted(running)),
        invalid=tuple(sorted(invalid)),
        unexpected_records=tuple(sorted(unexpected_records)),
    )


def read_task_key(path: Path) -> str:
    # Kept separate to make corrupt/unexpected record handling explicit.
    import json

    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not value.get("task_key"):
        raise IntegrityError(f"record has no task_key: {path}")
    return str(value["task_key"])


def require_complete_run(
    store: ArtifactStore,
    task_manifest: Mapping[str, Any] | None = None,
) -> CompletenessReport:
    report = audit_run(store, task_manifest)
    if not report.eligible_for_scoring:
        counts = report.to_dict()["counts"]
        raise IntegrityError(
            "MemoryArena Public scoring is forbidden for an incomplete run: "
            + ", ".join(f"{key}={value}" for key, value in counts.items())
        )
    return report
