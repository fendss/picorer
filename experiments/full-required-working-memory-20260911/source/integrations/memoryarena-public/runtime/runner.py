from __future__ import annotations

import threading
import time
from heapq import heappop, heappush
from collections import deque
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Mapping, Optional, Protocol, Sequence

from .artifacts import ArtifactStore, AttemptHandle, utc_now
from .integrity import (
    CompletenessReport,
    IntegrityError,
    audit_run,
    validate_task_manifest,
)
from .models import (
    AttemptContext,
    FailureClassification,
    FailureKind,
    NormalizedUsage,
    TaskExecutionResult,
    TaskSpec,
    TaskStatus,
)
from .retry import RetryExhaustedError, classify_provider_error
from .usage import normalize_usage

if TYPE_CHECKING:
    from .usage import PriceTable


class TaskExecutor(Protocol):
    def __call__(
        self, task: TaskSpec, context: AttemptContext, artifacts: AttemptHandle
    ) -> TaskExecutionResult: ...


@dataclass(frozen=True)
class RunnerPolicy:
    concurrency: int = 1
    task_attempts_per_invocation: int = 3
    task_retry_initial_delay_seconds: float = 1.0
    task_retry_max_delay_seconds: float = 60.0

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be at least one")
        if self.task_attempts_per_invocation < 1:
            raise ValueError("task_attempts_per_invocation must be at least one")
        if self.task_retry_initial_delay_seconds < 0:
            raise ValueError(
                "task_retry_initial_delay_seconds must be non-negative"
            )
        if self.task_retry_max_delay_seconds < self.task_retry_initial_delay_seconds:
            raise ValueError(
                "task_retry_max_delay_seconds must be greater than or equal to "
                "task_retry_initial_delay_seconds"
            )

    def retry_delay_seconds(
        self,
        *,
        prior_attempts: int,
        classification: FailureClassification,
    ) -> float:
        """Return task-group retry delay without capping provider Retry-After.

        The local exponential component is bounded.  A longer provider delay is
        authoritative: retrying earlier would violate Retry-After and hammer a
        rate-limited upstream.
        """

        exponent = min(prior_attempts, 1023)
        backoff = min(
            self.task_retry_max_delay_seconds,
            self.task_retry_initial_delay_seconds * (2.0**exponent),
        )
        provider_delay = classification.retry_after_seconds or 0.0
        return max(backoff, provider_delay)


@dataclass(frozen=True)
class _TaskOutcome:
    task: TaskSpec
    status: TaskStatus
    failure: Optional[FailureClassification] = None
    systemic_blocker: bool = False


@dataclass(frozen=True)
class RunSummary:
    started_at: str
    finished_at: str
    recovered_attempts: tuple[str, ...]
    attempts_started: int
    report: CompletenessReport

    def to_dict(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "recovered_attempts": list(self.recovered_attempts),
            "attempts_started": self.attempts_started,
            "completeness": self.report.to_dict(),
        }


def _protocol_failure(message: str) -> FailureClassification:
    return FailureClassification(
        kind=FailureKind.PROTOCOL,
        retryable=False,
        blocked=True,
        stage="task-validation",
    )


