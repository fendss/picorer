from __future__ import annotations

import argparse
import fcntl
import os
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

from .artifacts import atomic_json
from .state import PipelineState


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="Run and monitor all question pipeline stages")
    value.add_argument("--state", type=Path, required=True)
    value.add_argument("--redis-url", default="redis://127.0.0.1:6380/0")
    value.add_argument("--namespace", required=True)
    value.add_argument("--artifacts", type=Path, required=True)
    value.add_argument("--logs", type=Path, required=True)
    value.add_argument("--retrieval-concurrency", type=int, default=16)
    value.add_argument("--answer-concurrency", type=int, default=16)
    value.add_argument("--evaluation-concurrency", type=int, default=4)
    value.add_argument("--max-answer-backlog", type=int, default=64)
    value.add_argument("--stale-seconds", type=float, default=1200)
    value.add_argument("--grace-seconds", type=float, default=30)
    value.add_argument("--max-restarts", type=int, default=5)
    value.add_argument("--poll-seconds", type=float, default=2)
    value.add_argument("--mab-export-dir", type=Path)
    value.add_argument("--omni-export-dir", type=Path)
    return value


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    lock_path = args.state.with_suffix(args.state.suffix + ".supervisor.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock = lock_path.open("a+b")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        lock.close()
        raise RuntimeError(
            f"another supervisor already owns {lock_path}"
        ) from error
    args.logs.mkdir(parents=True, exist_ok=True)
    args.artifacts.mkdir(parents=True, exist_ok=True)
    state = PipelineState(args.state)
    stop = False
    children: dict[str, subprocess.Popen] = {}
    logs: dict[str, object] = {}
    restarts = {stage: 0 for stage in ("retrieval", "answer", "evaluation")}
    concurrency = {
        "retrieval": args.retrieval_concurrency,
        "answer": args.answer_concurrency,
        "evaluation": args.evaluation_concurrency,
    }

    def request_stop(_signum: int, _frame: object) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    def start(stage: str) -> None:
        log = (args.logs / f"{stage}.log").open("ab", buffering=0)
        command = [
            sys.executable, "-m", "question_pipeline.cli",
            "--state", str(args.state),
            "--redis-url", args.redis_url,
            "--namespace", args.namespace,
            "worker", "--stage", stage,
            "--artifacts", str(args.artifacts),
            "--concurrency", str(concurrency[stage]),
            "--stale-seconds", str(args.stale_seconds),
        ]
        if stage == "retrieval":
            command.extend(["--max-downstream-backlog", str(args.max_answer_backlog)])
        children[stage] = subprocess.Popen(
            command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        logs[stage] = log

    for stage in concurrency:
        start(stage)
    atomic_json(args.logs / "supervisor.json", {
        "pid": os.getpid(),
        "started_at": time.time(),
        "lock": str(lock_path),
        "children": {stage: child.pid for stage, child in children.items()},
        "concurrency": concurrency,
    })
    exit_code = 0
    try:
        while not stop:
            if state.settled():
                break
            for stage, child in list(children.items()):
                code = child.poll()
                if code is None:
                    continue
                logs.pop(stage).close()
                restarts[stage] += 1
                if restarts[stage] > args.max_restarts:
                    exit_code = 1
                    stop = True
                    break
                time.sleep(min(2 ** restarts[stage], 10))
                start(stage)
            time.sleep(args.poll_seconds)
    finally:
        for child in children.values():
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        deadline = time.time() + args.grace_seconds
        while time.time() < deadline and any(
            child.poll() is None for child in children.values()
        ):
            time.sleep(0.2)
        for child in children.values():
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
        for child in children.values():
            child.wait()
        for log in logs.values():
            log.close()
        state.checkpoint()
        exports: dict[str, object] = {}
        export_error = None
        if exit_code == 0 and state.settled():
            try:
                if args.mab_export_dir is not None:
                    from .mab_export import export as export_mab

                    exports["agentmemorybench"] = export_mab(
                        args.state, args.mab_export_dir,
                    )
                if args.omni_export_dir is not None:
                    from .omni_export import export as export_omni

                    exports["omnimemeval"] = export_omni(
                        args.state, args.omni_export_dir,
                    )
            except Exception:  # noqa: BLE001 - preserve the final export failure
                exit_code = 1
                export_error = traceback.format_exc()[-8000:]
        atomic_json(args.logs / "supervisor-final.json", {
            "pid": os.getpid(),
            "finished_at": time.time(),
            "exit_code": exit_code,
            "settled": state.settled(),
            "counts": state.counts(),
            "restarts": restarts,
            "exports": exports,
            "export_error": export_error,
        })
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
