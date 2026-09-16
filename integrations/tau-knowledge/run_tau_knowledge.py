#!/usr/bin/env python3
"""Run Picorer inside the pinned official tau-Knowledge environment."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gc
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

if sys.version_info < (3, 12):
    raise SystemExit("tau2-bench requires Python 3.12 or newer")

from picorer_tau_agent import (
    BRIDGE_ARGS_ENV,
    BRIDGE_RESPONSE_TIMEOUT_ENV,
    create_picorer_tau_agent,
)
from provider_health import wait_for_openai_chat_model
from result_integrity import (
    build_validity_report,
    locate_results_file,
    method_execution_contract,
    sha256_file,
)


TAU_REVISION = "a2c024725189473d2d7cea3a5cfdbcc67478e41f"
TAU_VERSION = "1.0.1"
OFFICIAL_RECIPE_ID = "tau-knowledge-banking-gpt54-xhigh-gpt52-low-4x-seed300-v1"
OFFICIAL_TASK_SPLIT = "base"
OFFICIAL_AGENT_MODEL = "gpt-5.4"
OFFICIAL_AGENT_REASONING = "xhigh"
OFFICIAL_USER_MODEL = "openai/gpt-5.2"
OFFICIAL_USER_REASONING = "low"
OFFICIAL_TEMPERATURE = 0
OFFICIAL_NUM_TRIALS = 4
OFFICIAL_SEED = 300
OFFICIAL_MAX_STEPS = 200
OFFICIAL_RETRIEVAL_CONFIG = "alltools"
DEFAULT_MAX_RETRIES = 5
DEFAULT_RETRY_DELAY_SECONDS = 15.0
DEFAULT_INFRA_RESUME_ROUNDS = 6
DEFAULT_INFRA_RESUME_DELAY_SECONDS = 30.0
DEFAULT_PICORER_MAX_INPUT_MS = 900_000
DEFAULT_PICORER_MAX_TURNS_PER_INPUT = 64
DEFAULT_PICORER_MAX_TOOL_CALLS_PER_INPUT = 128
DEFAULT_BRIDGE_RESPONSE_TIMEOUT_SECONDS = 930.0


def official_llm(model: str) -> str:
    """Return the LiteLLM identifier used by the official tau2 runner."""
    return model if "/" in model else f"openai/{model}"


def recipe_config(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "id": OFFICIAL_RECIPE_ID,
        "tau2_bench_version": TAU_VERSION,
        "task_split": OFFICIAL_TASK_SPLIT,
        "agent_model": OFFICIAL_AGENT_MODEL,
        "agent_reasoning_effort": OFFICIAL_AGENT_REASONING,
        "agent_temperature": OFFICIAL_TEMPERATURE,
        "user_model": OFFICIAL_USER_MODEL,
        "user_reasoning_effort": OFFICIAL_USER_REASONING,
        "user_temperature": OFFICIAL_TEMPERATURE,
        "num_trials": args.num_trials,
        "seed": args.seed,
        "max_steps": args.max_steps,
        "run_kind": args.run_kind,
        "condition": args.condition,
        "retrieval_config": (
            OFFICIAL_RETRIEVAL_CONFIG
            if args.condition == "official-alltools"
            else "picorer"
        ),
        "official_alltools": (
            ["bm25", "text-embedding-3-large", "sandboxed-shell"]
            if args.condition == "official-alltools"
            else None
        ),
    }


def assert_recipe(args: argparse.Namespace) -> None:
    expected = {
        "--model": (args.model, OFFICIAL_AGENT_MODEL),
        "--thinking-level": (args.thinking_level, OFFICIAL_AGENT_REASONING),
        "--user-model": (args.user_model, OFFICIAL_USER_MODEL),
        "--seed": (args.seed, OFFICIAL_SEED),
        "--max-steps": (args.max_steps, OFFICIAL_MAX_STEPS),
    }
    mismatches = [
        f"{flag} must be {wanted!r}, got {actual!r}"
        for flag, (actual, wanted) in expected.items()
        if actual != wanted
    ]
    if args.run_kind == "formal":
        if args.task_id:
            mismatches.append("formal runs must include all 97 tasks")
        if args.num_trials != OFFICIAL_NUM_TRIALS:
            mismatches.append(
                f"formal --num-trials must be {OFFICIAL_NUM_TRIALS}, "
                f"got {args.num_trials}"
            )
        if args.tau_allow_dirty:
            mismatches.append(
                "formal runs require an unmodified pinned tau2-bench checkout"
            )
    elif args.num_trials != 1:
        mismatches.append("canary --num-trials must be 1")
    if args.condition == "official-alltools":
        if args.operator:
            mismatches.append("official-alltools does not accept --operator")
        if args.operator_module:
            mismatches.append("official-alltools does not accept --operator-module")
    if args.condition == "picorer" and args.run_kind == "formal":
        for flag, value in [
            ("--agent-dir", args.agent_dir),
            ("--provider", args.provider),
            ("--api-key-env", args.api_key_env),
            ("--base-url-env", args.base_url_env),
            ("--transport", args.transport),
        ]:
            if not value:
                mismatches.append(f"formal Picorer runs require explicit {flag}")
    if mismatches:
        raise SystemExit("Official recipe mismatch:\n- " + "\n- ".join(mismatches))


def git_output(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    return completed.stdout.strip()


def source_identity(root: Path, allow_dirty: bool) -> dict[str, Any]:
    revision = git_output(root, "rev-parse", "HEAD")
    status = git_output(root, "status", "--porcelain=v1", "--untracked-files=all")
    dirty = bool(status)
    if dirty and not allow_dirty:
        raise SystemExit(f"Refusing dirty checkout for formal run: {root}")
    return {
        "revision": revision,
        "dirty": dirty,
        "status_sha256": hashlib.sha256(status.encode()).hexdigest() if dirty else None,
    }


def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def integration_identity() -> dict[str, str]:
    root = Path(__file__).resolve().parent
    return {
        "runner_sha256": hashlib.sha256(
            (root / "run_tau_knowledge.py").read_bytes()
        ).hexdigest(),
        "agent_adapter_sha256": hashlib.sha256(
            (root / "picorer_tau_agent.py").read_bytes()
        ).hexdigest(),
        "result_integrity_sha256": hashlib.sha256(
            (root / "result_integrity.py").read_bytes()
        ).hexdigest(),
        "provider_health_sha256": hashlib.sha256(
            (root / "provider_health.py").read_bytes()
        ).hexdigest(),
    }


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def install_run_manifest(
    *,
    path: Path,
    manifest: dict[str, Any],
    results_path: Path,
    allow_infra_resume: bool,
) -> dict[str, Any]:
    """Create, validate, or explicitly migrate an infra-only run manifest."""
    if not path.exists():
        atomic_json(path, manifest)
        return manifest

    existing = json.loads(path.read_text())
    if existing == manifest:
        return existing

    resume_provenance = existing.get("resume_provenance")
    if isinstance(resume_provenance, dict):
        resumed_manifest = dict(manifest)
        resumed_manifest["resume_provenance"] = resume_provenance
        if existing == resumed_manifest:
            return existing

    if not allow_infra_resume:
        raise SystemExit(
            "Output directory belongs to a different run config. "
            "Use --resume-infra only to migrate a schema-v2 run whose "
            "benchmark semantics and Picorer source are unchanged."
        )
    if existing.get("schema_version") not in {2, 3, 4}:
        raise SystemExit(
            "--resume-infra only supports audited schema-v2/v3/v4 runs"
        )
    immutable_fields = [
        "benchmark",
        "submission_type",
        "tau2_source",
        "picorer_source",
        "dataset",
        "recipe",
    ]
    mismatches = [
        field for field in immutable_fields if existing.get(field) != manifest.get(field)
    ]
    existing_config = dict(existing.get("config") or {})
    requested_config = dict(manifest.get("config") or {})
    existing_slots = existing_config.pop("slots", None)
    requested_slots = requested_config.pop("slots", None)
    if existing_config != requested_config:
        mismatches.append("config_except_slots")
    existing_execution = existing.get("execution_contract")
    requested_execution = manifest.get("execution_contract")
    if method_execution_contract(existing_execution) != method_execution_contract(
        requested_execution
    ):
        mismatches.append("execution_contract.method_limits")
    if mismatches:
        raise SystemExit(
            "Refusing infra resume because benchmark semantics changed: "
            + ", ".join(mismatches)
        )
    try:
        result_file = locate_results_file(results_path)
    except FileNotFoundError as error:
        raise SystemExit("Cannot migrate a run manifest without its checkpoint") from error
    migrated = dict(manifest)
    migrated["resume_provenance"] = {
        "mode": "infra-only-auto-resume",
        "migrated_at": datetime.now(timezone.utc).isoformat(),
        "predecessor_manifest_sha256": canonical_sha256(existing),
        "predecessor_results_sha256": sha256_file(result_file),
        "predecessor_integration_source": existing.get("integration_source"),
        "predecessor_resume_provenance": existing.get("resume_provenance"),
        "inherited_execution": {
            "slots": existing_slots,
            "requested_slots": requested_slots,
            **(
                existing["execution_contract"]
                if isinstance(existing.get("execution_contract"), dict)
                else {
                    "slots": existing["config"].get("slots"),
                    "timeout_seconds": existing["config"].get("timeout"),
                    "tau2_max_retries": 3,
                    "tau2_retry_delay_seconds": 1.0,
                    "picorer_max_input_ms": (
                        300_000
                        if existing.get("submission_type") == "custom"
                        else None
                    ),
                }
            )
        },
    }
    atomic_json(path, migrated)
    return migrated


def normalize_official_openai_environment() -> None:
    """Keep LiteLLM and the official OpenAI SDK on the same endpoint."""
    api_base = os.environ.get("OPENAI_API_BASE")
    base_url = os.environ.get("OPENAI_BASE_URL")
    if api_base and base_url and api_base.rstrip("/") != base_url.rstrip("/"):
        raise SystemExit("OPENAI_API_BASE and OPENAI_BASE_URL disagree")
    if api_base and not base_url:
        os.environ["OPENAI_BASE_URL"] = api_base
    elif base_url and not api_base:
        os.environ["OPENAI_API_BASE"] = base_url


def public_endpoint(raw_url: str | None) -> str | None:
    """Normalize a provider endpoint while rejecting credential-bearing URLs."""
    if raw_url is None or not raw_url.strip():
        return None
    parsed = urlsplit(raw_url.strip())
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("Provider base URLs must be public HTTP(S) origins/paths")
    return urlunsplit(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path.rstrip("/"),
            "",
            "",
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tau-root", type=Path, required=True)
    parser.add_argument("--picorer-root", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--condition",
        choices=["official-alltools", "picorer"],
        default="picorer",
        help="Official AllTools calibration or the Picorer custom condition",
    )
    parser.add_argument(
        "--run-kind",
        choices=["formal", "canary"],
        default="formal",
        help="Formal is the leaderboard-aligned 97-task, four-trial recipe",
    )
    parser.add_argument("--task-id", action="append", default=[])
    parser.add_argument("--num-trials", type=int)
    parser.add_argument("--slots", type=int, default=3)
    parser.add_argument("--seed", type=int, default=OFFICIAL_SEED)
    parser.add_argument("--max-steps", type=int, default=OFFICIAL_MAX_STEPS)
    parser.add_argument("--timeout", type=float, default=1800)
    parser.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES)
    parser.add_argument(
        "--retry-delay", type=float, default=DEFAULT_RETRY_DELAY_SECONDS
    )
    parser.add_argument(
        "--infra-resume-rounds", type=int, default=DEFAULT_INFRA_RESUME_ROUNDS
    )
    parser.add_argument(
        "--infra-resume-delay",
        type=float,
        default=DEFAULT_INFRA_RESUME_DELAY_SECONDS,
    )
    parser.add_argument(
        "--picorer-max-input-ms", type=int, default=DEFAULT_PICORER_MAX_INPUT_MS
    )
    parser.add_argument(
        "--picorer-max-turns-per-input",
        type=int,
        default=DEFAULT_PICORER_MAX_TURNS_PER_INPUT,
    )
    parser.add_argument(
        "--picorer-max-tool-calls-per-input",
        type=int,
        default=DEFAULT_PICORER_MAX_TOOL_CALLS_PER_INPUT,
    )
    parser.add_argument(
        "--bridge-response-timeout",
        type=float,
        default=DEFAULT_BRIDGE_RESPONSE_TIMEOUT_SECONDS,
    )
    parser.add_argument("--provider-preflight-attempts", type=int, default=10)
    parser.add_argument("--provider-preflight-delay", type=float, default=60)
    parser.add_argument("--provider-preflight-timeout", type=float, default=60)
    parser.add_argument("--user-model", default=OFFICIAL_USER_MODEL)
    parser.add_argument("--agent-model-label")
    parser.add_argument("--skill", choices=["none", "picorer-v0"], default="picorer-v0")
    parser.add_argument("--operator", action="append", default=[])
    parser.add_argument(
        "--operator-module",
        action="append",
        default=[],
        help="Trusted local JavaScript module exporting createSearchOperators(store)",
    )
    parser.add_argument("--agent-dir")
    parser.add_argument("--provider")
    parser.add_argument("--model", default=OFFICIAL_AGENT_MODEL)
    parser.add_argument("--thinking-level", default=OFFICIAL_AGENT_REASONING)
    parser.add_argument("--api-key-env")
    parser.add_argument("--base-url-env")
    parser.add_argument("--transport", choices=["sse", "non-stream"], default="sse")
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--tau-allow-dirty", action="store_true")
    parser.add_argument(
        "--resume-infra",
        action="store_true",
        help="Audit-migrate an existing schema-v2 checkpoint and retry only infrastructure failures",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Validate pins, manifests, registration, and official run config without model calls",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    tau_root = args.tau_root.resolve()
    picorer_root = args.picorer_root.resolve()
    data_dir = args.data_dir.resolve()
    output_dir = args.output_dir.resolve()
    if args.num_trials is None:
        args.num_trials = OFFICIAL_NUM_TRIALS if args.run_kind == "formal" else 1
    if args.num_trials < 1 or args.num_trials > 16:
        raise SystemExit("--num-trials must be between 1 and 16")
    if args.slots < 1 or args.slots > 64:
        raise SystemExit("--slots must be between 1 and 64")
    if args.max_retries < 0 or args.max_retries > 20:
        raise SystemExit("--max-retries must be between 0 and 20")
    if args.retry_delay < 0 or args.retry_delay > 300:
        raise SystemExit("--retry-delay must be between 0 and 300 seconds")
    if args.infra_resume_rounds < 0 or args.infra_resume_rounds > 20:
        raise SystemExit("--infra-resume-rounds must be between 0 and 20")
    if args.infra_resume_delay < 0 or args.infra_resume_delay > 900:
        raise SystemExit("--infra-resume-delay must be between 0 and 900 seconds")
    if not 1_000 <= args.picorer_max_input_ms <= 1_800_000:
        raise SystemExit("--picorer-max-input-ms must be between 1000 and 1800000")
    if not 1 <= args.picorer_max_turns_per_input <= 128:
        raise SystemExit("--picorer-max-turns-per-input must be between 1 and 128")
    if not 1 <= args.picorer_max_tool_calls_per_input <= 256:
        raise SystemExit(
            "--picorer-max-tool-calls-per-input must be between 1 and 256"
        )
    if not 1 <= args.bridge_response_timeout <= 1800:
        raise SystemExit("--bridge-response-timeout must be between 1 and 1800")
    if args.condition == "picorer" and (
        args.bridge_response_timeout * 1000 < args.picorer_max_input_ms + 30_000
    ):
        raise SystemExit(
            "--bridge-response-timeout must exceed --picorer-max-input-ms by at least 30 seconds"
        )
    if args.bridge_response_timeout > args.timeout:
        raise SystemExit("--bridge-response-timeout cannot exceed --timeout")
    if not 1 <= args.provider_preflight_attempts <= 120:
        raise SystemExit("--provider-preflight-attempts must be between 1 and 120")
    if not 0 <= args.provider_preflight_delay <= 300:
        raise SystemExit("--provider-preflight-delay must be between 0 and 300")
    if not 1 <= args.provider_preflight_timeout <= 300:
        raise SystemExit("--provider-preflight-timeout must be between 1 and 300")
    assert_recipe(args)
    normalize_official_openai_environment()
    tau_openai_endpoint = public_endpoint(os.environ.get("OPENAI_BASE_URL"))
    picorer_endpoint = public_endpoint(
        os.environ.get(args.base_url_env) if args.base_url_env else None
    )
    embedding_endpoint = public_endpoint(
        os.environ.get("PICORER_EMBEDDING_BASE_URL")
    )
    if not args.validate_only:
        required_environment = ["OPENAI_API_KEY", "OPENAI_BASE_URL"]
        if args.condition == "picorer":
            required_environment.extend(
                [
                    args.api_key_env or "",
                    args.base_url_env or "",
                    "PICORER_EMBEDDING_API_KEY",
                    "PICORER_EMBEDDING_BASE_URL",
                ]
            )
        missing_environment = [
            name for name in required_environment if not name or not os.environ.get(name)
        ]
        if missing_environment:
            raise SystemExit(
                "Missing runtime environment variables: "
                + ", ".join(missing_environment)
            )

    tau_source = source_identity(tau_root, args.tau_allow_dirty)
    if tau_source["revision"] != TAU_REVISION:
        raise SystemExit(
            f"tau2-bench revision mismatch: expected {TAU_REVISION}, "
            f"got {tau_source['revision']}"
        )
    picorer_source = source_identity(picorer_root, args.allow_dirty)
    bridge = picorer_root / "dist/tau-knowledge-bridge.js"
    data_manifest_path = data_dir / "tau-knowledge-manifest.json"
    if not bridge.is_file():
        raise SystemExit("Picorer bridge is not built; run npm run build first")
    if not data_manifest_path.is_file():
        raise SystemExit("tau-Knowledge data is not ingested")
    data_manifest = json.loads(data_manifest_path.read_text())
    os.chdir(tau_root)

    operators = (
        args.operator
        or ["hybrid", "lexical", "chronological", "temporal-index", "numeric-index"]
        if args.condition == "picorer"
        else []
    )
    bridge_args = []
    if args.condition == "picorer":
        bridge_args = [
            os.environ.get("NODE", "node"),
            str(bridge),
            "--data-dir",
            str(data_dir),
            "--skill",
            args.skill,
            "--max-input-ms",
            str(args.picorer_max_input_ms),
            "--max-turns-per-input",
            str(args.picorer_max_turns_per_input),
            "--max-tool-calls-per-input",
            str(args.picorer_max_tool_calls_per_input),
        ]
        for operator in operators:
            bridge_args.extend(["--operator", operator])
    operator_modules = []
    for raw_path in args.operator_module:
        module_path = Path(raw_path).resolve()
        module_bytes = module_path.read_bytes()
        operator_modules.append(
            {
                "name": module_path.name,
                "path": str(module_path),
                "sha256": hashlib.sha256(module_bytes).hexdigest(),
            }
        )
        if args.condition == "picorer":
            bridge_args.extend(["--operator-module", str(module_path)])
    for flag, value in [
        ("agent-dir", args.agent_dir),
        ("provider", args.provider),
        ("model", args.model),
        ("thinking-level", args.thinking_level),
        ("api-key-env", args.api_key_env),
        ("base-url-env", args.base_url_env),
        ("transport", args.transport),
    ]:
        if value and args.condition == "picorer":
            bridge_args.extend([f"--{flag}", value])
    if args.condition == "picorer":
        os.environ[BRIDGE_ARGS_ENV] = json.dumps(bridge_args)
        os.environ[BRIDGE_RESPONSE_TIMEOUT_ENV] = str(
            args.bridge_response_timeout
        )

    # Register a metadata-honest retrieval variant with no upstream KB tools.
    # Picorer supplies the retrieval tools inside its own Agent runtime.
    from tau2.domains.banking_knowledge.retrieval import (
        PROMPTS_DIR,
        RETRIEVAL_VARIANTS,
        RetrievalVariant,
        standard_prompt,
    )
    from tau2.data_model.simulation import TextRunConfig
    from tau2.registry import registry
    from tau2.runner import run_domain

    if args.condition == "picorer":
        RETRIEVAL_VARIANTS["picorer"] = RetrievalVariant(
            name="picorer",
            prompt_template=PROMPTS_DIR / "no_knowledge.md",
            build_prompt=standard_prompt,
        )
        registry.register_agent_factory(create_picorer_tau_agent, "picorer")

    results_path = output_dir / "results.json"
    manifest_path = output_dir / "run-manifest.json"
    manifest = {
        "schema_version": 4,
        "benchmark": "tau-knowledge",
        "submission_type": (
            "standard" if args.condition == "official-alltools" else "custom"
        ),
        "tau2_source": tau_source,
        "picorer_source": picorer_source,
        "integration_source": integration_identity(),
        "provider_endpoints": {
            "tau_openai": tau_openai_endpoint,
            "picorer_agent": picorer_endpoint if args.condition == "picorer" else None,
            "picorer_embedding": (
                embedding_endpoint if args.condition == "picorer" else None
            ),
        },
        "execution_contract": {
            "infra_failures_are_scores": False,
            "final_batch_requires_zero_infra_failures": True,
            "tau2_max_retries": args.max_retries,
            "tau2_retry_delay_seconds": args.retry_delay,
            "slots": args.slots,
            "infra_resume_rounds": args.infra_resume_rounds,
            "infra_resume_delay_seconds": args.infra_resume_delay,
            "picorer_max_input_ms": (
                args.picorer_max_input_ms if args.condition == "picorer" else None
            ),
            "picorer_max_turns_per_input": (
                args.picorer_max_turns_per_input
                if args.condition == "picorer"
                else None
            ),
            "picorer_max_tool_calls_per_input": (
                args.picorer_max_tool_calls_per_input
                if args.condition == "picorer"
                else None
            ),
            "bridge_response_timeout_seconds": (
                args.bridge_response_timeout
                if args.condition == "picorer"
                else None
            ),
            "provider_preflight_attempts": args.provider_preflight_attempts,
            "provider_preflight_delay_seconds": args.provider_preflight_delay,
            "provider_preflight_timeout_seconds": args.provider_preflight_timeout,
        },
        "dataset": data_manifest,
        "recipe": recipe_config(args),
        "config": {
            "condition": args.condition,
            "run_kind": args.run_kind,
            "task_ids": args.task_id,
            "num_trials": args.num_trials,
            "slots": args.slots,
            "seed": args.seed,
            "max_steps": args.max_steps,
            "timeout": args.timeout,
            "user_model": args.user_model,
            "agent_model_label": args.agent_model_label,
            "skill": args.skill if args.condition == "picorer" else None,
            "operators": operators,
            "operator_modules": operator_modules,
            "model": (
                {
                    "runtime": "tau2-llm-agent",
                    "model": official_llm(args.model),
                    "thinking_level": args.thinking_level,
                }
                if args.condition == "official-alltools"
                else {
                    "runtime": "picorer-pi-agent",
                    "agent_dir": args.agent_dir,
                    "provider": args.provider,
                    "model": args.model,
                    "thinking_level": args.thinking_level,
                    "api_key_env": args.api_key_env,
                    "base_url_env": args.base_url_env,
                    "transport": args.transport,
                }
            ),
        },
    }
    shared_config = {
        "domain": "banking_knowledge",
        "llm_user": args.user_model,
        "llm_args_user": {
            "temperature": OFFICIAL_TEMPERATURE,
            "reasoning_effort": OFFICIAL_USER_REASONING,
        },
        "task_split_name": OFFICIAL_TASK_SPLIT,
        "task_ids": args.task_id or None,
        "num_trials": args.num_trials,
        "max_concurrency": args.slots,
        "seed": args.seed,
        "max_steps": args.max_steps,
        "timeout": args.timeout,
        "max_retries": args.max_retries,
        "retry_delay": args.retry_delay,
        "save_to": str(results_path),
        "auto_resume": True,
        "enforce_communication_protocol": True,
    }
    if args.condition == "official-alltools":
        config = TextRunConfig(
            **shared_config,
            agent="llm_agent",
            llm_agent=official_llm(args.model),
            llm_args_agent={
                "temperature": OFFICIAL_TEMPERATURE,
                "reasoning_effort": OFFICIAL_AGENT_REASONING,
            },
            user="user_simulator",
            retrieval_config=OFFICIAL_RETRIEVAL_CONFIG,
        )
    else:
        config = TextRunConfig(
            **shared_config,
            agent="picorer",
            llm_agent=(
                args.agent_model_label
                or f"picorer/{args.model}/{args.thinking_level}"
            ),
            llm_args_agent={"temperature": OFFICIAL_TEMPERATURE},
            user="user_simulator",
            retrieval_config="picorer",
        )
    if args.validate_only:
        print(
            json.dumps(
                {
                    "validated": True,
                    "benchmark": "tau-knowledge",
                    "condition": args.condition,
                    "run_kind": args.run_kind,
                    "recipe": recipe_config(args),
                    "integration_source": integration_identity(),
                    "tau_revision": tau_source["revision"],
                    "corpus_hash": data_manifest.get("corpus_hash"),
                    "task_set_hash": data_manifest.get("task_set_hash"),
                    "task_ids": args.task_id,
                    "operators": operators,
                    "operator_modules": operator_modules,
                    "skill": args.skill if args.condition == "picorer" else None,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return

    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output_dir, 0o700)
    install_run_manifest(
        path=manifest_path,
        manifest=manifest,
        results_path=results_path,
        allow_infra_resume=args.resume_infra,
    )

    recovery_path = output_dir / "infra-recovery.json"
    provider_health_path = output_dir / "provider-health.json"
    recovery_rounds: list[dict[str, Any]] = []
    for recovery_round in range(args.infra_resume_rounds + 1):
        provider_health = wait_for_openai_chat_model(
            endpoint=tau_openai_endpoint or "",
            api_key=os.environ["OPENAI_API_KEY"],
            model=args.user_model.rsplit("/", 1)[-1],
            attempts=args.provider_preflight_attempts,
            delay=args.provider_preflight_delay,
            timeout=args.provider_preflight_timeout,
        )
        provider_health["recovery_round"] = recovery_round
        atomic_json(provider_health_path, provider_health)
        if not provider_health["available"]:
            raise SystemExit(
                "User-simulator provider is unavailable; checkpoint was not run"
            )
        results = run_domain(config)
        report = build_validity_report(
            tasks=results.tasks,
            simulations=results.simulations,
            num_trials=args.num_trials,
            seed=args.seed,
            expected_agent_model=args.model.rsplit("/", 1)[-1],
            expected_user_model=args.user_model.rsplit("/", 1)[-1],
        )
        report["recovery_round"] = recovery_round
        recovery_rounds.append(report)
        atomic_json(
            recovery_path,
            {
                "schema_version": 1,
                "benchmark": "tau-knowledge",
                "rounds": recovery_rounds,
            },
        )
        if report["valid"]:
            result_file = locate_results_file(results_path)
            final_report = dict(report)
            final_report["results_path"] = str(result_file)
            final_report["results_sha256"] = sha256_file(result_file)
            final_report["run_manifest_sha256"] = sha256_file(manifest_path)
            atomic_json(output_dir / "validity-report.json", final_report)
            print(json.dumps(final_report, indent=2, sort_keys=True))
            return
        if not report["retryable_infrastructure_only"]:
            atomic_json(output_dir / "validity-report.json", report)
            raise SystemExit(
                "tau-Knowledge result batch is structurally invalid; refusing to score"
            )
        if recovery_round == args.infra_resume_rounds:
            atomic_json(output_dir / "validity-report.json", report)
            raise SystemExit(
                "tau-Knowledge still has infrastructure failures after all recovery rounds"
            )
        remaining = report["infrastructure_error_count"]
        print(
            f"Retrying {remaining} infrastructure-only simulations after "
            f"{args.infra_resume_delay:g}s (round {recovery_round + 1}/"
            f"{args.infra_resume_rounds})"
        )
        del results
        gc.collect()
        time.sleep(args.infra_resume_delay)


if __name__ == "__main__":
    main()
