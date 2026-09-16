from __future__ import annotations

import argparse
import json
from pathlib import Path

from .contracts import STAGES
from .runtime import Worker
from .state import PipelineState
from .transport import RedisTransport


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Durable per-question Picorer benchmark pipeline")
    root.add_argument("--state", type=Path, required=True)
    root.add_argument("--redis-url", default="redis://127.0.0.1:6380/0")
    root.add_argument("--namespace", required=True)
    commands = root.add_subparsers(dest="command", required=True)
    initialize = commands.add_parser("init")
    initialize.add_argument("--manifest", type=Path, required=True)
    worker = commands.add_parser("worker")
    worker.add_argument("--stage", choices=STAGES, required=True)
    worker.add_argument("--artifacts", type=Path, required=True)
    worker.add_argument("--concurrency", type=int, required=True)
    worker.add_argument("--stale-seconds", type=float, default=1200)
    worker.add_argument("--max-downstream-backlog", type=int)
    commands.add_parser("status")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    state = PipelineState(args.state)
    if args.command == "status":
        print(json.dumps(state.snapshot(), indent=2))
        return 0
    transport = RedisTransport(args.redis_url, args.namespace)
    if args.command == "init":
        manifest = json.loads(args.manifest.read_text())
        if manifest.get("schema_version") != 2:
            raise ValueError("manifest.schema_version must be 2")
        inserted = state.initialize(manifest["questions"])
        queued = 0
        for question_id, stage in state.queue_ready():
            transport.ensure_group(stage)
            transport.enqueue(question_id, stage)
            queued += 1
        print(json.dumps({"inserted": inserted, "queued": queued}))
        return 0
    Worker(
        state, transport, args.stage, args.artifacts, args.concurrency,
        args.stale_seconds, args.max_downstream_backlog,
    ).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
