from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from string import Template
from typing import Any

import yaml

JUDGE_METHODS = {
    "native",
    "deferred",
    "binary",
    "longmemeval",
    "beam",
    "infbench",
}


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{label} must be a mapping")
    return value


def _reference(values: Mapping[str, Any], name: Any, label: str) -> str:
    if not isinstance(name, str) or name not in values:
        raise ValueError(f"unknown {label}: {name!r}")
    return name


def validate(config: Mapping[str, Any]) -> None:
    if config.get("schema_version") != 1:
        raise ValueError("eval config schema_version must be 1")
    models = _mapping(config.get("models"), "models")
    prompts = _mapping(config.get("prompts"), "prompts")
    datasets = _mapping(config.get("datasets"), "datasets")
    if not datasets:
        raise ValueError("datasets must not be empty")

    for name, raw in models.items():
        model = _mapping(raw, f"model {name}")
        if not isinstance(model.get("id"), str) or not model["id"].strip():
            raise ValueError(f"model {name} needs a non-empty id")
        if bool(model.get("base_url")) == bool(model.get("base_url_env")):
            raise ValueError(
                f"model {name} needs exactly one of base_url and base_url_env"
            )
        if "api_key" in model:
            raise ValueError(
                f"model {name} must use api_key_env; secrets do not belong in eval.yaml"
            )

    for name, raw in prompts.items():
        prompt = _mapping(raw, f"prompt {name}")
        if not isinstance(prompt.get("user"), str):
            raise TypeError(f"prompt {name} needs a user template")
        if "system" in prompt and not isinstance(prompt["system"], str):
            raise ValueError(f"prompt {name} system must be a string")

    for dataset_id, raw in datasets.items():
        dataset = _mapping(raw, f"dataset {dataset_id}")
        answer = _mapping(dataset.get("answer"), f"dataset {dataset_id} answer")
        _reference(models, answer.get("model"), "answer model")
        _reference(prompts, answer.get("prompt"), "answer prompt")

        judge = _mapping(dataset.get("judge"), f"dataset {dataset_id} judge")
        method = judge.get("method")
        if method not in JUDGE_METHODS:
            raise ValueError(f"dataset {dataset_id} has invalid judge method {method!r}")
        if method in {"binary", "longmemeval", "beam", "infbench"}:
            _reference(models, judge.get("model"), "judge model")
        if method == "deferred":
            if "model" in judge:
                _reference(models, judge.get("model"), "deferred judge model")
            if "prompt" in judge:
                _reference(prompts, judge.get("prompt"), "deferred judge prompt")
        if method == "binary":
            _reference(prompts, judge.get("prompt"), "judge prompt")
        elif method == "longmemeval":
            family = _mapping(
                judge.get("prompt_family"),
                f"dataset {dataset_id} judge prompt_family",
            )
            for question_type, prompt_name in family.items():
                _reference(prompts, prompt_name, f"judge prompt for {question_type}")
        elif method == "beam":
            _reference(prompts, judge.get("rubric_prompt"), "BEAM rubric prompt")
            _reference(prompts, judge.get("ordering_prompt"), "BEAM ordering prompt")
        elif method == "infbench":
            prompt_set = _mapping(
                judge.get("prompts"), f"dataset {dataset_id} InfBench prompts"
            )
            if set(prompt_set) != {"fluency", "recall", "precision"}:
                raise ValueError(
                    f"dataset {dataset_id} InfBench prompts must contain exactly "
                    "fluency, recall, and precision"
                )
            for metric, prompt_name in prompt_set.items():
                _reference(prompts, prompt_name, f"InfBench {metric} prompt")


@lru_cache(maxsize=16)
def _load(path: str, expected_sha256: str) -> Mapping[str, Any]:
    resolved = Path(path)
    value = yaml.safe_load(resolved.read_text())
    config = _mapping(value, "eval config")
    validate(config)
    return config


def load(path: Path, expected_sha256: str | None = None) -> Mapping[str, Any]:
    resolved = path.resolve()
    actual_sha256 = file_sha256(resolved)
    digest = expected_sha256 or actual_sha256
    if actual_sha256 != digest:
        raise RuntimeError(
            f"eval config drift: expected {digest}, got {actual_sha256}"
        )
    return _load(str(resolved), digest)


def bind(path: Path, dataset_id: str) -> dict[str, str]:
    resolved = path.resolve()
    digest = file_sha256(resolved)
    config = load(resolved, digest)
    if dataset_id not in config["datasets"]:
        raise ValueError(f"eval config has no dataset {dataset_id!r}")
    return {
        "path": str(resolved),
        "sha256": digest,
        "dataset": dataset_id,
    }


def settings(payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    binding = payload.get("eval_config")
    if binding is None:
        return None
    binding = _mapping(binding, "payload eval_config")
    config = load(Path(str(binding["path"])), str(binding["sha256"]))
    dataset_id = str(binding["dataset"])
    try:
        return _mapping(config["datasets"][dataset_id], f"dataset {dataset_id}")
    except KeyError as error:
        raise RuntimeError(f"eval config has no dataset {dataset_id!r}") from error


def referenced(
    payload: Mapping[str, Any], section: str, name: str
) -> Mapping[str, Any]:
    binding = _mapping(payload["eval_config"], "payload eval_config")
    config = load(Path(str(binding["path"])), str(binding["sha256"]))
    values = _mapping(config.get(section), section)
    try:
        return _mapping(values[name], f"{section} {name}")
    except KeyError as error:
        raise RuntimeError(f"eval config has no {section} entry {name!r}") from error


def model(payload: Mapping[str, Any], name: str) -> dict[str, Any]:
    value = dict(referenced(payload, "models", name))
    if env_name := value.get("base_url_env"):
        base_url = os.environ.get(str(env_name))
        if not base_url:
            raise RuntimeError(f"required environment variable {env_name} is not set")
        value["base_url"] = base_url
    if env_name := value.get("api_key_env"):
        value["api_key"] = os.environ.get(str(env_name))
    return value


def render(template: str, **values: Any) -> str:
    return Template(template).substitute(
        {name: str(value) for name, value in values.items()}
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate a pipeline eval YAML")
    parser.add_argument("path", type=Path)
    args = parser.parse_args(argv)
    config = load(args.path)
    print(json.dumps({
        "path": str(args.path.resolve()),
        "sha256": file_sha256(args.path.resolve()),
        "models": len(config["models"]),
        "prompts": len(config["prompts"]),
        "datasets": len(config["datasets"]),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
