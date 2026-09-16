#!/usr/bin/env python3
"""Pinned, non-vendoring bootstrap for the public MemoryArena integration.

The module deliberately does not download benchmark datasets or alter the
upstream checkout.  It checks out the pinned code, validates an explicit data
revision, and writes run-scoped effective configs derived from immutable
official configs.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import unquote, urlsplit, urlunsplit


INTEGRATION_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = INTEGRATION_ROOT.parent.parent
DEFAULT_PINS_PATH = INTEGRATION_ROOT / "pins.json"
OVERLAY_ROOT = INTEGRATION_ROOT / "overlays"
SEARCH_RUNNER_IDS_PATH = INTEGRATION_ROOT / "upstream" / "search_runner_ids.json"
SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
BACKEND_RE = re.compile(r"^[A-Za-z0-9._-]+$")

EXPECTED_CODE_REVISION = "6cd9de14b71915e39ac742a20dc33785e14b6aab"
EXPECTED_PUBLIC_DATA_REVISION = "da1a37c8b19280e18627ca01cf368195a5e1d92e"
EXPECTED_SEARCH_RUNNER_IDS_SHA256 = (
    "1d1ff11bfc03020da90f194eeac7833eeb4b466341f509b776368f04a8cde2ce"
)
EXPECTED_AUXILIARY_PINS = {
    "shopping_product_db": (
        "ai-hyz/MemoryArena-product-db",
        "46120a5c931d04a47bd791965d757207b7372b62",
    ),
    "websearch_embeddings": (
        "joanna690/websearch-embeddings",
        "40b2422e641b46b903312c2e5b0c4ef9380f5352",
    ),
    "browsecomp_plus": (
        "Tevatron/browsecomp-plus",
        "144cff8e35b5eaef7e526346aa60774a9deb941f",
    ),
    "browsecomp_plus_corpus": (
        "Tevatron/browsecomp-plus-corpus",
        "b27b02bc3e45511b8b82a13e6f90ce761df726f6",
    ),
}
EXPECTED_OVERLAYS = {
    "overlays/bundled-shopping.picorer.json",
    "overlays/progressive-search.picorer.json",
    "overlays/group-travel.picorer.json",
    "overlays/formal-math.picorer.json",
    "overlays/formal-phys.picorer.json",
}
EXPECTED_TASK_SUITES = {
    "bundled_shopping": {
        "runner": "run_shopping.py",
        "hf_config": "bundled_shopping",
        "hf_split": "test",
        "expected_count": 150,
        "id_start": 0,
        "id_end": 149,
        "selection_mode": "all_hf_rows",
    },
    "progressive_search": {
        "runner": "run_search.py",
        "hf_config": "progressive_search",
        "hf_split": "test",
        "expected_count": 221,
        "id_start": 0,
        "id_end": 220,
        "selection_mode": "pinned_auxiliary_query_ids",
    },
    "group_travel_planner": {
        "runner": "run_travel.py",
        "hf_config": "group_travel_planner",
        "hf_split": "test",
        "expected_count": 270,
        "id_start": 1,
        "id_end": 270,
        "selection_mode": "runner_loads_full_split",
    },
    "formal_reasoning_math": {
        "runner": "run_math.py",
        "hf_config": "formal_reasoning_math",
        "hf_split": "test",
        "expected_count": 40,
        "id_start": 0,
        "id_end": 39,
        "selection_mode": "runner_loads_full_split",
    },
    "formal_reasoning_phys": {
        "runner": "run_math.py",
        "hf_config": "formal_reasoning_phys",
        "hf_split": "test",
        "expected_count": 20,
        "id_start": 0,
        "id_end": 19,
        "selection_mode": "runner_loads_full_split",
    },
}
EXPECTED_OVERLAY_LAYOUTS = {
    "bundled_shopping": {
        "base_config": "configs/web_shopping_configs/bm25.json",
        "memory_url_path": "memory.server_url",
        "output_paths": {"output.output_dir"},
    },
    "progressive_search": {
        "base_config": "configs/web_search_configs/search_task.json",
        "memory_url_path": "memory.memory_url",
        "output_paths": {"output.output_dir"},
    },
    "group_travel_planner": {
        "base_config": "configs/travel_planner_configs/bm25.json",
        "memory_url_path": "memory.server_url",
        "output_paths": {
            "output.output_dir",
            "output.log_dir",
            "output.global_csv",
        },
    },
    "formal_reasoning_math": {
        "base_config": "configs/formal_reasoning_configs/math_bm25.json",
        "memory_url_path": "memory.base_url",
        "output_paths": {"output.json_output_dir"},
    },
    "formal_reasoning_phys": {
        "base_config": "configs/formal_reasoning_configs/phys_text-embedding.json",
        "memory_url_path": "memory.base_url",
        "output_paths": {"output.json_output_dir"},
    },
}
EXPECTED_SUITES = set(EXPECTED_TASK_SUITES)
EXPECTED_OFFICIAL_EVALUATORS = {
    "bundled_shopping": "env/env_systems/web_shopping_env/compute_reward.py",
    "progressive_search": "env/env_systems/web_search_env/evaluate_with_openai.py",
    "group_travel_planner": "env/env_systems/travel_planner_env/eval.py",
    "formal_reasoning_math": "env/env_systems/formal_reasoning_env/eval.py",
    "formal_reasoning_phys": "env/env_systems/formal_reasoning_env/eval.py",
}

MEMORY_NAME_PATHS = {"memory.memory_system_name"}
MEMORY_URL_PATHS = {
    "memory.server_url",
    "memory.memory_url",
    "memory.base_url",
}
OUTPUT_PATHS = {
    "output.output_dir",
    "output.log_dir",
    "output.global_csv",
    "output.json_output_dir",
}
INFRA_ENDPOINT_PATHS = {
    "agent.base_url",
    "env.base_url",
    "env.env_server_url",
    "env.mcp_url",
    "env.env_config.base_url",
    "env.env_config.upstream_env_server_base",
}
TASK_SELECTION_PATHS = {
    "task_specific.task_category",
    "task_specific.task_file_limit",
    "task_specific.query_ids",
}
ALLOWED_OVERLAY_PATHS = (
    MEMORY_NAME_PATHS | MEMORY_URL_PATHS | OUTPUT_PATHS | INFRA_ENDPOINT_PATHS
)


class BoundaryError(RuntimeError):
    """Base error for a reproducibility or integration-boundary violation."""


class GitVerificationError(BoundaryError):
    """Raised when the upstream checkout is not the pinned clean checkout."""


class ConfigBoundaryError(BoundaryError):
    """Raised when an effective config would cross the mutation allowlist."""


def _read_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise BoundaryError(f"Cannot read JSON from {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise BoundaryError(f"Expected a JSON object in {path}")
    return value


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _resolve_inside(path: Path, root: Path, label: str) -> Path:
    resolved_root = root.resolve()
    resolved = path.resolve()
    if not _is_relative_to(resolved, resolved_root):
        raise BoundaryError(f"{label} escapes {resolved_root}: {resolved}")
    return resolved


def _require_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA1_RE.fullmatch(value):
        raise BoundaryError(f"{label} must be a lowercase 40-character Git SHA-1")
    return value


def validate_pins(pins: Mapping[str, Any]) -> None:
    if pins.get("schema_version") != 1:
        raise BoundaryError("Unsupported pins schema_version")

    code = pins.get("code")
    if not isinstance(code, Mapping):
        raise BoundaryError("pins.code must be an object")
    if code.get("repository") != "https://github.com/ZexueHe/MemoryArena.git":
        raise BoundaryError("pins.code.repository is not the official public upstream")
    code_revision = _require_sha(code.get("revision"), "pins.code.revision")
    if code_revision != EXPECTED_CODE_REVISION:
        raise BoundaryError(
            f"MemoryArena code revision must remain pinned to {EXPECTED_CODE_REVISION}"
        )
    if code.get("remote") != "origin":
        raise BoundaryError("pins.code.remote must be origin")

    data = pins.get("data")
    public_tasks = data.get("public_tasks") if isinstance(data, Mapping) else None
    if not isinstance(public_tasks, Mapping):
        raise BoundaryError("pins.data.public_tasks must be an object")
    if public_tasks.get("repo_id") != "ZexueHe/memoryarena":
        raise BoundaryError("Unexpected public task dataset")
    public_revision = _require_sha(
        public_tasks.get("revision"), "pins.data.public_tasks.revision"
    )
    if public_revision != EXPECTED_PUBLIC_DATA_REVISION:
        raise BoundaryError(
            "Public task data revision must remain pinned to "
            f"{EXPECTED_PUBLIC_DATA_REVISION}"
        )
    if public_tasks.get("expected_total_tasks") != 701:
        raise BoundaryError("Public task pin must declare exactly 701 tasks")

    auxiliary = data.get("auxiliary") if isinstance(data, Mapping) else None
    if not isinstance(auxiliary, Mapping) or set(auxiliary) != set(EXPECTED_AUXILIARY_PINS):
        raise BoundaryError("Auxiliary Hugging Face pins are incomplete")
    for name, entry in auxiliary.items():
        if not isinstance(entry, Mapping):
            raise BoundaryError(f"Invalid auxiliary pin: {name}")
        repo_id, expected_revision = EXPECTED_AUXILIARY_PINS[name]
        if entry.get("repo_id") != repo_id or entry.get("repo_type") != "dataset":
            raise BoundaryError(f"Unexpected auxiliary dataset pin: {name}")
        actual_revision = _require_sha(
            entry.get("revision"), f"pins.data.auxiliary.{name}.revision"
        )
        if actual_revision != expected_revision:
            raise BoundaryError(f"Unexpected auxiliary revision for {name}")

    overlays = pins.get("overlays")
    if (
        not isinstance(overlays, list)
        or len(overlays) != 5
        or set(overlays) != EXPECTED_OVERLAYS
    ):
        raise BoundaryError("Exactly five effective-config overlays are required")
    for relative in overlays:
        if not isinstance(relative, str):
            raise BoundaryError("Overlay paths must be strings")
        _resolve_inside(INTEGRATION_ROOT / relative, OVERLAY_ROOT, "Overlay path")

    official_execution = pins.get("official_execution")
    if not isinstance(official_execution, Mapping) or set(official_execution) != EXPECTED_SUITES:
        raise BoundaryError("Official runner/evaluator bindings are incomplete")
    for suite, expected_suite in EXPECTED_TASK_SUITES.items():
        binding = official_execution[suite]
        if not isinstance(binding, Mapping) or binding != {
            "runner": expected_suite["runner"],
            "evaluator": EXPECTED_OFFICIAL_EVALUATORS[suite],
        }:
            raise BoundaryError(f"Unexpected official runner/evaluator binding for {suite}")


def load_pins(path: Path = DEFAULT_PINS_PATH) -> dict[str, Any]:
    pins = _read_json(path)
    validate_pins(pins)
    return pins


def validate_task_manifest(
    manifest: Mapping[str, Any],
    pins: Mapping[str, Any],
    *,
    data_revision: str,
) -> None:
    """Validate the complete, pinned 701-task public selection."""

    _require_sha(data_revision, "data_revision")
    public_pin = pins["data"]["public_tasks"]
    if data_revision != public_pin["revision"]:
        raise BoundaryError(
            "Explicit data revision does not match pins.json: "
            f"{data_revision} != {public_pin['revision']}"
        )
    if manifest.get("schema_version") != 1:
        raise BoundaryError("Unsupported public task manifest schema_version")
    dataset = manifest.get("dataset")
    if not isinstance(dataset, Mapping):
        raise BoundaryError("Task manifest dataset metadata is missing")
    if dataset.get("repo_id") != public_pin["repo_id"]:
        raise BoundaryError("Task manifest dataset does not match pins.json")
    if dataset.get("revision") != data_revision:
        raise BoundaryError("Task manifest is not bound to the explicit data revision")

    suites = manifest.get("suites")
    if not isinstance(suites, Mapping) or set(suites) != EXPECTED_SUITES:
        raise BoundaryError("Task manifest must contain exactly the five public suites")

    total = 0
    for suite_name, suite in suites.items():
        if not isinstance(suite, Mapping):
            raise BoundaryError(f"Invalid task manifest suite: {suite_name}")
        expected_suite = EXPECTED_TASK_SUITES[suite_name]
        for field, expected_value in expected_suite.items():
            if suite.get(field) != expected_value:
                raise BoundaryError(
                    f"Public task manifest differs at {suite_name}.{field}: "
                    f"{suite.get(field)!r} != {expected_value!r}"
                )
        count = suite.get("expected_count")
        start = suite.get("id_start")
        end = suite.get("id_end")
        if not all(isinstance(item, int) and not isinstance(item, bool) for item in (count, start, end)):
            raise BoundaryError(f"Non-integer task range for {suite_name}")
        if count <= 0 or end < start or end - start + 1 != count:
            raise BoundaryError(f"Task range/count mismatch for {suite_name}")
        if suite.get("hf_split") != "test":
            raise BoundaryError(f"Only the official test split is allowed for {suite_name}")
        total += count

    if manifest.get("expected_total_tasks") != 701 or total != 701:
        raise BoundaryError(f"Public task manifest must resolve to 701 tasks, got {total}")
    if total != public_pin["expected_total_tasks"]:
        raise BoundaryError("Task manifest total does not match pins.json")


def load_task_manifest(
    pins: Mapping[str, Any],
    *,
    data_revision: str,
) -> tuple[dict[str, Any], Path]:
    relative = pins["data"]["public_tasks"]["manifest"]
    if relative != "overlays/public-task-manifest.json":
        raise BoundaryError("Unexpected public task manifest path")
    manifest_path = _resolve_inside(
        INTEGRATION_ROOT / relative,
        OVERLAY_ROOT,
        "Public task manifest",
    )
    manifest = _read_json(manifest_path)
    validate_task_manifest(manifest, pins, data_revision=data_revision)
    return manifest, manifest_path


def _canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return _sha256_bytes(encoded)


def search_runner_ids(path: Path = SEARCH_RUNNER_IDS_PATH) -> list[str]:
    """Load the exact runner IDs joined to the pinned public Search rows.

    The public dataset uses row ordinals 0..220, while ``run_search.py``
    consumes the unrelated BrowseComp IDs from the pinned auxiliary dataset.
    """

    descriptor = _read_json(path)
    manifest_hash = descriptor.get("manifest_sha256")
    unsigned = dict(descriptor)
    unsigned.pop("manifest_sha256", None)
    ordered = descriptor.get("ordered_ids")
    source = descriptor.get("source")
    if (
        descriptor.get("schema_version") != 1
        or descriptor.get("kind") != "memoryarena-public-search-runner-ids"
        or not isinstance(ordered, list)
        or len(ordered) != 221
        or any(not isinstance(item, str) or not item for item in ordered)
        or len(set(ordered)) != 221
        or not isinstance(source, Mapping)
        or source.get("repository") != "joanna690/websearch-embeddings"
        or source.get("revision")
        != EXPECTED_AUXILIARY_PINS["websearch_embeddings"][1]
        or descriptor.get("ordered_ids_sha256")
        != EXPECTED_SEARCH_RUNNER_IDS_SHA256
        or _canonical_sha256(ordered) != EXPECTED_SEARCH_RUNNER_IDS_SHA256
        or manifest_hash != _canonical_sha256(unsigned)
    ):
        raise BoundaryError("Pinned progressive-search runner ID descriptor is invalid")
    return list(ordered)


def task_ids(manifest: Mapping[str, Any], suite: str) -> list[int | str]:
    suites = manifest.get("suites")
    if not isinstance(suites, Mapping) or suite not in suites:
        raise BoundaryError(f"Unknown suite in task manifest: {suite}")
    if suite == "progressive_search":
        return search_runner_ids()
    entry = suites[suite]
    return list(range(entry["id_start"], entry["id_end"] + 1))


def _normalise_remote_url(value: str) -> str:
    raw = value.strip()
    parsed = urlsplit(raw)
    if parsed.scheme in {"http", "https"}:
        path = parsed.path.rstrip("/")
        if path.endswith(".git"):
            path = path[:-4]
        return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, "", ""))
    if parsed.scheme == "file":
        return Path(unquote(parsed.path)).resolve().as_uri().rstrip("/")
    if "://" not in raw and not raw.startswith("git@"):
        return str(Path(raw).expanduser().resolve()).rstrip("/")
    return raw.rstrip("/").removesuffix(".git")


def _run_git(
    args: Sequence[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    process = subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and process.returncode != 0:
        command = "git " + " ".join(args)
        detail = (process.stderr or process.stdout).strip()
        raise GitVerificationError(f"{command} failed: {detail}")
    return process


def _reject_vendored_checkout(checkout_dir: Path) -> Path:
    checkout = checkout_dir.expanduser().resolve()
    if _is_relative_to(checkout, PROJECT_ROOT):
        raise GitVerificationError(
            f"The upstream checkout must not be vendored under the project root {PROJECT_ROOT}"
        )
    return checkout


def _reject_source_run_dir(run_dir: Path) -> Path:
    resolved = run_dir.expanduser().resolve()
    if _is_relative_to(resolved, INTEGRATION_ROOT):
        raise ConfigBoundaryError(
            "Generated run artifacts must live outside integrations/memoryarena-public"
        )
    return resolved


def verify_checkout(
    checkout_dir: Path,
    *,
    repository: str,
    revision: str,
    require_clean: bool = True,
) -> dict[str, Any]:
    """Verify exact root, origin URL, detached SHA, and worktree cleanliness."""

    checkout = _reject_vendored_checkout(checkout_dir)
    _require_sha(revision, "code revision")
    if not checkout.is_dir():
        raise GitVerificationError(f"Checkout does not exist: {checkout}")

    inside = _run_git(["rev-parse", "--is-inside-work-tree"], cwd=checkout).stdout.strip()
    if inside != "true":
        raise GitVerificationError(f"Not a Git worktree: {checkout}")
    top_level = Path(
        _run_git(["rev-parse", "--show-toplevel"], cwd=checkout).stdout.strip()
    ).resolve()
    if top_level != checkout:
        raise GitVerificationError(f"Checkout path is not the Git worktree root: {checkout}")

    remote = _run_git(["remote", "get-url", "origin"], cwd=checkout).stdout.strip()
    if _normalise_remote_url(remote) != _normalise_remote_url(repository):
        raise GitVerificationError(
            f"origin URL mismatch: {_normalise_remote_url(remote)} != "
            f"{_normalise_remote_url(repository)}"
        )
    head = _run_git(["rev-parse", "HEAD"], cwd=checkout).stdout.strip()
    if head != revision:
        raise GitVerificationError(f"HEAD mismatch: {head} != {revision}")

    symbolic = _run_git(["symbolic-ref", "-q", "HEAD"], cwd=checkout, check=False)
    if symbolic.returncode == 0:
        raise GitVerificationError("Pinned upstream checkout must use detached HEAD")

    status = _run_git(
        ["status", "--porcelain=v1", "--untracked-files=all"], cwd=checkout
    ).stdout
    if require_clean and status.strip():
        raise GitVerificationError(
            "Pinned upstream checkout is dirty; refusing to continue:\n" + status.rstrip()
        )
    return {
        "path": str(checkout),
        "repository": repository,
        "revision": revision,
        "remote": remote,
        "detached": True,
        "clean": not bool(status.strip()),
    }


def checkout_upstream(
    checkout_dir: Path,
    *,
    repository: str,
    revision: str,
    offline: bool = False,
) -> dict[str, Any]:
    """Clone or update a checkout without resets, vendoring, or dirty-tree loss."""

    checkout = _reject_vendored_checkout(checkout_dir)
    _require_sha(revision, "code revision")

    if checkout.exists():
        if not checkout.is_dir():
            raise GitVerificationError(f"Checkout path is not a directory: {checkout}")
        # Verify identity and cleanliness before any fetch/checkout mutation.
        remote = _run_git(["remote", "get-url", "origin"], cwd=checkout).stdout.strip()
        if _normalise_remote_url(remote) != _normalise_remote_url(repository):
            raise GitVerificationError("Existing checkout has an unexpected origin URL")
        dirty = _run_git(
            ["status", "--porcelain=v1", "--untracked-files=all"], cwd=checkout
        ).stdout
        if dirty.strip():
            raise GitVerificationError(
                "Existing upstream checkout is dirty; no files were changed:\n" + dirty.rstrip()
            )
    else:
        if offline:
            raise GitVerificationError("Offline bootstrap requires an existing checkout")
        checkout.parent.mkdir(parents=True, exist_ok=True)
        _run_git(
            ["clone", "--no-checkout", "--origin", "origin", repository, str(checkout)]
        )

    if not offline:
        _run_git(["fetch", "--force", "--tags", "origin", revision], cwd=checkout)

    commit_check = _run_git(
        ["cat-file", "-e", f"{revision}^{{commit}}"], cwd=checkout, check=False
    )
    if commit_check.returncode != 0:
        raise GitVerificationError(
            f"Pinned revision {revision} is not available in the checkout"
        )

    head = _run_git(["rev-parse", "HEAD"], cwd=checkout, check=False)
    current_head = head.stdout.strip() if head.returncode == 0 else None
    detached = _run_git(["symbolic-ref", "-q", "HEAD"], cwd=checkout, check=False)
    if current_head != revision or detached.returncode == 0:
        _run_git(["checkout", "--detach", revision], cwd=checkout)

    return verify_checkout(
        checkout,
        repository=repository,
        revision=revision,
        require_clean=True,
    )


def _get_dotted_path(config: Mapping[str, Any], dotted: str) -> Any:
    current: Any = config
    for part in dotted.split("."):
        if not isinstance(current, Mapping) or part not in current:
            raise ConfigBoundaryError(f"Official config has no path {dotted!r}")
        current = current[part]
    return current


def _set_existing_dotted_path(config: dict[str, Any], dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    current: Any = config
    for part in parts[:-1]:
        if not isinstance(current, dict) or part not in current:
            raise ConfigBoundaryError(f"Official config has no path {dotted!r}")
        current = current[part]
    leaf = parts[-1]
    if not isinstance(current, dict) or leaf not in current:
        raise ConfigBoundaryError(f"Official config has no path {dotted!r}")
    current[leaf] = value


def _diff_paths(before: Any, after: Any, prefix: str = "") -> set[str]:
    if isinstance(before, Mapping) and isinstance(after, Mapping):
        changes: set[str] = set()
        keys = set(before) | set(after)
        for key in keys:
            child = f"{prefix}.{key}" if prefix else str(key)
            if key not in before or key not in after:
                changes.add(child)
            else:
                changes.update(_diff_paths(before[key], after[key], child))
        return changes
    if before != after:
        return {prefix}
    return set()


def _validate_endpoint(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ConfigBoundaryError(f"{label} must be a non-empty HTTP(S) URL")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ConfigBoundaryError(f"{label} must be an HTTP(S) endpoint")
    if parsed.username or parsed.password:
        raise ConfigBoundaryError(f"{label} must not contain credentials")
    try:
        _ = parsed.port
    except ValueError as exc:
        raise ConfigBoundaryError(f"{label} contains an invalid port") from exc
    return value.rstrip("/")


def _render_patch_value(
    path: str,
    value: Any,
    *,
    run_dir: Path,
    memory_backend: str,
    memory_url: str,
) -> Any:
    if path in MEMORY_NAME_PATHS:
        rendered = memory_backend if value == "${MEMORY_BACKEND}" else value
        if not isinstance(rendered, str) or not BACKEND_RE.fullmatch(rendered):
            raise ConfigBoundaryError("Invalid memory backend name")
        return rendered
    if path in MEMORY_URL_PATHS:
        rendered = memory_url if value == "${MEMORY_URL}" else value
        return _validate_endpoint(rendered, path)
    if path in INFRA_ENDPOINT_PATHS:
        if isinstance(value, str) and "${" in value:
            raise ConfigBoundaryError(f"Unknown placeholder in {path}: {value}")
        return _validate_endpoint(value, path)
    if path in OUTPUT_PATHS:
        if not isinstance(value, str):
            raise ConfigBoundaryError(f"{path} must be a path string")
        rendered = value.replace("${RUN_DIR}", str(run_dir))
        if "${" in rendered:
            raise ConfigBoundaryError(f"Unknown placeholder in {path}: {value}")
        candidate = Path(rendered)
        if not candidate.is_absolute():
            candidate = run_dir / candidate
        candidate = candidate.resolve()
        if not _is_relative_to(candidate, run_dir):
            raise ConfigBoundaryError(f"Output path escapes run_dir: {candidate}")
        return str(candidate)
    raise ConfigBoundaryError(f"Path is not in the overlay allowlist: {path}")


def _validate_formal_dataset_binding(
    config: Mapping[str, Any],
    suite_manifest: Mapping[str, Any],
    public_repo_id: str,
) -> None:
    expected = {
        "task_specific.dataset.hf_dataset": public_repo_id,
        "task_specific.dataset.hf_config": suite_manifest["hf_config"],
        "task_specific.dataset.hf_split": suite_manifest["hf_split"],
    }
    for path, value in expected.items():
        if _get_dotted_path(config, path) != value:
            raise ConfigBoundaryError(
                f"Official formal-reasoning data binding differs from the public manifest at {path}"
            )


def _validate_overlay_definition(overlay: Mapping[str, Any]) -> str:
    if set(overlay) != {
        "schema_version",
        "suite",
        "base_config",
        "patch",
        "task_selection",
    }:
        raise ConfigBoundaryError("Overlay has unexpected or missing top-level fields")
    if overlay.get("schema_version") != 1:
        raise ConfigBoundaryError("Unsupported overlay schema_version")
    suite = overlay.get("suite")
    if not isinstance(suite, str) or suite not in EXPECTED_OVERLAY_LAYOUTS:
        raise ConfigBoundaryError(f"Overlay references an unknown suite: {suite}")
    layout = EXPECTED_OVERLAY_LAYOUTS[suite]
    if overlay.get("base_config") != layout["base_config"]:
        raise ConfigBoundaryError(f"Overlay changes the official base config for {suite}")
    if overlay.get("task_selection") != {
        "source": "public-task-manifest",
        "mode": "complete",
    }:
        raise ConfigBoundaryError("Overlay must select the complete pinned public manifest")
    patch = overlay.get("patch")
    if not isinstance(patch, Mapping):
        raise ConfigBoundaryError("overlay.patch must be an object")
    expected_paths = {
        "memory.memory_system_name",
        layout["memory_url_path"],
        *layout["output_paths"],
    }
    if set(patch) != expected_paths:
        raise ConfigBoundaryError(
            f"Overlay patch fields differ from the fixed {suite} integration boundary"
        )
    if patch["memory.memory_system_name"] != "${MEMORY_BACKEND}":
        raise ConfigBoundaryError("Memory backend must use the runtime placeholder")
    if patch[layout["memory_url_path"]] != "${MEMORY_URL}":
        raise ConfigBoundaryError("Memory URL must use the runtime placeholder")
    for path in layout["output_paths"]:
        value = patch[path]
        if not isinstance(value, str) or not value.startswith("${RUN_DIR}/"):
            raise ConfigBoundaryError(f"{path} must be rooted at the run directory")
    return suite


def apply_overlay(
    base_config: Mapping[str, Any],
    overlay: Mapping[str, Any],
    task_manifest: Mapping[str, Any],
    *,
    run_dir: Path,
    memory_backend: str,
    memory_url: str,
    infra_overrides: Mapping[str, Mapping[str, str]] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Apply only allowlisted integration changes to an official config object."""

    run_root = _reject_source_run_dir(run_dir)
    suite = _validate_overlay_definition(overlay)
    suites = task_manifest.get("suites")
    if not isinstance(suites, Mapping) or suite not in suites:
        raise ConfigBoundaryError(f"Overlay references an unknown suite: {suite}")
    patch = overlay.get("patch")
    assert isinstance(patch, Mapping)

    effective = copy.deepcopy(dict(base_config))
    for path, value in patch.items():
        if path not in ALLOWED_OVERLAY_PATHS:
            raise ConfigBoundaryError(f"Forbidden config mutation: {path}")
        rendered = _render_patch_value(
            path,
            value,
            run_dir=run_root,
            memory_backend=memory_backend,
            memory_url=memory_url,
        )
        _set_existing_dotted_path(effective, path, rendered)

    scoped_infra_overrides = _validate_scoped_infra_overrides(infra_overrides or {})
    for path, value in scoped_infra_overrides.get(suite, {}).items():
        _set_existing_dotted_path(
            effective,
            path,
            value,
        )

    suite_manifest = suites[suite]
    if suite == "bundled_shopping":
        _set_existing_dotted_path(effective, "task_specific.task_category", "all")
        _set_existing_dotted_path(effective, "task_specific.task_file_limit", -1)
    elif suite == "progressive_search":
        _set_existing_dotted_path(
            effective,
            "task_specific.query_ids",
            [str(task_id) for task_id in task_ids(task_manifest, suite)],
        )
    elif suite in {"formal_reasoning_math", "formal_reasoning_phys"}:
        _validate_formal_dataset_binding(
            effective,
            suite_manifest,
            task_manifest["dataset"]["repo_id"],
        )
    elif suite != "group_travel_planner":
        raise ConfigBoundaryError(f"No complete-selection rule for suite {suite}")

    changed = _diff_paths(base_config, effective)
    forbidden = changed - ALLOWED_OVERLAY_PATHS - TASK_SELECTION_PATHS
    if forbidden:
        raise ConfigBoundaryError(
            "Effective config changes forbidden fields: " + ", ".join(sorted(forbidden))
        )
    return effective, sorted(changed)


