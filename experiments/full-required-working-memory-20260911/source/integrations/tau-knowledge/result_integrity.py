"""Infrastructure-neutral validity checks for tau-Knowledge result batches.

The official runner owns checkpoint serialization and evaluation.  This module
only verifies that the resulting batch contains exactly one evaluated result
for every requested (task, trial, seed) tuple.  It deliberately treats
``infrastructure_error`` as missing work rather than as a benchmark outcome.
"""

from __future__ import annotations

from collections import Counter
import hashlib
from pathlib import Path
import random
import re
from typing import Any, Iterable, Mapping, Sequence


INFRASTRUCTURE_ERROR = "infrastructure_error"
METHOD_EXECUTION_CONTRACT_FIELDS = (
    "picorer_max_input_ms",
    "picorer_max_turns_per_input",
    "picorer_max_tool_calls_per_input",
    "bridge_response_timeout_seconds",
)


def method_execution_contract(value: Any) -> dict[str, Any]:
    contract = value if isinstance(value, Mapping) else {}
    return {field: contract.get(field) for field in METHOD_EXECUTION_CONTRACT_FIELDS}


def _value(item: Any, name: str, default: Any = None) -> Any:
    if isinstance(item, Mapping):
        return item.get(name, default)
    return getattr(item, name, default)


def _enum_value(value: Any) -> Any:
    return getattr(value, "value", value)


def _reward(simulation: Any) -> Any:
    reward_info = _value(simulation, "reward_info")
    return _value(reward_info, "reward") if reward_info is not None else None


def _response_model(message: Any) -> str | None:
    raw_data = _value(message, "raw_data")
    if not isinstance(raw_data, Mapping):
        return None
    model = raw_data.get("model")
    if isinstance(model, str):
        return model
    if isinstance(model, Mapping):
        response_model = model.get("responseModel")
        if isinstance(response_model, str):
            return response_model
    return None


def _matches_model_alias(expected: str, observed: str) -> bool:
    if observed == expected:
        return True
    return re.fullmatch(
        re.escape(expected) + r"-\d{4}-\d{2}-\d{2}", observed
    ) is not None


def trial_seeds(seed: int, num_trials: int) -> list[int]:
    """Match tau2's deterministic per-trial seed expansion."""
    generator = random.Random(seed)
    return [generator.randint(0, 1_000_000) for _ in range(num_trials)]


def build_validity_report(
    *,
    tasks: Sequence[Any],
    simulations: Iterable[Any],
    num_trials: int,
    seed: int,
    expected_agent_model: str | None = None,
    expected_user_model: str | None = None,
) -> dict[str, Any]:
    """Return a JSON-serializable completeness and infrastructure report."""
    task_ids = [str(_value(task, "id")) for task in tasks]
    seeds = trial_seeds(seed, num_trials)
    expected = {
        (task_id, trial, seeds[trial])
        for task_id in task_ids
        for trial in range(num_trials)
    }

    observed: list[tuple[str, int, int]] = []
    infrastructure_errors: list[dict[str, Any]] = []
    missing_reward: list[dict[str, Any]] = []
    termination_counts: Counter[str] = Counter()
    response_model_counts: dict[str, Counter[str]] = {
        "assistant": Counter(),
        "user": Counter(),
    }
    response_model_mismatches: list[dict[str, Any]] = []
    missing_response_model: list[dict[str, Any]] = []
    for simulation in simulations:
        task_id = str(_value(simulation, "task_id"))
        trial = int(_value(simulation, "trial", -1))
        observed_seed = int(_value(simulation, "seed", -1))
        key = (task_id, trial, observed_seed)
        observed.append(key)
        reason = str(_enum_value(_value(simulation, "termination_reason")))
        termination_counts[reason] += 1
        reference = {
            "task_id": task_id,
            "trial": trial,
            "seed": observed_seed,
        }
        if reason == INFRASTRUCTURE_ERROR:
            infrastructure_errors.append(reference)
        elif not isinstance(_reward(simulation), (int, float)):
            missing_reward.append(reference)
        else:
            seen_roles: set[str] = set()
            for message in _value(simulation, "messages", []):
                role = _value(message, "role")
                if role not in response_model_counts:
                    continue
                response_model = _response_model(message)
                if response_model is None:
                    continue
                seen_roles.add(role)
                response_model_counts[role][response_model] += 1
                expected_model = (
                    expected_agent_model if role == "assistant" else expected_user_model
                )
                if expected_model is not None and not _matches_model_alias(
                    expected_model, response_model
                ):
                    response_model_mismatches.append(
                        {
                            **reference,
                            "role": role,
                            "expected": expected_model,
                            "observed": response_model,
                        }
                    )
            for role, expected_model in [
                ("assistant", expected_agent_model),
                ("user", expected_user_model),
            ]:
                if expected_model is not None and role not in seen_roles:
                    missing_response_model.append({**reference, "role": role})

    counts = Counter(observed)
    duplicates = [
        {"task_id": key[0], "trial": key[1], "seed": key[2], "count": count}
        for key, count in sorted(counts.items())
        if count != 1
    ]
    observed_set = set(observed)
    missing = [
        {"task_id": key[0], "trial": key[1], "seed": key[2]}
        for key in sorted(expected - observed_set)
    ]
    unexpected = [
        {"task_id": key[0], "trial": key[1], "seed": key[2]}
        for key in sorted(observed_set - expected)
    ]
    structural_errors = bool(duplicates or missing or unexpected)
    valid = (
        not structural_errors
        and not infrastructure_errors
        and not missing_reward
        and not response_model_mismatches
        and not missing_response_model
        and len(observed) == len(expected)
    )
    return {
        "schema_version": 1,
        "valid": valid,
        "retryable_infrastructure_only": bool(infrastructure_errors)
        and not structural_errors
        and not missing_reward
        and not response_model_mismatches
        and not missing_response_model,
        "task_count": len(task_ids),
        "num_trials": num_trials,
        "expected_simulation_count": len(expected),
        "observed_simulation_count": len(observed),
        "evaluated_simulation_count": len(observed) - len(infrastructure_errors),
        "infrastructure_error_count": len(infrastructure_errors),
        "missing_reward_count": len(missing_reward),
        "trial_seeds": seeds,
        "termination_counts": dict(sorted(termination_counts.items())),
        "infrastructure_errors": infrastructure_errors,
        "missing_rewards": missing_reward,
        "response_models": {
            role: dict(sorted(counts.items()))
            for role, counts in response_model_counts.items()
        },
        "response_model_mismatches": response_model_mismatches,
        "missing_response_models": missing_response_model,
        "duplicates": duplicates,
        "missing": missing,
        "unexpected": unexpected,
    }


def locate_results_file(save_to: Path) -> Path:
    """Resolve tau2's nested save directory convention for absolute save_to."""
    if save_to.is_file():
        return save_to
    nested = save_to / "results.json"
    if nested.is_file():
        return nested
    raise FileNotFoundError(f"tau2 results file is missing below {save_to}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
