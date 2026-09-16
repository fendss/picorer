#!/usr/bin/env python3
"""Display durable benchmark progress from per-question record files."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from tqdm import tqdm

TERMINAL_STATUSES = {"complete", "failed", "package-failed"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--records-dir", type=Path, required=True)
    parser.add_argument("--failures-dir", type=Path, required=True)
    parser.add_argument("--status-file", type=Path, required=True)
    parser.add_argument("--progress-file", type=Path, required=True)
    parser.add_argument("--total", type=int, required=True)
    parser.add_argument("--interval", type=float, default=0.5)
    args = parser.parse_args()
    if args.total <= 0:
        parser.error("--total must be positive")
    if args.interval <= 0:
        parser.error("--interval must be positive")
    return args


def record_ids(directory: Path) -> set[str]:
    if not directory.exists():
        return set()
    return {
        path.stem
        for path in directory.glob("*.json")
        if not path.name.startswith(".")
    }


def read_status(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return "starting"


def write_atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=True, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    args = parse_args()
    started = time.monotonic()
    initial_successes = record_ids(args.records_dir)
    initial_completed = len(initial_successes)

    with tqdm(
        total=args.total,
        initial=min(initial_completed, args.total),
        desc="Picorer retrieval+answer",
        unit="q",
        dynamic_ncols=True,
        file=sys.stderr,
    ) as progress:
        while True:
            successes = record_ids(args.records_dir)
            failures = record_ids(args.failures_dir) - successes
            completed = min(len(successes), args.total)
            settled = min(len(successes | failures), args.total)
            progress.update(max(0, completed - progress.n))

            elapsed = max(time.monotonic() - started, 0.001)
            completed_now = max(0, completed - initial_completed)
            rate = completed_now / elapsed
            remaining = max(0, args.total - completed)
            eta_seconds = remaining / rate if rate > 0 else None
            status = read_status(args.status_file)
            progress.set_postfix(
                ok=len(successes),
                failed=len(failures),
                status=status,
                refresh=False,
            )
            progress.refresh()

            write_atomic_json(
                args.progress_file,
                {
                    "schema_version": 1,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "status": status,
                    "total": args.total,
                    "completed": completed,
                    "settled": settled,
                    "succeeded": len(successes),
                    "failed": len(failures),
                    "remaining": remaining,
                    "percent": round(completed * 100 / args.total, 2),
                    "elapsed_seconds": round(elapsed, 3),
                    "questions_per_second": round(rate, 6),
                    "eta_seconds": None if eta_seconds is None else round(eta_seconds, 3),
                },
            )

            if status in TERMINAL_STATUSES:
                break
            time.sleep(args.interval)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
