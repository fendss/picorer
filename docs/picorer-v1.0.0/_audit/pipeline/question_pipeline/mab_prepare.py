from __future__ import annotations

import argparse
import json
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import yaml

from .artifacts import atomic_json
from .mab_manifest import _load_users, _result_path


def prepare_config(
    config_path: Path,
    adapter_root: Path,
    concurrency: int,
    dry_run: bool = False,
    selected_tasks: set[str] | None = None,
) -> dict[str, int]:
    if str(adapter_root) not in sys.path:
        sys.path.insert(0, str(adapter_root))
    config = yaml.safe_load(config_path.read_text())
    certificate = config["credentials"]["generation"].get("ca_bundle")
    if certificate:
        os.environ.setdefault("SSL_CERT_FILE", str(certificate))
    from mab_adapter.clients import JsonHttpClient, MemoryClient
    from mab_adapter.config import task_config
    from mab_adapter.dataset import load_contexts
    from mab_adapter.runner import RunSettings, _memory_appends, _user_id

    service = config["service"]
    run = config["run"]
    memory = MemoryClient(JsonHttpClient(
        f"http://{service['host']}:{service['port']}",
        timeout_seconds=float(run.get("memory_timeout_seconds", 300)),
        retries=0,
    ))
    counts = {"reused_contexts": 0, "missing_contexts": 0, "ingested_contexts": 0}
    for task_id in run["tasks"]:
        if selected_tasks is not None and task_id not in selected_tasks:
            continue
        task = task_config(task_id)
        contexts = load_contexts(Path(config["paths"]["data_dir"]), task)
        checkpoint = Path(config["paths"]["root"]) / "pipeline-ingestion" / f"{task_id}.json"
        try:
            users = _load_users(config, task_id)
        except ValueError:
            users = {}
        counts["reused_contexts"] += len(users)
        counts["missing_contexts"] += sum(
            1 for context in contexts if str(context.ordinal) not in users
        )
        if dry_run:
            continue
        lock = threading.Lock()

        def ensure(
            context,
            *,
            checkpoint=checkpoint,
            lock=lock,
            task=task,
            task_id=task_id,
            users=users,
        ) -> bool:
            context_key = str(context.ordinal)
            with lock:
                if context_key in users:
                    return False
            settings = RunSettings(
                output_path=_result_path(config, task_id),
                data_dir=Path(config["paths"]["data_dir"]),
            )
            user_id = _user_id(task, context, settings.output_path)
            timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
            last_error = None
            for attempt in range(1, 4):
                try:
                    # Reinitializing starts a clean generation, so retrying a
                    # partially observed append sequence cannot duplicate it.
                    memory.initialize(user_id)
                    for append in _memory_appends(task, context, timestamp, __import__(
                        "mab_adapter.chunking", fromlist=["chunk_text"]
                    ).chunk_text):
                        if append.messages:
                            memory.add(user_id, append.chunk, append.messages)
                        else:
                            memory.add(user_id, append.chunk)
                    with lock:
                        users[context_key] = user_id
                        atomic_json(checkpoint, {
                            "schema_version": 1,
                            "task": task_id,
                            "config_path": str(config_path),
                            "context_ingestion_users": users,
                        })
                    return True
                except Exception as error:  # noqa: BLE001 - adapter errors vary
                    last_error = error
                    if attempt < 3:
                        time.sleep(min(2 ** (attempt - 1), 8) + random.random())
            raise RuntimeError(
                f"failed to ingest {task_id} context {context.ordinal}"
            ) from last_error

        with ThreadPoolExecutor(max_workers=min(concurrency, len(contexts))) as executor:
            futures = [executor.submit(ensure, context) for context in contexts]
            for future in as_completed(futures):
                counts["ingested_contexts"] += int(future.result())
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, action="append", required=True)
    parser.add_argument("--adapter-root", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--task", action="append")
    args = parser.parse_args(argv)
    total = {"reused_contexts": 0, "missing_contexts": 0, "ingested_contexts": 0}
    for config in args.config:
        result = prepare_config(
            config, args.adapter_root, args.concurrency, args.dry_run,
            None if not args.task else set(args.task),
        )
        for key, value in result.items():
            total[key] += value
    print(json.dumps(total, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
