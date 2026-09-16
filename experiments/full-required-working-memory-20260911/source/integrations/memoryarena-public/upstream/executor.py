from __future__ import annotations

import contextlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse

from runtime.artifacts import (
    AttemptHandle,
    canonical_sha256,
    file_sha256,
    read_json,
    write_json_atomic,
)
from runtime.integrity import IntegrityError
from runtime.models import AttemptContext, TaskExecutionResult, TaskSpec
from runtime.retry import ProviderRequestError

from .assets import verify_local_asset_lock
from .audit_proxy import MemoryAuditProxy, validate_lifecycle
from .contracts import (
    OFFICIAL_CODE_REVISION,
    OFFICIAL_REPOSITORY,
    PUBLIC_DATA_REVISION,
    RELEASE_ID,
    SUITE_CONTRACTS,
    UpstreamContractError,
    UpstreamExecutionError,
)
from .manifest import validate_official_locked_task_manifest


_ENV = {
    "checkout": "MEMORYARENA_PUBLIC_CHECKOUT",
    "data_root": "MEMORYARENA_PUBLIC_DATA_ROOT",
    "task_manifest": "MEMORYARENA_PUBLIC_TASK_MANIFEST",
    "asset_lock": "MEMORYARENA_PUBLIC_ASSET_LOCK",
    "config_dir": "MEMORYARENA_PUBLIC_CONFIG_DIR",
    "picorer_root": "MEMORYARENA_PICORER_ROOT",
}
_MEMORY_URL_PATHS = {
    "bundled_shopping": ("memory", "server_url"),
    "progressive_search": ("memory", "memory_url"),
    "group_travel_planner": ("memory", "server_url"),
    "formal_reasoning_math": ("memory", "base_url"),
    "formal_reasoning_phys": ("memory", "base_url"),
}
_OUTPUT_PATHS = {
    "bundled_shopping": (("output", "output_dir"),),
    "progressive_search": (("output", "output_dir"),),
    "group_travel_planner": (
        ("output", "output_dir"),
        ("output", "log_dir"),
        ("output", "global_csv"),
    ),
    "formal_reasoning_math": (("output", "json_output_dir"),),
    "formal_reasoning_phys": (("output", "json_output_dir"),),
}
_PROVIDER_URL_PATHS = {
    "bundled_shopping": (("agent", "base_url"),),
    "progressive_search": (),
    "group_travel_planner": (("agent", "base_url"),),
    "formal_reasoning_math": (
        ("agent", "base_url"),
        ("env", "env_config", "base_url"),
    ),
    "formal_reasoning_phys": (
        ("agent", "base_url"),
        ("env", "env_config", "base_url"),
    ),
}

_SEAM_BUNDLE_FILES = (
    "__init__.py",
    "assets.py",
    "audit_proxy.py",
    "contracts.py",
    "evaluator.py",
    "executor.py",
    "hf_source_manifests.json",
    "hydrate.py",
    "judge_proxy.py",
    "manifest.py",
    "prepare.py",
    "search_runner_ids.json",
    "worker.py",
)


def production_seam_identity() -> dict[str, Any]:
    root = Path(__file__).resolve().parent
    files = [
        {"path": name, "sha256": file_sha256(root / name)}
        for name in _SEAM_BUNDLE_FILES
    ]
    return {
        "schema_version": 1,
        "kind": "memoryarena-public-production-seam",
        "files": files,
        "bundle_sha256": canonical_sha256(files),
    }


PRODUCTION_SEAM_BUNDLE_SHA256 = production_seam_identity()["bundle_sha256"]


def _assert_production_seam_unchanged() -> dict[str, Any]:
    identity = production_seam_identity()
    if identity["bundle_sha256"] != PRODUCTION_SEAM_BUNDLE_SHA256:
        raise IntegrityError("MemoryArena production seam changed during this run")
    return identity


@dataclass(frozen=True)
class ProductionSettings:
    checkout: Path
    data_root: Path
    task_manifest: Path
    asset_lock: Path
    config_dir: Path
    picorer_root: Path
    picorer_data_dir: Path
    python: str
    worker_timeout_seconds: float
    provider_proxy_url: str

    @classmethod
    def from_environment(cls) -> "ProductionSettings":
        missing = [name for name in _ENV.values() if not os.environ.get(name)]
        if not os.environ.get("PICORER_DATA_DIR"):
            missing.append("PICORER_DATA_DIR")
        if not os.environ.get("MEMORYARENA_PUBLIC_PROVIDER_PROXY_URL"):
            missing.append("MEMORYARENA_PUBLIC_PROVIDER_PROXY_URL")
        if missing:
            raise UpstreamExecutionError(
                "missing production executor environment: " + ", ".join(sorted(missing))
            )
        try:
            timeout = float(os.environ.get("MEMORYARENA_PUBLIC_WORKER_TIMEOUT", "14400"))
        except ValueError as error:
            raise UpstreamExecutionError("invalid MEMORYARENA_PUBLIC_WORKER_TIMEOUT") from error
        if timeout <= 0:
            raise UpstreamExecutionError("worker timeout must be positive")
        provider_url = os.environ["MEMORYARENA_PUBLIC_PROVIDER_PROXY_URL"].rstrip("/")
        parsed_provider = urlparse(provider_url)
        if (
            parsed_provider.scheme not in {"http", "https"}
            or not parsed_provider.hostname
            or parsed_provider.username
            or parsed_provider.password
        ):
            raise UpstreamExecutionError("invalid MEMORYARENA_PUBLIC_PROVIDER_PROXY_URL")
        return cls(
            checkout=Path(os.environ[_ENV["checkout"]]).resolve(),
            data_root=Path(os.environ[_ENV["data_root"]]).resolve(),
            task_manifest=Path(os.environ[_ENV["task_manifest"]]).resolve(),
            asset_lock=Path(os.environ[_ENV["asset_lock"]]).resolve(),
            config_dir=Path(os.environ[_ENV["config_dir"]]).resolve(),
            picorer_root=Path(os.environ[_ENV["picorer_root"]]).resolve(),
            picorer_data_dir=Path(os.environ["PICORER_DATA_DIR"]).resolve(),
            python=os.environ.get("MEMORYARENA_PUBLIC_PYTHON", sys.executable),
            worker_timeout_seconds=timeout,
            provider_proxy_url=provider_url,
        )


