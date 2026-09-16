from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from .config import TaskConfig
from .contracts import Context, ContractError, parse_context


ROOT = Path(__file__).resolve().parent.parent
PINS_PATH = ROOT / "pins.json"


def load_pins() -> dict[str, Any]:
    with PINS_PATH.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if value.get("schema_version") != 1:
        raise ContractError("Unsupported pins.json schema")
    return value


def file_pin(task: TaskConfig) -> dict[str, Any]:
    pins = load_pins()
    return pins["dataset"]["files"][task.file_key]


def auxiliary_file_pin(key: str) -> dict[str, Any]:
    pins = load_pins()
    try:
        return pins["dataset"]["auxiliary_files"][key]
    except KeyError as error:
        raise ContractError(f"Unknown auxiliary dataset file {key!r}") from error


def data_path(data_dir: Path, task: TaskConfig) -> Path:
    return data_dir / Path(file_pin(task)["path"]).name


def auxiliary_data_path(data_dir: Path, key: str) -> Path:
    return data_dir / Path(auxiliary_file_pin(key)["path"]).name


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_data_file(path: Path, task: TaskConfig) -> None:
    _verify_pinned_file(path, file_pin(task))


def verify_auxiliary_data_file(path: Path, key: str) -> None:
    _verify_pinned_file(path, auxiliary_file_pin(key))


def _verify_pinned_file(path: Path, pin: dict[str, Any]) -> None:
    if not path.is_file():
        raise ContractError(f"Pinned dataset file is missing: {path}")
    if path.stat().st_size != pin["size"]:
        raise ContractError(f"Pinned dataset size mismatch: {path}")
    if sha256_file(path) != pin["sha256"]:
        raise ContractError(f"Pinned dataset SHA-256 mismatch: {path}")


def _download_pinned_file(
    data_dir: Path, pin: dict[str, Any], revision: str, repo: str
) -> Path:
    destination = data_dir / Path(pin["path"]).name
    if destination.exists():
        _verify_pinned_file(destination, pin)
        return destination
    relative = pin["path"]
    url = f"https://huggingface.co/datasets/{repo}/resolve/{revision}/{relative}?download=true"
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    request = Request(url, headers={"User-Agent": "picorer-memoryagentbench/0.1"})
    try:
        with urlopen(request, timeout=120) as response, temporary.open("wb") as output:
            while block := response.read(1024 * 1024):
                output.write(block)
        _verify_pinned_file(temporary, pin)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return destination


def download_data_file(data_dir: Path, task: TaskConfig) -> Path:
    pins = load_pins()["dataset"]
    destination = _download_pinned_file(
        data_dir, file_pin(task), pins["revision"], pins["repository"]
    )
    for key in task.auxiliary_file_keys:
        _download_pinned_file(
            data_dir,
            auxiliary_file_pin(key),
            pins["revision"],
            pins["repository"],
        )
    return destination


def load_auxiliary_json(data_dir: Path, key: str) -> Any:
    path = auxiliary_data_path(data_dir, key)
    verify_auxiliary_data_file(path, key)
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_contexts(data_dir: Path, task: TaskConfig) -> tuple[Context, ...]:
    path = data_path(data_dir, task)
    verify_data_file(path, task)
    for key in task.auxiliary_file_keys:
        verify_auxiliary_data_file(auxiliary_data_path(data_dir, key), key)
    try:
        import pyarrow.parquet as parquet
    except ImportError as error:
        raise RuntimeError("pyarrow is required; install requirements.txt") from error
    rows = parquet.read_table(path).to_pylist()
    selected = [
        row
        for row in rows
        if isinstance(row.get("metadata"), dict)
        and row["metadata"].get("source") == task.source
    ]
    contexts = tuple(parse_context(row, index) for index, row in enumerate(selected))
    question_count = sum(len(context.queries) for context in contexts)
    if len(contexts) != task.expected_contexts:
        raise ContractError(
            f"{task.task_id} expected {task.expected_contexts} contexts, got {len(contexts)}"
        )
    if question_count != task.expected_questions:
        raise ContractError(
            f"{task.task_id} expected {task.expected_questions} questions, got {question_count}"
        )
    return contexts
