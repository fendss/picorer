from __future__ import annotations

import argparse
import os
import signal
import sys
from pathlib import Path

from .artifacts import read_json, write_json_atomic
from .clients import ChatClient, JsonHttpClient, MemoryClient
from .config import TASKS, task_config
from .dataset import download_data_file, load_contexts, verify_data_file, data_path
from .load_control import AdaptiveConcurrencyConfig, AdaptiveStageConcurrencyConfig
from .runner import RetryableRunUnavailable, RunInterrupted, RunSettings, execute_run
from .scoring import score_prediction


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Standalone Picorer MemoryAgentBench adapter")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="list supported tasks")
    for name in ("download", "validate"):
        command = commands.add_parser(name)
        command.add_argument("--task", action="append", choices=tuple(TASKS))
        command.add_argument("--data-dir", type=Path, default=Path("data"))
    run = commands.add_parser("run")
    run.add_argument("--task", required=True, choices=tuple(TASKS))
    run.add_argument("--data-dir", type=Path, default=Path("data"))
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--reuse-ingestion-from", type=Path)
    run.add_argument("--memory-base-url", default="http://127.0.0.1:3111")
    run.add_argument("--memory-system-name", default="picorer")
    run.add_argument("--memory-timeout-seconds", type=float, default=300.0)
    run.add_argument("--answer-base-url", required=True)
    run.add_argument("--answer-model", required=True)
    run.add_argument("--answer-thinking-level", default="off")
    run.add_argument("--answer-max-tokens", type=int)
    run.add_argument("--answer-context-window", type=int)
    run.add_argument("--answer-context-safety-tokens", type=int, default=1024)
    run.add_argument("--answer-api-key-env", default="OPENAI_API_KEY")
    run.add_argument("--answer-timeout-seconds", type=float, default=120.0)
    run.add_argument("--max-contexts", type=int)
    run.add_argument("--max-queries", type=int)
    run.add_argument(
        "--operator-mode",
        choices=("static", "ephemeral", "cumulative"),
        default="static",
    )
    run.add_argument("--max-search-calls", type=int, default=4)
    run.add_argument("--context-slots", type=int, default=1)
    run.add_argument("--query-slots", type=int, default=1)
    run.add_argument("--adaptive-query-slots", action="store_true")
    run.add_argument("--adaptive-query-slots-minimum", type=int, default=1)
    run.add_argument("--adaptive-query-slots-initial", type=int, default=1)
    run.add_argument(
        "--adaptive-query-slots-successes-per-increase",
        type=int,
        default=8,
    )
    for stage in ("retrieval", "answer"):
        prefix = f"--adaptive-{stage}-slots"
        run.add_argument(f"{prefix}-minimum", type=int)
        run.add_argument(f"{prefix}-initial", type=int)
        run.add_argument(f"{prefix}-maximum", type=int)
        run.add_argument(f"{prefix}-successes-per-increase", type=int)
    run.add_argument("--run-config-sha256")
    run.add_argument("--resume", action="store_true")
    run.add_argument(
        "--stage", choices=("both", "retrieval", "answer"), default="both"
    )
    score = commands.add_parser("score")
    score.add_argument("--input", type=Path, required=True)
    score.add_argument("--data-dir", type=Path, default=Path("data"))
    return parser


def _selected(values: list[str] | None) -> list[str]:
    return values if values else list(TASKS)