def _atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def generate_effective_config(
    *,
    checkout_dir: Path,
    run_dir: Path,
    overlay_path: Path,
    pins: Mapping[str, Any],
    task_manifest: Mapping[str, Any],
    task_manifest_path: Path,
    data_revision: str,
    memory_backend: str,
    memory_url: str,
    infra_overrides: Mapping[str, Mapping[str, str]] | None = None,
) -> dict[str, Any]:
    """Read an official config and write its run-scoped effective derivative."""

    checkout = checkout_dir.resolve()
    run_root = _reject_source_run_dir(run_dir)
    overlay_file = _resolve_inside(overlay_path, OVERLAY_ROOT, "Overlay")
    overlay = _read_json(overlay_file)
    base_relative = overlay.get("base_config")
    if not isinstance(base_relative, str):
        raise ConfigBoundaryError("Overlay base_config must be a relative path")
    base_path = _resolve_inside(checkout / base_relative, checkout, "Official config")
    if not base_path.is_file():
        raise ConfigBoundaryError(f"Official base config does not exist: {base_path}")

    tracked = _run_git(
        ["ls-files", "--error-unmatch", base_relative], cwd=checkout, check=False
    )
    if tracked.returncode != 0:
        raise ConfigBoundaryError(f"Official base config is not tracked: {base_relative}")

    before_bytes = base_path.read_bytes()
    base_hash = _sha256_bytes(before_bytes)
    try:
        base_config = json.loads(before_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConfigBoundaryError(f"Invalid official JSON config: {base_path}") from exc
    if not isinstance(base_config, dict):
        raise ConfigBoundaryError("Official base config must contain a JSON object")

    effective, changed_paths = apply_overlay(
        base_config,
        overlay,
        task_manifest,
        run_dir=run_root,
        memory_backend=memory_backend,
        memory_url=memory_url,
        infra_overrides=infra_overrides,
    )
    if base_path.read_bytes() != before_bytes:
        raise ConfigBoundaryError("Official config changed while generating the effective config")

    suite = overlay["suite"]
    effective_path = _resolve_inside(
        run_root / "effective-configs" / f"{suite}.json",
        run_root,
        "Effective config",
    )
    _atomic_write_json(effective_path, effective)
    effective_hash = _sha256_file(effective_path)
    suite_manifest = task_manifest["suites"][suite]
    provenance = {
        "schema_version": 1,
        "suite": suite,
        "code_revision": pins["code"]["revision"],
        "data_revision": data_revision,
        "base_config": base_relative,
        "base_config_sha256": base_hash,
        "effective_config": str(effective_path.relative_to(run_root)),
        "effective_config_sha256": effective_hash,
        "overlay": str(overlay_file.relative_to(INTEGRATION_ROOT)),
        "overlay_sha256": _sha256_file(overlay_file),
        "public_task_manifest": str(task_manifest_path.relative_to(INTEGRATION_ROOT)),
        "public_task_manifest_sha256": _sha256_file(task_manifest_path),
        "task_selection": {
            "hf_config": suite_manifest["hf_config"],
            "hf_split": suite_manifest["hf_split"],
            "expected_count": suite_manifest["expected_count"],
            "id_start": suite_manifest["id_start"],
            "id_end": suite_manifest["id_end"],
        },
        "changed_paths": changed_paths,
        "official_config_unchanged": True,
        "evaluator_policy": "official_only",
    }
    if suite == "progressive_search":
        provenance["task_selection"]["runner_ids_descriptor"] = str(
            SEARCH_RUNNER_IDS_PATH.relative_to(INTEGRATION_ROOT)
        )
        provenance["task_selection"]["runner_ids_descriptor_sha256"] = (
            _sha256_file(SEARCH_RUNNER_IDS_PATH)
        )
        provenance["task_selection"]["ordered_runner_ids_sha256"] = (
            EXPECTED_SEARCH_RUNNER_IDS_SHA256
        )
    provenance_path = _resolve_inside(
        run_root / "effective-configs" / f"{suite}.manifest.json",
        run_root,
        "Effective config manifest",
    )
    _atomic_write_json(provenance_path, provenance)
    return {
        "suite": suite,
        "config": str(effective_path),
        "manifest": str(provenance_path),
        "expected_task_count": suite_manifest["expected_count"],
        "changed_paths": changed_paths,
    }


def _validate_scoped_infra_overrides(
    overrides: Mapping[str, Mapping[str, str]],
) -> dict[str, dict[str, str]]:
    validated: dict[str, dict[str, str]] = {}
    for suite, endpoints in overrides.items():
        if suite not in EXPECTED_SUITES:
            raise ConfigBoundaryError(f"Unknown infrastructure override suite: {suite}")
        if not isinstance(endpoints, Mapping):
            raise ConfigBoundaryError(
                f"Infrastructure overrides for {suite} must map dotted paths to URLs"
            )
        selected: dict[str, str] = {}
        for path, value in endpoints.items():
            if path not in INFRA_ENDPOINT_PATHS:
                raise ConfigBoundaryError(
                    f"Not an allowed infrastructure endpoint for {suite}: {path}"
                )
            if path in selected:
                raise ConfigBoundaryError(
                    f"Duplicate infrastructure override: {suite}:{path}"
                )
            selected[path] = _validate_endpoint(value, f"{suite}:{path}")
        validated[suite] = selected
    return validated


def _parse_infra_overrides(items: Iterable[str]) -> dict[str, dict[str, str]]:
    parsed: dict[str, dict[str, str]] = {}
    for item in items:
        if "=" not in item:
            raise ConfigBoundaryError(
                f"Infrastructure override must be SUITE:DOTTED_PATH=URL: {item}"
            )
        target, value = item.split("=", 1)
        if ":" not in target:
            raise ConfigBoundaryError(
                "Infrastructure override must explicitly select one suite as "
                f"SUITE:DOTTED_PATH=URL: {item}"
            )
        suite, path = target.split(":", 1)
        if not suite or not path:
            raise ConfigBoundaryError(
                f"Infrastructure override must be SUITE:DOTTED_PATH=URL: {item}"
            )
        endpoints = parsed.setdefault(suite, {})
        if path in endpoints:
            raise ConfigBoundaryError(
                f"Duplicate infrastructure override: {suite}:{path}"
            )
        endpoints[path] = value
    return _validate_scoped_infra_overrides(parsed)


def bootstrap(
    *,
    checkout_dir: Path,
    run_dir: Path,
    data_revision: str,
    pins_path: Path = DEFAULT_PINS_PATH,
    memory_backend: str | None = None,
    memory_url: str | None = None,
    infra_overrides: Mapping[str, Mapping[str, str]] | None = None,
    offline: bool = False,
) -> dict[str, Any]:
    """Create/verify the pinned checkout and five run-scoped effective configs."""

    scoped_infra_overrides = _validate_scoped_infra_overrides(
        infra_overrides or {}
    )
    pins = load_pins(pins_path)
    manifest, manifest_path = load_task_manifest(pins, data_revision=data_revision)
    run_root = _reject_source_run_dir(run_dir)
    checkout_target = _reject_vendored_checkout(checkout_dir)
    if _is_relative_to(run_root, checkout_target) or _is_relative_to(
        checkout_target, run_root
    ):
        raise BoundaryError("run_dir and the immutable upstream checkout must not overlap")

    checkout_result = checkout_upstream(
        checkout_target,
        repository=pins["code"]["repository"],
        revision=pins["code"]["revision"],
        offline=offline,
    )
    run_root.mkdir(parents=True, exist_ok=True)

    selected_overlays = [INTEGRATION_ROOT / item for item in pins["overlays"]]
    resolved_expected = {
        (INTEGRATION_ROOT / item).resolve() for item in pins["overlays"]
    }
    resolved_selected = {Path(item).resolve() for item in selected_overlays}
    if len(selected_overlays) != 5 or resolved_selected != resolved_expected:
        raise BoundaryError("Bootstrap must materialize all five pinned suite overlays")
    selected_backend = memory_backend or pins["adapter"]["memory_system_name"]
    selected_url = memory_url or pins["adapter"]["memory_url"]

    effective_configs = []
    for overlay_path in selected_overlays:
        effective_configs.append(
            generate_effective_config(
                checkout_dir=Path(checkout_result["path"]),
                run_dir=run_root,
                overlay_path=overlay_path,
                pins=pins,
                task_manifest=manifest,
                task_manifest_path=manifest_path,
                data_revision=data_revision,
                memory_backend=selected_backend,
                memory_url=selected_url,
                infra_overrides=scoped_infra_overrides,
            )
        )

    # Effective configs are outside the checkout; verify the source stayed exact.
    verify_checkout(
        Path(checkout_result["path"]),
        repository=pins["code"]["repository"],
        revision=pins["code"]["revision"],
        require_clean=True,
    )
    result = {
        "schema_version": 1,
        "benchmark": pins["benchmark"],
        "checkout": checkout_result,
        "pins_sha256": _sha256_file(pins_path),
        "code_revision": pins["code"]["revision"],
        "data": {
            "public_tasks": pins["data"]["public_tasks"],
            "auxiliary": pins["data"]["auxiliary"],
            "unversioned_external_assets": pins["data"]["unversioned_external_assets"],
        },
        "public_task_manifest_sha256": _sha256_file(manifest_path),
        "expected_total_tasks": 701,
        "memory_backend": selected_backend,
        "memory_url": _validate_endpoint(selected_url, "memory_url"),
        "effective_configs": effective_configs,
        "official_evaluators_modified": False,
    }
    bootstrap_manifest = _resolve_inside(
        run_root / "bootstrap-manifest.json", run_root, "Bootstrap manifest"
    )
    _atomic_write_json(bootstrap_manifest, result)
    return result


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Bootstrap a pinned, immutable MemoryArena Public checkout."
    )
    parser.add_argument("--checkout-dir", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument(
        "--data-revision",
        required=True,
        help="Required explicit ZexueHe/memoryarena revision; must match pins.json.",
    )
    parser.add_argument("--pins", type=Path, default=DEFAULT_PINS_PATH)
    parser.add_argument("--memory-backend", default=None)
    parser.add_argument("--memory-url", default=None)
    parser.add_argument(
        "--infra-endpoint",
        action="append",
        default=[],
        metavar="SUITE:DOTTED_PATH=URL",
        help=(
            "Override one allowlisted infrastructure endpoint on one explicit suite; "
            "repeat for additional suite/path pairs."
        ),
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Do not fetch; require the exact revision to exist locally.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        infra = _parse_infra_overrides(args.infra_endpoint)
        result = bootstrap(
            checkout_dir=args.checkout_dir,
            run_dir=args.run_dir,
            data_revision=args.data_revision,
            pins_path=args.pins,
            memory_backend=args.memory_backend,
            memory_url=args.memory_url,
            infra_overrides=infra,
            offline=args.offline,
        )
    except BoundaryError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