class MemoryArenaRunner:
    """Task-group supervisor for a faithful, resumable benchmark run.

    The official task group is the transactional boundary because several
    domains evolve memory across rounds/subtasks.  Every retry receives a new
    ``AttemptContext.memory_scope`` and therefore cannot inherit partial state.
    """

    def __init__(
        self,
        *,
        store: ArtifactStore,
        tasks: Sequence[TaskSpec],
        run_manifest: Mapping[str, Any],
        task_manifest: Mapping[str, Any],
        policy: RunnerPolicy = RunnerPolicy(),
        price_table: Optional["PriceTable"] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.store = store
        self.tasks = tuple(sorted(tasks, key=lambda task: task.task_key))
        self.run_manifest = dict(run_manifest)
        self.task_manifest = dict(task_manifest)
        self.policy = policy
        self.price_table = price_table
        if price_table is not None:
            existing_price_table = self.store.price_table
            if (
                existing_price_table is not None
                and existing_price_table.sha256 != price_table.sha256
            ):
                raise ValueError("runner and artifact store use different price tables")
            self.store.price_table = price_table
        self.sleep = sleep

    def _record_result_usage(
        self, handle: AttemptHandle, events: Sequence[Mapping[str, Any]]
    ) -> None:
        for event in events:
            raw_usage = event.get("usage", event)
            requested_model = str(event.get("model", "unknown"))
            response_model = (
                str(event["response_model"])
                if event.get("response_model") is not None
                else None
            )
            usage = (
                raw_usage
                if isinstance(raw_usage, NormalizedUsage)
                else normalize_usage(
                    raw_usage,
                    model=response_model or requested_model,
                    price_table=self.price_table,
                )
            )
            handle.record_usage(
                stage=str(event.get("stage", "official-agent")),
                model=requested_model,
                usage=usage,
                request_id=(
                    str(event["request_id"])
                    if event.get("request_id") is not None
                    else None
                ),
                response_model=response_model,
            )

    def _execute_one(self, task: TaskSpec, executor: TaskExecutor) -> _TaskOutcome:
        handle = self.store.start_attempt(task)
        context = handle.context
        handle.append_event(
            component="task-supervisor",
            kind="attempt-started",
            payload={"memory_scope": context.memory_scope},
        )
        try:
            result = executor(task, context, handle)
            self._record_result_usage(handle, result.usage)
            if tuple(result.completed_subtask_ids) != task.subtask_ids:
                raise IntegrityError(
                    f"task group {task.task_key} is incomplete: expected "
                    f"{task.subtask_ids}, got {tuple(result.completed_subtask_ids)}"
                )
            handle.append_event(
                component="task-supervisor",
                kind="attempt-complete",
                payload={"completed_subtask_ids": list(result.completed_subtask_ids)},
            )
            handle.finish(
                TaskStatus.SUCCEEDED,
                metadata={"result_metadata": dict(result.metadata)},
            )
            self.store.install_success(
                task=task,
                context=context,
                completed_subtask_ids=result.completed_subtask_ids,
                result=result.result,
                metadata=result.metadata,
            )
            return _TaskOutcome(task, TaskStatus.SUCCEEDED)
        except RetryExhaustedError as error:
            handle.append_event(
                component="task-supervisor",
                kind="provider-retries-exhausted",
                payload={
                    "attempts": error.attempts,
                    "failure": error.classification.to_dict(),
                },
            )
            handle.finish(
                TaskStatus.FAILED_RETRYABLE,
                failure=error.classification,
                error=error,
            )
            return _TaskOutcome(
                task,
                TaskStatus.FAILED_RETRYABLE,
                failure=error.classification,
            )
        except KeyboardInterrupt as error:
            handle.append_event(
                component="task-supervisor",
                kind="attempt-interrupted",
                payload={},
            )
            handle.finish(
                TaskStatus.PENDING,
                failure=FailureClassification(
                    FailureKind.INTERRUPTED,
                    retryable=False,
                    blocked=False,
                    stage="task-supervisor",
                ),
                error=error,
            )
            raise
        except IntegrityError as error:
            failure = _protocol_failure(str(error))
            handle.append_event(
                component="task-supervisor",
                kind="invalid-task-output",
                payload={"failure": failure.to_dict()},
            )
            handle.finish(TaskStatus.BLOCKED, failure=failure, error=error)
            return _TaskOutcome(task, TaskStatus.BLOCKED, failure=failure)
        except Exception as error:
            failure = classify_provider_error(error)
            status = (
                TaskStatus.FAILED_RETRYABLE if failure.retryable else TaskStatus.BLOCKED
            )
            handle.append_event(
                component="task-supervisor",
                kind="attempt-failed",
                payload={"failure": failure.to_dict()},
            )
            handle.finish(status, failure=failure, error=error)
            systemic = failure.kind in {
                FailureKind.AUTH,
                FailureKind.QUOTA_EXHAUSTED,
                FailureKind.MODEL_NOT_FOUND,
                FailureKind.RESPONSE_MODEL_MISMATCH,
            }
            return _TaskOutcome(
                task,
                status,
                failure=failure,
                systemic_blocker=systemic,
            )

    def run(self, executor: TaskExecutor) -> RunSummary:
        started_at = utc_now()
        attempts_started = 0
        with self.store.run_lock():
            self.store.initialize(
                run_manifest=self.run_manifest, task_manifest=self.task_manifest
            )
            _, locked_task_manifest = self.store.load_manifests()
            validate_task_manifest(locked_task_manifest, self.tasks)
            recovered = tuple(self.store.recover_stale_running())

            queue = deque(
                (task, 0)
                for task in self.tasks
                if self.store.load_success(task.task_key) is None
                and self.store.task_status(task.task_key) != TaskStatus.BLOCKED
            )
            delayed: list[tuple[float, int, TaskSpec, int]] = []
            delayed_sequence = 0
            stop_scheduling = threading.Event()
            with ThreadPoolExecutor(max_workers=self.policy.concurrency) as pool:
                active: dict[Future[_TaskOutcome], tuple[TaskSpec, int]] = {}

                def refill() -> None:
                    nonlocal attempts_started
                    while (
                        queue
                        and len(active) < self.policy.concurrency
                        and not stop_scheduling.is_set()
                    ):
                        task, prior_attempts = queue.popleft()
                        future = pool.submit(self._execute_one, task, executor)
                        active[future] = (task, prior_attempts)
                        attempts_started += 1

                refill()
                while active or queue or delayed:
                    now = time.monotonic()
                    while delayed and delayed[0][0] <= now:
                        _, _, task, prior_attempts = heappop(delayed)
                        queue.append((task, prior_attempts))
                    refill()

                    if not active:
                        if stop_scheduling.is_set():
                            break
                        if queue:
                            continue
                        if delayed and not stop_scheduling.is_set():
                            ready_at = delayed[0][0]
                            self.sleep(max(0.0, ready_at - time.monotonic()))
                            # An injected test sleeper may not advance the
                            # monotonic clock.  The completed sleep itself is
                            # the contract, so release everything due at the
                            # same instant without busy-spinning.
                            while delayed and delayed[0][0] <= ready_at:
                                _, _, task, prior_attempts = heappop(delayed)
                                queue.append((task, prior_attempts))
                            continue
                        break

                    timeout = None
                    if delayed and not queue:
                        timeout = max(0.0, delayed[0][0] - time.monotonic())
                    done, _ = wait(
                        tuple(active),
                        timeout=timeout,
                        return_when=FIRST_COMPLETED,
                    )
                    if not done:
                        continue
                    for future in done:
                        task, prior_attempts = active.pop(future)
                        try:
                            outcome = future.result()
                        except KeyboardInterrupt:
                            stop_scheduling.set()
                            for pending_future in active:
                                pending_future.cancel()
                            raise
                        if outcome.systemic_blocker:
                            stop_scheduling.set()
                        elif (
                            outcome.status == TaskStatus.FAILED_RETRYABLE
                            and prior_attempts + 1
                            < self.policy.task_attempts_per_invocation
                        ):
                            if outcome.failure is None:
                                raise AssertionError(
                                    "retryable task outcome must carry a failure "
                                    "classification"
                                )
                            delay = self.policy.retry_delay_seconds(
                                prior_attempts=prior_attempts,
                                classification=outcome.failure,
                            )
                            delayed_sequence += 1
                            heappush(
                                delayed,
                                (
                                    time.monotonic() + delay,
                                    delayed_sequence,
                                    task,
                                    prior_attempts + 1,
                                ),
                            )
                    refill()

            report = audit_run(self.store, locked_task_manifest)
            summary = RunSummary(
                started_at=started_at,
                finished_at=utc_now(),
                recovered_attempts=recovered,
                attempts_started=attempts_started,
                report=report,
            )
            self.store.write_state(summary.to_dict())
            self.store.generate_indexes()
            return summary