class _TerminationState:
    def __init__(self) -> None:
        self.signum: int | None = None

    def request(self, signum: int, _frame: object) -> None:
        if self.signum is not None:
            raise KeyboardInterrupt
        self.signum = signum

    def requested(self) -> bool:
        return self.signum is not None


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "list":
        for task in TASKS.values():
            print(
                f"{task.task_id}\t{task.capability}\t{task.source}\t"
                f"{task.expected_contexts} contexts/{task.expected_questions} questions\t"
                f"{task.official_metric}"
            )
        return 0
    if args.command == "download":
        for task_id in _selected(args.task):
            task = task_config(task_id)
            print(download_data_file(args.data_dir, task))
        return 0
    if args.command == "validate":
        for task_id in _selected(args.task):
            task = task_config(task_id)
            verify_data_file(data_path(args.data_dir, task), task)
            contexts = load_contexts(args.data_dir, task)
            print(f"{task_id}: {len(contexts)} contexts, {sum(len(c.queries) for c in contexts)} questions")
        return 0
    if args.command == "score":
        document = read_json(args.input)
        task = task_config(document["task"])
        for row in document["data"]:
            row["metrics"] = score_prediction(
                task, row["output"], row["answer"], args.data_dir
            )
        names = {name for row in document["data"] for name in row["metrics"]}
        document["metrics"] = {
            name: (
                sum(values) / len(values)
                if (values := [row["metrics"][name] for row in document["data"] if row["metrics"].get(name) is not None])
                else None
            )
            for name in sorted(names)
        }
        write_json_atomic(args.input, document)
        print(args.input)
        return 0
    task = task_config(args.task)
    contexts = load_contexts(args.data_dir, task)
    if args.memory_timeout_seconds <= 0:
        raise ValueError("--memory-timeout-seconds must be positive")
    if args.answer_timeout_seconds <= 0:
        raise ValueError("--answer-timeout-seconds must be positive")
    if args.answer_context_window is not None and args.answer_context_window <= 0:
        raise ValueError("--answer-context-window must be positive")
    if args.answer_context_safety_tokens < 0:
        raise ValueError("--answer-context-safety-tokens must be non-negative")
    memory = MemoryClient(
        JsonHttpClient(
            args.memory_base_url,
            timeout_seconds=args.memory_timeout_seconds,
        ),
        memory_system_name=args.memory_system_name,
    )
    api_key = os.environ.get(args.answer_api_key_env)
    chat = ChatClient(
        JsonHttpClient(
            args.answer_base_url,
            api_key=api_key,
            timeout_seconds=args.answer_timeout_seconds,
            retries=0,
        ),
        args.answer_model,
        args.answer_thinking_level,
        args.answer_max_tokens,
        args.answer_context_window,
        args.answer_context_safety_tokens,
    )
    termination = _TerminationState()
    previous_handlers = {
        signum: signal.signal(signum, termination.request)
        for signum in (signal.SIGTERM, signal.SIGINT)
    }
    try:
        adaptive_query_slots = None
        if args.adaptive_query_slots:
            shared = AdaptiveConcurrencyConfig(
                minimum=args.adaptive_query_slots_minimum,
                initial=args.adaptive_query_slots_initial,
                maximum=args.query_slots,
                successes_per_increase=(
                    args.adaptive_query_slots_successes_per_increase
                ),
            )

            def stage_config(stage: str) -> AdaptiveConcurrencyConfig:
                prefix = f"adaptive_{stage}_slots"

                def override(field: str, fallback: int) -> int:
                    value = getattr(args, f"{prefix}_{field}")
                    return fallback if value is None else value

                return AdaptiveConcurrencyConfig(
                    minimum=override("minimum", shared.minimum),
                    initial=override("initial", shared.initial),
                    maximum=override("maximum", shared.maximum),
                    successes_per_increase=(
                        override(
                            "successes_per_increase",
                            shared.successes_per_increase,
                        )
                    ),
                )

            adaptive_query_slots = AdaptiveStageConcurrencyConfig(
                retrieval=stage_config("retrieval"),
                answer=stage_config("answer"),
            )
        result = execute_run(
            task,
            contexts,
            memory,
            chat,
            RunSettings(
                output_path=args.output,
                data_dir=args.data_dir,
                reuse_ingestion_from=args.reuse_ingestion_from,
                max_contexts=args.max_contexts,
                max_queries=args.max_queries,
                resume=args.resume,
                operator_mode=args.operator_mode,
                max_search_calls=args.max_search_calls,
                context_slots=args.context_slots,
                query_slots=args.query_slots,
                adaptive_query_slots=adaptive_query_slots,
                run_config_sha256=args.run_config_sha256,
                interruption_requested=termination.requested,
                stage=args.stage,
            ),
        )
    except RunInterrupted as error:
        print(str(error), file=sys.stderr)
        return 128 + (termination.signum or signal.SIGTERM)
    except RetryableRunUnavailable as error:
        print(str(error), file=sys.stderr)
        return 75
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    print(f"wrote {result['completed_queries']} predictions to {args.output}")
    return 0
