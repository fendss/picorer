from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml

from ..contracts import RetryableStageError, StageResult
from ..eval_config import model as eval_model
from ..eval_config import referenced, render, settings
from ..openai_compat import Completion, CompletionClient


class MemoryAgentBenchAdapter:
    """One MemoryAgentBench question per call.

    Context ingestion is a separate prerequisite. The payload holds only the
    already-ingested user id and immutable question metadata; it never embeds a
    full context or an API key.
    """

    def __init__(self) -> None:
        self._runtimes: dict[str, tuple[Any, Any]] = {}
        self._configured_chats: dict[tuple[str, str], Any] = {}
        self._judge_client = CompletionClient()

    def _runtime(self, config_path: str):
        cached = self._runtimes.get(config_path)
        if cached is not None:
            return cached
        config = yaml.safe_load(Path(config_path).read_text())
        # Match the established benchmark runner: an empty thinking response
        # gets one answer-only retry against the exact same evidence package.
        os.environ.setdefault("MAB_EMPTY_COMPLETION_FALLBACK", "no-thinking")
        certificate = config["credentials"]["generation"].get("ca_bundle")
        if certificate:
            os.environ.setdefault("SSL_CERT_FILE", str(certificate))
        from mab_adapter.clients import ChatClient, JsonHttpClient, MemoryClient

        service = config["service"]
        run = config["run"]
        generation = config["credentials"]["generation"]
        answer = config["models"]["answer"]
        memory = MemoryClient(
            JsonHttpClient(
                f"http://{service['host']}:{service['port']}",
                timeout_seconds=float(run.get("memory_timeout_seconds", 300)),
                retries=0,
            )
        )
        chat = ChatClient(
            JsonHttpClient(
                generation["base_url"],
                api_key=generation["api_key"],
                timeout_seconds=float(run.get("answer_timeout_seconds", 120)),
                retries=0,
            ),
            str(answer.get("route_id") or answer["id"]),
            str(answer.get("thinking_level", "off")),
            int(answer.get("max_tokens", 4096)),
            int(answer.get("context_window", 128000)),
            int(answer.get("context_safety_tokens", 1024)),
        )
        contract, _identity, _persistence = memory.runtime_identity()
        for field in ("source_identity", "build_identity"):
            expected = service.get(field)
            if expected and contract.get(field) != expected:
                raise RuntimeError(
                    f"memory runtime {field} drift: expected {expected!r}, "
                    f"got {contract.get(field)!r}"
                )
        self._runtimes[config_path] = (memory, chat)
        return memory, chat

    @staticmethod
    def _configure_certificate(config_path: str) -> None:
        config = yaml.safe_load(Path(config_path).read_text())
        certificate = config["credentials"]["generation"].get("ca_bundle")
        if certificate:
            os.environ.setdefault("SSL_CERT_FILE", str(certificate))

    @staticmethod
    def _translate(error: BaseException, stage: str) -> BaseException:
        from mab_adapter.clients import RemoteError

        if not isinstance(error, RemoteError):
            return error
        typed_retrieval_retry = (
            error.retryability_explicit is True
            and error.retryable is True
            and (
                error.http_status == 429
                or error.error_code in {"append_pending", "upstream_unavailable"}
            )
        )
        protocol_retry = (
            stage == "retrieval"
            and error.http_status == 422
            and error.error_code == "retrieval_agent_protocol_error"
        )
        completion_retry = (
            stage in {"answer", "evaluation"}
            and error.retryable is True
            and (
                error.http_status is None
                or error.http_status in {408, 429}
                or error.http_status >= 500
            )
        )
        # A missing valid finish can be stochastic. The per-stage max_attempts
        # cap keeps recovery bounded, while the first failure remains in events.
        if typed_retrieval_retry or protocol_retry or completion_retry:
            return RetryableStageError(str(error))
        return error

    def _configured_chat(
        self, payload: Mapping[str, Any], model_name: str
    ) -> Any:
        binding = payload["eval_config"]
        key = (str(binding["sha256"]), model_name)
        cached = self._configured_chats.get(key)
        if cached is not None:
            return cached
        from mab_adapter.clients import ChatClient, JsonHttpClient

        model = eval_model(payload, model_name)
        chat = ChatClient(
            JsonHttpClient(
                str(model["base_url"]),
                api_key=model.get("api_key"),
                timeout_seconds=float(model.get("timeout_seconds", 600)),
                retries=0,
            ),
            str(model["id"]),
            str(model.get("thinking_level", "off")),
            None,
            (
                None
                if model.get("context_window") is None
                else int(model["context_window"])
            ),
            int(model.get("context_safety_tokens", 1024)),
        )
        self._configured_chats[key] = chat
        return chat

    def _configured_answer(
        self,
        payload: Mapping[str, Any],
        retrieved: Mapping[str, Any],
        max_tokens: int,
    ) -> str:
        dataset = settings(payload)
        if dataset is None:
            raise RuntimeError("eval settings are missing")
        answer = dataset["answer"]
        prompt = referenced(payload, "prompts", str(answer["prompt"]))
        user_prompt = render(
            str(prompt["user"]), retrieval=str(retrieved["wrapped_prompt"])
        )
        chat = self._configured_chat(payload, str(answer["model"]))
        return chat.complete(
            str(prompt.get("system", "")),
            user_prompt,
            int(answer.get("max_tokens", max_tokens)),
        )

    def _longmemeval_judge(
        self,
        payload: Mapping[str, Any],
        prediction: str,
        judge: Mapping[str, Any],
    ) -> StageResult:
        question_type = str(payload.get("question_type", ""))
        family_key = (
            "abstention"
            if "_abs" in str(payload.get("question_id", ""))
            else question_type
        )
        family = judge["prompt_family"]
        try:
            prompt_name = str(family[family_key])
        except KeyError as error:
            raise RuntimeError(
                f"LongMemEval has no judge prompt for {family_key!r}"
            ) from error
        prompt = referenced(payload, "prompts", prompt_name)
        user_prompt = render(
            str(prompt["user"]),
            question=payload["question"],
            golden_answer=repr(list(payload["answers"])),
            response=prediction,
        )
        messages = []
        if prompt.get("system"):
            messages.append({"role": "system", "content": str(prompt["system"])})
        messages.append({"role": "user", "content": user_prompt})
        completion = self._judge_client.complete(
            payload,
            str(judge["model"]),
            messages,
            int(judge.get("max_tokens", 10)),
        )
        label = re.search(r"\b(yes|no)\b", completion.text, flags=re.IGNORECASE)
        if label is None:
            raise RetryableStageError(
                "LongMemEval judge response is not yes/no: "
                f"{completion.text[:200]}"
            )
        correct = label.group(1).casefold() == "yes"
        return StageResult({
            "metrics": {"official_score": float(correct)},
            "judge_response": completion.text,
            "judge_model": completion.response_model,
            "judge_prompt": prompt_name,
            "judge_usage": completion.usage,
        })

    def _judge_call(
        self,
        payload: Mapping[str, Any],
        judge: Mapping[str, Any],
        prompt_name: str,
        **values: Any,
    ) -> Completion:
        prompt = referenced(payload, "prompts", prompt_name)
        messages = []
        if prompt.get("system"):
            messages.append({"role": "system", "content": str(prompt["system"])})
        messages.append({
            "role": "user",
            "content": render(str(prompt["user"]), **values),
        })
        return self._judge_client.complete(
            payload,
            str(judge["model"]),
            messages,
            int(judge.get("max_tokens", 4096)),
        )

    def _infbench_judge(
        self,
        payload: Mapping[str, Any],
        prediction: str,
        judge: Mapping[str, Any],
    ) -> StageResult:
        from ..infbench_judge import evaluate

        def call(prompt_name: str, **values: Any) -> Completion:
            return self._judge_call(payload, judge, prompt_name, **values)

        return StageResult(evaluate(payload, prediction, judge, call))

    def run(
        self,
        stage: str,
        payload: Mapping[str, Any],
        prior: Mapping[str, Mapping[str, Any]],
    ) -> StageResult:
        adapter_root = str(payload["adapter_root"])
        if adapter_root not in os.sys.path:
            os.sys.path.insert(0, adapter_root)
        # mab_adapter.clients builds its direct urllib opener at import time.
        # Configure the private endpoint CA before importing any mab module.
        self._configure_certificate(str(payload["config_path"]))
        from mab_adapter.config import task_config
        from mab_adapter.runner import SYSTEM_PROMPT
        from mab_adapter.scoring import score_prediction

        task = task_config(str(payload["task_id"]))
        memory, chat = self._runtime(str(payload["config_path"]))
        if stage == "retrieval":
            formatted = task.format_query(str(payload["question"]))
            try:
                wrapped = memory.wrap(
                    str(payload["user_id"]),
                    formatted,
                    question_id=str(payload["benchmark_query_id"]),
                    operator_mode=str(payload.get("operator_mode", "static")),
                    max_search_calls=int(payload.get("max_search_calls", 8)),
                    evolution_snapshot=None,
                )
            except BaseException as error:
                raise self._translate(error, stage) from error
            return StageResult({
                "formatted_query": formatted,
                "wrapped_prompt": wrapped.prompt,
                "operator_experiment": wrapped.operator_experiment,
                "retrieval_model": wrapped.retrieval_model,
            })
        if stage == "answer":
            retrieved = prior["retrieval"]
            try:
                prediction = (
                    chat.complete(
                        SYSTEM_PROMPT,
                        str(retrieved["wrapped_prompt"]),
                        task.generation_max_tokens,
                    )
                    if settings(payload) is None
                    else self._configured_answer(
                        payload, retrieved, task.generation_max_tokens
                    )
                )
            except BaseException as error:
                raise self._translate(error, stage) from error
            return StageResult({"prediction": prediction})
        dataset = settings(payload)
        judge = None if dataset is None else dataset["judge"]
        if judge is not None and judge["method"] == "longmemeval":
            return self._longmemeval_judge(
                payload, str(prior["answer"]["prediction"]), judge
            )
        if judge is not None and judge["method"] == "infbench":
            return self._infbench_judge(
                payload, str(prior["answer"]["prediction"]), judge
            )
        if (
            (judge is not None and judge["method"] == "deferred")
            or (judge is None and payload.get("external_judge"))
        ):
            return StageResult(
                {"reason": (
                    str(judge.get("reason", "benchmark requires an external LLM judge"))
                    if judge is not None
                    else "benchmark requires an external LLM judge"
                )},
                status="waiting_external",
            )
        prediction = str(prior["answer"]["prediction"])
        metrics = score_prediction(
            task,
            prediction,
            tuple(str(value) for value in payload["answers"]),
            Path(str(payload["data_dir"])),
        )
        return StageResult({"metrics": metrics})