@dataclass(frozen=True)
class _ReleaseState:
    manifest: Mapping[str, Any]
    tasks: Mapping[str, TaskSpec]
    records: Mapping[str, Mapping[str, Any]]
    search_task_data: Path


_STATE_LOCK = threading.Lock()
_STATE_CACHE: dict[tuple[str, ...], _ReleaseState] = {}


def _run_git(checkout: Path, args: Sequence[str]) -> str:
    process = subprocess.run(
        ["git", "-C", os.fspath(checkout), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if process.returncode != 0:
        raise UpstreamExecutionError(
            f"git {' '.join(args)} failed: {process.stderr.strip()[:1000]}"
        )
    return process.stdout.strip()


def _canonical_remote(value: str) -> str:
    remote = value.strip().removesuffix("/").removesuffix(".git")
    if remote.startswith("git@github.com:"):
        remote = "https://github.com/" + remote.removeprefix("git@github.com:")
    return remote.casefold()


def _verify_checkout(checkout: Path) -> None:
    if not (checkout / ".git").exists():
        raise UpstreamExecutionError(f"official checkout is not a Git worktree: {checkout}")
    if _canonical_remote(_run_git(checkout, ["remote", "get-url", "origin"])) != _canonical_remote(
        OFFICIAL_REPOSITORY
    ):
        raise UpstreamExecutionError("official checkout origin mismatch")
    if _run_git(checkout, ["rev-parse", "HEAD"]) != OFFICIAL_CODE_REVISION:
        raise UpstreamExecutionError("official checkout HEAD mismatch")
    if _run_git(checkout, ["status", "--porcelain", "--untracked-files=no"]):
        raise UpstreamExecutionError("official tracked checkout files are dirty")
    dotenv_candidates = sorted(
        path
        for path in checkout.rglob(".env*")
        if ".git" not in path.relative_to(checkout).parts
        and (path.name == ".env" or path.name.startswith(".env."))
    )
    if dotenv_candidates:
        raise UpstreamExecutionError(
            "official checkout contains dotenv input that could override the locked "
            f"provider/metering endpoint: {dotenv_candidates[0]}"
        )


def _read_source_records(data_root: Path) -> dict[str, Mapping[str, Any]]:
    records: dict[str, Mapping[str, Any]] = {}
    for suite, contract in SUITE_CONTRACTS.items():
        path = contract.data_path(data_root)
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        raise IntegrityError(f"blank pinned source line: {path}")
                    row = json.loads(line)
                    key = f"{suite}/{int(row['id']):03d}"
                    if key in records:
                        raise IntegrityError(f"duplicate pinned source task: {key}")
                    records[key] = row
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            raise IntegrityError(f"cannot load pinned source records {path}: {error}") from error
    return records


def _search_task_path(asset_lock: Mapping[str, Any], checkout: Path) -> Path:
    assets = asset_lock.get("assets")
    if not isinstance(assets, Mapping) or not isinstance(assets.get("search_task_data"), Mapping):
        raise IntegrityError("local asset lock lacks search_task_data")
    relative = assets["search_task_data"].get("path")
    if not isinstance(relative, str) or not relative:
        raise IntegrityError("local asset lock search_task_data path is invalid")
    path = (checkout / relative).resolve()
    try:
        path.relative_to(checkout.resolve())
    except ValueError as error:
        raise IntegrityError("local asset lock search_task_data escapes checkout") from error
    return path


def _load_release_state(settings: ProductionSettings) -> _ReleaseState:
    key = (
        os.fspath(settings.checkout),
        os.fspath(settings.data_root),
        os.fspath(settings.task_manifest),
        os.fspath(settings.asset_lock),
    )
    with _STATE_LOCK:
        existing = _STATE_CACHE.get(key)
        if existing is not None:
            return existing
        _verify_checkout(settings.checkout)
        try:
            asset_document = verify_local_asset_lock(
                settings.asset_lock, checkout=settings.checkout
            )
        except UpstreamContractError:
            raise
        except Exception as error:
            raise IntegrityError(f"local asset verification failed: {error}") from error
        search_task_data = _search_task_path(asset_document, settings.checkout)
        manifest = read_json(settings.task_manifest)
        tasks = validate_official_locked_task_manifest(
            manifest,
            data_root=settings.data_root,
            search_task_data_path=search_task_data,
        )
        if manifest.get("local_asset_manifest_sha256") != asset_document.get(
            "manifest_sha256"
        ):
            raise IntegrityError("task manifest references another local asset lock")
        records = _read_source_records(settings.data_root)
        state = _ReleaseState(
            manifest=manifest,
            tasks={task.task_key: task for task in tasks},
            records=records,
            search_task_data=search_task_data,
        )
        _STATE_CACHE[key] = state
        return state


def _verify_runtime_manifest(
    artifacts: AttemptHandle,
    settings: ProductionSettings,
    state: _ReleaseState,
    context: AttemptContext,
) -> Mapping[str, Any]:
    """Bind executor environment to the locked runtime/source manifests."""

    try:
        run_manifest, task_manifest = artifacts.store.load_manifests()
    except Exception as error:
        raise IntegrityError(f"cannot load locked runtime manifests: {error}") from error
    infrastructure = run_manifest.get("infrastructure")
    models = run_manifest.get("models")
    picorer_source = run_manifest.get("picorer_source")
    effective_configs = run_manifest.get("effective_configs")
    if (
        run_manifest.get("run_id") != context.run_id
        or run_manifest.get("release_id") != RELEASE_ID
        or run_manifest.get("official_code_revision") != OFFICIAL_CODE_REVISION
        or run_manifest.get("official_data_revision") != PUBLIC_DATA_REVISION
        or run_manifest.get("task_manifest_sha256")
        != state.manifest.get("manifest_sha256")
        or task_manifest.get("manifest_sha256")
        != state.manifest.get("manifest_sha256")
        or not isinstance(infrastructure, Mapping)
        or str(infrastructure.get("provider_proxy_url", "")).rstrip("/")
        != settings.provider_proxy_url
        or not isinstance(models, Mapping)
        or not isinstance(models.get("picorer_retrieval"), str)
        or not models.get("picorer_retrieval")
        or not isinstance(models.get("embedding_model"), str)
        or not models.get("embedding_model")
        or not isinstance(picorer_source, Mapping)
        or picorer_source.get("clean_worktree") is not True
        or not isinstance(effective_configs, Mapping)
        or set(effective_configs) != set(SUITE_CONTRACTS)
        or any(
            not isinstance(effective_configs.get(suite), Mapping)
            for suite in SUITE_CONTRACTS
        )
    ):
        raise IntegrityError(
            "runtime manifest is not bound to this official release, task manifest, "
            "Picorer models, and provider proxy"
        )
    for environment_name, model_key in (
        ("MEMORYARENA_PICORER_RETRIEVAL_MODEL", "picorer_retrieval"),
        ("MEMORYARENA_PICORER_EMBEDDING_MODEL", "embedding_model"),
    ):
        supplied = os.environ.get(environment_name)
        if supplied is not None and supplied != models[model_key]:
            raise IntegrityError(
                f"{environment_name} differs from the SHA-locked run manifest"
            )
    if not (settings.picorer_root / ".git").exists():
        raise IntegrityError("MEMORYARENA_PICORER_ROOT is not a Picorer Git worktree")
    try:
        top_level = Path(
            _run_git(settings.picorer_root, ["rev-parse", "--show-toplevel"])
        ).resolve()
        current_revision = _run_git(settings.picorer_root, ["rev-parse", "HEAD"])
        current_remote = _run_git(
            settings.picorer_root, ["remote", "get-url", "origin"]
        )
        current_status = _run_git(
            settings.picorer_root,
            ["status", "--porcelain=v1", "--untracked-files=all"],
        )
    except UpstreamExecutionError as error:
        raise IntegrityError(f"cannot verify Picorer source identity: {error}") from error
    if (
        top_level != settings.picorer_root
        or current_revision != picorer_source.get("revision")
        or _canonical_remote(current_remote)
        != _canonical_remote(str(picorer_source.get("repository", "")))
        or current_status
    ):
        raise IntegrityError(
            "Picorer source differs from the clean Git identity locked in the run manifest"
        )
    return run_manifest


def _nested_get(value: Mapping[str, Any], path: Sequence[str]) -> Any:
    current: Any = value
    for part in path:
        if not isinstance(current, Mapping) or part not in current:
            raise IntegrityError(f"effective config lacks {'.'.join(path)}")
        current = current[part]
    return current


def _nested_set(value: dict[str, Any], path: Sequence[str], replacement: Any) -> None:
    current: Any = value
    for part in path[:-1]:
        if not isinstance(current, dict) or part not in current:
            raise IntegrityError(f"effective config lacks {'.'.join(path)}")
        current = current[part]
    if not isinstance(current, dict) or path[-1] not in current:
        raise IntegrityError(f"effective config lacks {'.'.join(path)}")
    current[path[-1]] = replacement


def _validate_gateway_url(value: Any) -> str:
    if not isinstance(value, str):
        raise IntegrityError("effective Picorer URL is not a string")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise IntegrityError("effective Picorer URL is invalid")
    if parsed.username or parsed.password:
        raise IntegrityError("effective Picorer URL contains credentials")
    return value.rstrip("/")


def _verify_effective_config_lock(
    source_path: Path,
    provenance_path: Path,
    config_lock: Mapping[str, Any],
) -> None:
    if (
        config_lock.get("effective_config_sha256") != file_sha256(source_path)
        or config_lock.get("provenance_sha256") != file_sha256(provenance_path)
    ):
        raise IntegrityError("effective config differs from locked run manifest")


def _prepare_attempt_config(
    settings: ProductionSettings,
    task: TaskSpec,
    context: AttemptContext,
    *,
    memory_proxy_url: str,
    config_lock: Mapping[str, Any],
) -> tuple[Path, str, tuple[str, ...]]:
    contract = SUITE_CONTRACTS[task.domain]
    source_path = settings.config_dir / contract.effective_config_name
    provenance_path = settings.config_dir / f"{task.domain}.manifest.json"
    try:
        source = read_json(source_path)
        provenance = read_json(provenance_path)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise IntegrityError(f"cannot load bootstrapped effective config: {error}") from error
    try:
        _verify_effective_config_lock(source_path, provenance_path, config_lock)
    except IntegrityError as error:
        raise IntegrityError(f"{error}: {task.domain}") from error
    if (
        provenance.get("suite") != task.domain
        or provenance.get("code_revision") != OFFICIAL_CODE_REVISION
        or provenance.get("data_revision") != PUBLIC_DATA_REVISION
        or provenance.get("effective_config_sha256") != file_sha256(source_path)
        or provenance.get("official_config_unchanged") is not True
        or provenance.get("evaluator_policy") != "official_only"
    ):
        raise IntegrityError(f"effective config provenance mismatch: {task.domain}")
    memory = source.get("memory")
    if not isinstance(memory, Mapping) or memory.get("memory_system_name") != "picorer":
        raise IntegrityError("effective config does not select the picorer backend")
    gateway_url = _validate_gateway_url(_nested_get(source, _MEMORY_URL_PATHS[task.domain]))
    attempt = json.loads(json.dumps(source))
    changed: list[str] = []
    _nested_set(attempt, _MEMORY_URL_PATHS[task.domain], memory_proxy_url)
    changed.append(".".join(_MEMORY_URL_PATHS[task.domain]))
    for provider_path in _PROVIDER_URL_PATHS[task.domain]:
        # Provider routing is a pure infrastructure mutation.  Bind every
        # official agent/inline-judge endpoint to the SHA-locked external
        # metering proxy without changing the detached checkout or source
        # effective config.
        _nested_set(attempt, provider_path, settings.provider_proxy_url)
        changed.append(".".join(provider_path))
    if task.domain == "bundled_shopping":
        # The official runner resolves its relative env-id cache underneath the
        # per-attempt output directory.  Our task-group checkpointing therefore
        # made every task call /create and reload the 1.18M-product WebShop
        # index.  Keep the official reuse/reset behavior, but give all serial
        # shopping tasks in this run one wrapper-owned cache file.
        run_root = context.attempt_dir.parents[2]
        cache_path = run_root / "upstream-shared" / "webshop-env-id.json"
        cache_config_path = ("env", "env_config", "env_id_cache_file")
        _nested_set(attempt, cache_config_path, os.fspath(cache_path))
        changed.append(".".join(cache_config_path))
    official_root = context.attempt_dir / "upstream" / "official"
    for path in _OUTPUT_PATHS[task.domain]:
        suffix = path[-1]
        output_value = (
            os.fspath(official_root / "global.csv")
            if suffix == "global_csv"
            else (
                os.fspath(official_root / "logs")
                if suffix == "log_dir"
                else os.fspath(official_root)
            )
        )
        _nested_set(attempt, path, output_value)
        changed.append(".".join(path))
    if task.domain == "progressive_search":
        query_path = ("task_specific", "query_ids")
        _nested_set(attempt, query_path, [str(task.metadata["official_query_id"])])
        changed.append(".".join(query_path))
    config_path = context.attempt_dir / "upstream" / "attempt-config.json"
    write_json_atomic(config_path, attempt)
    write_json_atomic(
        context.attempt_dir / "upstream" / "attempt-config.provenance.json",
        {
            "schema_version": 1,
            "source": os.fspath(source_path),
            "source_sha256": file_sha256(source_path),
            "source_manifest": os.fspath(provenance_path),
            "source_manifest_sha256": file_sha256(provenance_path),
            "attempt_sha256": file_sha256(config_path),
            "changed_paths": sorted(changed),
            "memory_scope": context.memory_scope,
            "task_key": task.task_key,
        },
    )
    return config_path, gateway_url, tuple(sorted(changed))


def _provider_error(text: str, *, stage: str) -> ProviderRequestError | None:
    lower = text.casefold()
    status_match = re.search(
        r"(?:status(?:_code)?|http(?:\s+status)?|code)[\"']?\s*[:= ]+\s*(\d{3})\b",
        lower,
    )
    contextual_status = int(status_match.group(1)) if status_match else None
    if contextual_status == 429 or re.search(r"rate.?limit", lower):
        return ProviderRequestError(text[-2000:] or "provider rate limit", status_code=429, stage=stage)
    if contextual_status == 408 or re.search(r"\btimeout\b|timed out|deadline exceeded", lower):
        return ProviderRequestError(text[-2000:] or "provider timeout", status_code=408, stage=stage)
    if contextual_status == 425:
        return ProviderRequestError(
            text[-2000:] or "provider request was too early",
            status_code=425,
            provider_code="too_early",
            stage=stage,
        )
    if contextual_status is not None and 500 <= contextual_status <= 599:
        return ProviderRequestError(text[-2000:], status_code=contextual_status, stage=stage)
    if any(token in lower for token in ("connection reset", "connection refused", "network error")):
        return ProviderRequestError(
            text[-2000:], provider_code="network_error", status_code=503, stage=stage
        )
    if "insufficient_quota" in lower or "quota exhausted" in lower:
        return ProviderRequestError(text[-2000:], provider_code="insufficient_quota", stage=stage)
    if contextual_status == 401 or re.search(r"unauthori[sz]ed|invalid api key", lower):
        return ProviderRequestError(text[-2000:], status_code=401, stage=stage)
    if contextual_status == 403 or "forbidden" in lower:
        return ProviderRequestError(text[-2000:], status_code=403, stage=stage)
    if contextual_status == 404 or re.search(r"model (?:not found|does not exist)", lower):
        return ProviderRequestError(
            text[-2000:],
            status_code=404,
            provider_code="model_not_found",
            stage=stage,
        )
    if contextual_status is not None and 400 <= contextual_status <= 499:
        return ProviderRequestError(
            text[-2000:],
            status_code=contextual_status,
            provider_code="invalid_request",
            stage=stage,
        )
    if "invalid request" in lower or "bad request" in lower:
        return ProviderRequestError(
            text[-2000:], status_code=400, provider_code="invalid_request", stage=stage
        )
    return None


def _worker_provider_error(
    response: Mapping[str, Any],
    return_code: int,
    stdout_text: str,
    stderr_text: str,
) -> ProviderRequestError | None:
    if response.get("status") == "ok" and return_code == 0:
        return None
    combined_error = "\n".join(
        [
            stdout_text,
            stderr_text,
            str(response.get("error", "")),
            str(response.get("swallowed_errors", "")),
        ]
    )
    return _provider_error(combined_error, stage="official-task-group")


def _run_worker(
    settings: ProductionSettings,
    request_path: Path,
    response_path: Path,
    stdout_path: Path,
    stderr_path: Path,
) -> int:
    worker = Path(__file__).with_name("worker.py")
    environment = os.environ.copy()
    integration_root = Path(__file__).resolve().parents[1]
    prior_pythonpath = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = os.pathsep.join(
        [os.fspath(integration_root), *( [prior_pythonpath] if prior_pythonpath else [])]
    )
    environment.update(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "HF_HUB_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "OPENAI_BASE_URL": settings.provider_proxy_url,
            "OPENAI_API_BASE": settings.provider_proxy_url,
        }
    )
    command = [
        settings.python,
        "-B",
        os.fspath(worker),
        "--request",
        os.fspath(request_path),
        "--response",
        os.fspath(response_path),
    ]
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        process = subprocess.Popen(
            command,
            cwd=settings.checkout,
            env=environment,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
        )
        try:
            return process.wait(timeout=settings.worker_timeout_seconds)
        except subprocess.TimeoutExpired as error:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise ProviderRequestError(
                f"official task-group worker timed out after {settings.worker_timeout_seconds}s",
                status_code=408,
                stage="official-worker",
            ) from error


def _record_usage(
    artifacts: AttemptHandle, response: Mapping[str, Any]
) -> tuple[Mapping[str, Any], ...]:
    raw_events = response.get("usage", [])
    if not isinstance(raw_events, list):
        raise IntegrityError("worker usage must be a list")
    recorded: list[Mapping[str, Any]] = []
    for event in raw_events:
        if not isinstance(event, Mapping) or not isinstance(event.get("usage"), Mapping):
            raise IntegrityError("worker emitted an invalid usage event")
        artifacts.append_event(
            component="official-upstream",
            kind="raw-usage-observed",
            payload=dict(event),
        )
        artifacts.record_raw_usage(
            stage=str(event.get("stage", "official-agent")),
            model=str(event.get("model", "unknown")),
            usage=event["usage"],
            request_id=(str(event["request_id"]) if event.get("request_id") else None),
            response_model=(
                str(event["response_model"]) if event.get("response_model") else None
            ),
        )
        recorded.append(dict(event))
    coverage = response.get("usage_coverage", {})
    if isinstance(coverage, Mapping):
        artifacts.append_event(
            component="official-upstream",
            kind="usage-coverage",
            payload=dict(coverage),
        )
    return tuple(recorded)


def _picorer_model_identities(artifacts: AttemptHandle) -> tuple[str | None, str | None]:
    try:
        run_manifest, _ = artifacts.store.load_manifests()
    except Exception:
        run_manifest = {}
    models = run_manifest.get("models")
    if not isinstance(models, Mapping):
        models = {}
    retrieval = models.get("picorer_retrieval")
    embedding = models.get("embedding_model")
    return (
        str(retrieval) if isinstance(retrieval, str) and retrieval else None,
        str(embedding) if isinstance(embedding, str) and embedding else None,
    )


def _read_picorer_operation_audits(
    settings: ProductionSettings,
    context: AttemptContext,
    artifacts: AttemptHandle,
) -> tuple[dict[str, Any], ...]:
    path = settings.picorer_data_dir / "operation-audits.jsonl"
    if not path.is_file():
        raise _incomplete_provider_error(
            f"Picorer durable operation audit is missing: {path}", stage="picorer-memory"
        )
    prefix = context.memory_scope + "::"
    records: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError(f"non-object line {line_number}")
                if str(value.get("user_id", "")).startswith(prefix):
                    records.append(value)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise _incomplete_provider_error(
            f"Picorer durable operation audit is unreadable: {error}",
            stage="picorer-memory",
        ) from error
    if not records:
        raise _incomplete_provider_error(
            "Picorer durable operation audit has no events for attempt scope",
            stage="picorer-memory",
        )
    grouped: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        operation_id = record.get("operation_id")
        if not isinstance(operation_id, str) or not operation_id:
            raise IntegrityError("Picorer operation audit lacks operation_id")
        grouped.setdefault(operation_id, []).append(record)
    terminals: list[dict[str, Any]] = []
    for operation_id, lifecycle in grouped.items():
        if len(lifecycle) != 2 or lifecycle[0].get("phase") != "start" or lifecycle[1].get(
            "phase"
        ) not in {"success", "failure"}:
            raise _incomplete_provider_error(
                f"Picorer operation audit lifecycle incomplete: {operation_id}",
                stage="picorer-memory",
            )
        if lifecycle[0].get("operation") != lifecycle[1].get("operation"):
            raise IntegrityError("Picorer operation audit operation changed within lifecycle")
        terminals.append(lifecycle[1])
    write_json_atomic(
        context.attempt_dir / "upstream" / "picorer-operation-audit.json",
        {
            "schema_version": 1,
            "memory_scope": context.memory_scope,
            "source": os.fspath(path),
            "records": records,
        },
    )

    retrieval_model, embedding_model = _picorer_model_identities(artifacts)
    coverage_gaps: list[str] = []
    for terminal in terminals:
        retrieval = terminal.get("retrieval")
        if isinstance(retrieval, Mapping) and isinstance(retrieval.get("usage"), Mapping):
            if retrieval_model is None:
                raise IntegrityError(
                    "Picorer retrieval usage is observable but retrieval model identity is not locked"
                )
            usage = retrieval["usage"]
            artifacts.append_event(
                component="picorer-retrieval",
                kind="raw-usage-observed",
                payload={
                    "operation_id": terminal.get("operation_id"),
                    "run_id": retrieval.get("run_id"),
                    "status": retrieval.get("status"),
                    "usage": dict(usage),
                },
            )
            artifacts.record_raw_usage(
                stage="picorer-retrieval",
                model=retrieval_model,
                usage=usage,
                request_id=(
                    str(retrieval["run_id"]) if retrieval.get("run_id") is not None else None
                ),
            )
        embedding = terminal.get("embedding")
        delta = embedding.get("delta") if isinstance(embedding, Mapping) else None
        if isinstance(delta, Mapping):
            input_tokens = delta.get("input_tokens")
            calls = delta.get("calls", 0)
            missing_calls = delta.get("usage_missing_calls", 0)
            if input_tokens is not None:
                if embedding_model is None:
                    raise IntegrityError(
                        "Picorer embedding usage is observable but embedding model identity is not locked"
                    )
                raw_embedding_usage = {
                    "input_tokens": input_tokens,
                    "output_tokens": 0,
                }
                artifacts.append_event(
                    component="picorer-embedding",
                    kind="raw-usage-observed",
                    payload={
                        "operation_id": terminal.get("operation_id"),
                        "measurement": embedding.get("measurement"),
                        "calls": calls,
                        "usage_missing_calls": missing_calls,
                        "usage": raw_embedding_usage,
                    },
                )
                artifacts.record_raw_usage(
                    stage="picorer-embedding",
                    model=embedding_model,
                    usage=raw_embedding_usage,
                    request_id=str(terminal.get("operation_id")),
                )
            if isinstance(missing_calls, (int, float)) and missing_calls > 0:
                coverage_gaps.append(
                    f"embedding usage missing for {missing_calls} calls in operation "
                    f"{terminal.get('operation_id')}"
                )
    if coverage_gaps:
        artifacts.append_event(
            component="picorer-embedding",
            kind="usage-coverage",
            payload={"status": "partial", "gaps": coverage_gaps},
        )
    return tuple(terminals)


def _capture_picorer_wrap_audits(
    settings: ProductionSettings,
    context: AttemptContext,
    artifacts: AttemptHandle,
    *,
    proxy_events: Sequence[Any],
) -> tuple[Path, int]:
    """Copy this attempt's full Picorer retrieval trajectories into its artifacts."""

    source = settings.picorer_data_dir / "wrap-audits.jsonl"
    if not source.is_file():
        raise _incomplete_provider_error(
            f"Picorer raw wrap audit is missing: {source}", stage="picorer-memory"
        )
    prefix = context.memory_scope + "::"
    selected: list[bytes] = []
    retrieval_model, _ = _picorer_model_identities(artifacts)
    try:
        with source.open("rb") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                if not raw_line.strip():
                    continue
                value = json.loads(raw_line)
                if not isinstance(value, Mapping):
                    raise ValueError(f"non-object line {line_number}")
                user_id = value.get("userId")
                if not isinstance(user_id, str) or not user_id.startswith(prefix):
                    continue
                retrieval = value.get("retrieval")
                if isinstance(retrieval, Mapping):
                    audit = retrieval.get("audit")
                    model = (
                        audit.get("retrieval_model")
                        if isinstance(audit, Mapping)
                        else None
                    )
                    model_id = model.get("modelId") if isinstance(model, Mapping) else None
                    if retrieval_model is None or model_id != retrieval_model:
                        raise IntegrityError(
                            "Picorer raw trajectory retrieval model differs from the "
                            "SHA-locked run manifest"
                        )
                selected.append(raw_line.rstrip(b"\r\n") + b"\n")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise _incomplete_provider_error(
            f"Picorer raw wrap audit is unreadable: {error}", stage="picorer-memory"
        ) from error

    expected_successes = sum(
        event.operation == "wrap_user_prompt" and event.status == "ok"
        for event in proxy_events
    )
    if len(selected) != expected_successes:
        raise _incomplete_provider_error(
            "Picorer raw trajectory count differs from successful wrap lifecycle",
            stage="picorer-memory",
        )
    target = context.attempt_dir / "upstream" / "picorer-wrap-audits.jsonl"
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            for line in selected:
                handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        os.chmod(target, 0o600)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
    artifacts.append_event(
        component="picorer-retrieval",
        kind="raw-trajectories-captured",
        payload={
            "path": "upstream/picorer-wrap-audits.jsonl",
            "record_count": len(selected),
            "sha256": file_sha256(target),
        },
    )
    return target, len(selected)


def _incomplete_provider_error(message: str, *, stage: str) -> ProviderRequestError:
    return ProviderRequestError(
        message,
        status_code=503,
        provider_code="incomplete_official_output",
        stage=stage,
    )


def memoryarena_executor(
    task: TaskSpec, context: AttemptContext, artifacts: AttemptHandle
) -> TaskExecutionResult:
    """Execute exactly one pinned official task group in an isolated process."""

    seam_identity = _assert_production_seam_unchanged()
    settings = ProductionSettings.from_environment()
    state = _load_release_state(settings)
    run_manifest = _verify_runtime_manifest(artifacts, settings, state, context)
    effective_configs = run_manifest["effective_configs"]
    assert isinstance(effective_configs, Mapping)
    config_lock = effective_configs[task.domain]
    assert isinstance(config_lock, Mapping)
    expected = state.tasks.get(task.task_key)
    if expected is None or expected.to_manifest_entry() != task.to_manifest_entry():
        raise IntegrityError("executor TaskSpec is not in the concrete 701-task release")
    if context.task.to_manifest_entry() != task.to_manifest_entry():
        raise IntegrityError("AttemptContext references another TaskSpec")
    record = state.records.get(task.task_key)
    if record is None or canonical_sha256(record) != task.source_record_hash:
        raise IntegrityError("pinned source record differs from TaskSpec")

    upstream_root = context.attempt_dir / "upstream"
    upstream_root.mkdir(parents=True, exist_ok=True)
    record_path = upstream_root / "source-record.json"
    write_json_atomic(record_path, record)
    response_path = upstream_root / "worker-response.json"
    stdout_path = upstream_root / "worker.stdout.log"
    stderr_path = upstream_root / "worker.stderr.log"
    audit_path = upstream_root / "memory-audit.json"

    # Build once to read the gateway without allowing any official process to
    # race the audit proxy.  The temporary URL is overwritten below.
    dummy_config, gateway_url, _ = _prepare_attempt_config(
        settings,
        task,
        context,
        memory_proxy_url="http://127.0.0.1:1",
        config_lock=config_lock,
    )
    dummy_config.unlink()

    proxy = MemoryAuditProxy(
        upstream_url=gateway_url,
        memory_scope=context.memory_scope,
        audit_path=audit_path,
        gold_answers=record.get("answers", []),
    )
    proxy.start()
    try:
        config_path, repeated_gateway, changed_paths = _prepare_attempt_config(
            settings,
            task,
            context,
            memory_proxy_url=proxy.url,
            config_lock=config_lock,
        )
        if repeated_gateway != gateway_url:
            raise IntegrityError("effective config changed while starting attempt")
        official_output = upstream_root / "official"
        request = {
            "schema_version": 1,
            "suite": task.domain,
            "task_key": task.task_key,
            "source_record_hash": task.source_record_hash,
            "checkout": os.fspath(settings.checkout),
            "record": os.fspath(record_path),
            "config": os.fspath(config_path),
            "output_dir": os.fspath(official_output),
            "memory_scope": context.memory_scope,
            "official_query_id": task.metadata.get("official_query_id"),
            "provider_proxy_url": settings.provider_proxy_url,
            "seam_bundle_sha256": seam_identity["bundle_sha256"],
            "worker_sha256": file_sha256(Path(__file__).with_name("worker.py")),
        }
        request_path = upstream_root / "worker-request.json"
        write_json_atomic(request_path, request)
        return_code = _run_worker(
            settings, request_path, response_path, stdout_path, stderr_path
        )
    finally:
        proxy.close()

    stdout_text = stdout_path.read_text(encoding="utf-8", errors="replace")
    stderr_text = stderr_path.read_text(encoding="utf-8", errors="replace")
    response: dict[str, Any] = {}
    if response_path.is_file():
        try:
            response = read_json(response_path)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            detected = _provider_error(stdout_text + "\n" + stderr_text, stage="official-worker")
            if detected:
                raise detected
            raise _incomplete_provider_error(
                f"official worker response is unreadable: {error}", stage="official-worker"
            ) from error
    if response and response.get("seam_bundle_sha256") != seam_identity["bundle_sha256"]:
        raise IntegrityError("official worker did not execute the locked production seam")

    # Preserve every observable usage event before deciding whether this
    # attempt failed; these are retry overhead if another fresh scope succeeds.
    usage_events = _record_usage(artifacts, response)
    artifacts.append_event(
        component="official-upstream",
        kind="raw-output-captured",
        payload={
            "worker_return_code": return_code,
            "worker_response_sha256": (
                file_sha256(response_path) if response_path.is_file() else None
            ),
            "stdout_sha256": file_sha256(stdout_path),
            "stderr_sha256": file_sha256(stderr_path),
            "output_inventory": response.get("output_inventory", []),
        },
    )
    _verify_checkout(settings.checkout)

    detected = _worker_provider_error(response, return_code, stdout_text, stderr_text)
    try:
        durable_terminals = _read_picorer_operation_audits(
            settings, context, artifacts
        )
        wrap_audit_path, wrap_audit_count = _capture_picorer_wrap_audits(
            settings,
            context,
            artifacts,
            proxy_events=proxy.events,
        )
    except ProviderRequestError as audit_error:
        # Prefer a precise swallowed 429/timeout marker after streaming any
        # partial official usage; otherwise absence of durable Picorer lifecycle
        # is itself retryable infrastructure failure.
        if detected:
            raise detected
        if response.get("status") == "protocol_error" and return_code == 2:
            message = str(response.get("error", "official worker protocol failure"))
            if not any(
                token in message.casefold()
                for token in ("missing", "incomplete", "judge")
            ):
                raise IntegrityError(message) from audit_error
        raise audit_error
    if detected:
        raise detected
    durable_operations = [str(item.get("operation")) for item in durable_terminals]
    proxy_operations = [item.operation for item in proxy.events]
    if durable_operations != proxy_operations:
        raise _incomplete_provider_error(
            "Picorer durable lifecycle differs from attempt-local proxy audit",
            stage="picorer-memory",
        )
    durable_statuses = [str(item.get("status")) for item in durable_terminals]
    proxy_statuses = [item.status for item in proxy.events]
    if durable_statuses != proxy_statuses:
        raise _incomplete_provider_error(
            "Picorer durable/proxy terminal statuses differ", stage="picorer-memory"
        )
    try:
        lifecycle = validate_lifecycle(
            proxy.events,
            suite=task.domain,
            question_count=len(task.subtask_ids),
            expected_shopping_adds=(
                int(response["expected_shopping_adds"])
                if response.get("expected_shopping_adds") is not None
                else None
            ),
        )
    except UpstreamExecutionError as error:
        failed = next((event for event in proxy.events if event.status != "ok"), None)
        status = failed.status_code if failed and failed.status_code is not None else 503
        if failed and failed.retryable is True and status not in {408, 429} and not (
            500 <= status <= 599
        ):
            status = 503
        raise ProviderRequestError(
            str(error),
            status_code=status,
            provider_code="picorer_lifecycle_incomplete",
            retry_after=(failed.retry_after if failed else None),
            stage="picorer-memory",
        ) from error
    artifacts.append_event(
        component="picorer-memory",
        kind="lifecycle-verified",
        payload=lifecycle,
    )

    status = response.get("status")
    if status == "infra_error" or return_code not in {0, 2}:
        raise _incomplete_provider_error(
            str(response.get("error") or response.get("swallowed_errors") or "official output incomplete"),
            stage="official-task-group",
        )
    if status != "ok" or return_code != 0:
        message = str(response.get("error", "official worker protocol failure"))
        if any(token in message.casefold() for token in ("missing", "incomplete", "judge")):
            raise _incomplete_provider_error(message, stage="official-task-group")
        raise IntegrityError(message)
    if response.get("completed_count") != len(task.subtask_ids):
        raise _incomplete_provider_error(
            "official task group did not emit every expected subtask",
            stage="official-task-group",
        )
    result = response.get("result")
    if not isinstance(result, Mapping):
        raise _incomplete_provider_error(
            "official task group emitted no raw result", stage="official-task-group"
        )
    return TaskExecutionResult(
        completed_subtask_ids=task.subtask_ids,
        result=dict(result),
        # Usage was already streamed to AttemptHandle so it survives failures
        # and must not be recorded a second time by MemoryArenaRunner.
        usage=(),
        metadata={
            "official_code_revision": OFFICIAL_CODE_REVISION,
            "official_data_revision": PUBLIC_DATA_REVISION,
            "production_seam_bundle_sha256": seam_identity["bundle_sha256"],
            "worker_response_sha256": file_sha256(response_path),
            "memory_audit_sha256": file_sha256(audit_path),
            "picorer_wrap_audit_sha256": file_sha256(wrap_audit_path),
            "raw_trajectory_inventory": {
                "path": "upstream/picorer-wrap-audits.jsonl",
                "size": wrap_audit_path.stat().st_size,
                "sha256": file_sha256(wrap_audit_path),
                "record_count": wrap_audit_count,
            },
            "attempt_config_changed_paths": list(changed_paths),
            "usage_event_count": len(usage_events),
            "raw_output_inventory": response.get("output_inventory", []),
        },
    )
