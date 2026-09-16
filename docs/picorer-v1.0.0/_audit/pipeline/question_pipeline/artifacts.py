from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def safe_component(value: str) -> str:
    readable = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")[:80]
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]
    return f"{readable or 'question'}-{digest}"


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)

