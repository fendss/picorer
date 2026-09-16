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


def data_path(data_dir: Path, task: TaskConfig) -> Path:
    return data_dir / Path(file_pin(task)["path"]).name


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_data_file(path: Path, task: TaskConfig) -> None:
    pin = file_pin(task)
    if not path.is_file():
        raise ContractError(f"Pinned dataset file is missing: {path}")
    if path.stat().st_size != pin["size"]:
        raise ContractError(f"Pinned dataset size mismatch: {path}")
    if sha256_file(path) != pin["sha256"]:
        raise ContractError(f"Pinned dataset SHA-256 mismatch: {path}")


def download_data_file(data_dir: Path, task: TaskConfig) -> Path:
    destination = data_path(data_dir, task)
    if destination.exists():
        verify_data_file(destination, task)
        return destination
    pins = load_pins()
    revision = pins["dataset"]["revision"]
    repo = pins["dataset"]["repository"]
    relative = file_pin(task)["path"]
    url = f"https://huggingface.co/datasets/{repo}/resolve/{revision}/{relative}?download=true"
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    request = Request(url, headers={"User-Agent": "picorer-memoryagentbench/0.1"})
    try:
        with urlopen(request, timeout=120) as response, temporary.open("wb") as output:
            while block := response.read(1024 * 1024):
                output.write(block)
        verify_data_file(temporary, task)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    return destination


def load_contexts(data_dir: Path, task: TaskConfig) -> tuple[Context, ...]:
    path = data_path(data_dir, task)
    verify_data_file(path, task)
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
