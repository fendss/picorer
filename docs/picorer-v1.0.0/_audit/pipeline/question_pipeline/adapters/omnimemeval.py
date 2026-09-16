from __future__ import annotations

import os
import shlex
import sys
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import requests

from ..contracts import RetryableStageError, StageResult
from ..eval_config import model as eval_model
from ..eval_config import referenced, render, settings


def _env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        parts = shlex.split(value, comments=True, posix=True)
        values[key.strip()] = parts[0] if parts else ""
    return values


class OmniMemEvalAdapter:
    """Native BEAM and LoCoMo behavior at a one-question boundary."""

    _import_lock = threading.Lock()

    def __init__(self) -> None:
        self._local = threading.local()

    def _answer_session(self) -> requests.Session:
        session = getattr(self._local, "answer_session", None)
        if session is None:
            session = requests.Session()
            session.trust_env = False
            self._local.answer_session = session
        return session

    @staticmethod
    def _raise_retrieval_error(error: requests.RequestException) -> None:
        if isinstance(error, requests.HTTPError) and error.response is not None:
            try:
                body = error.response.json()
            except ValueError:
                body = {}
            typed_safe = (
                error.response.status_code == 429
                or (
                    isinstance(body, dict)
                    and body.get("retryable") is True
                    and body.get("error_code") in {
                        "append_pending", "upstream_unavailable"
                    }
                )
            )
            if typed_safe:
                raise RetryableStageError(str(error)) from error
        # A lost retrieval response may follow a completed stochastic agent
        # run. Fail closed so automatic retry cannot resample it.
        raise RuntimeError(str(error)) from error

    def _client(self, payload: Mapping[str, Any]):
        key = (str(payload["omni_root"]), str(payload["env_file"]))
        clients = getattr(self._local, "clients", None)
        if clients is None:
            clients = self._local.clients = {}
        if key in clients:
            return clients[key]
        values = _env_file(key[1])
        with self._import_lock:
            scripts = str(Path(key[0]) / "scripts")
            if scripts not in sys.path:
                sys.path.insert(0, scripts)
            previous = {name: os.environ.get(name) for name in values}
            os.environ.update(values)
            try:
                from client_factory import create_client

                client = create_client("picorer")
            finally:
                for name, value in previous.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value
        clients[key] = client
        return client

    def _completion_request(
        self,
        payload: Mapping[str, Any],
        prompt: str,
        *,
        model_name: str | None = None,
        system_prompt: str = "",
        max_tokens: int | None = None,
    ) -> str:
        dataset = settings(payload)
        if dataset is None:
            values = _env_file(str(payload["env_file"]))
            model = {
                "id": values["ANSWER_MODEL"],
                "base_url": values["ANSWER_BASE_URL"],
                "api_key": values.get("ANSWER_API_KEY"),
                "timeout_seconds": float(values.get("ANSWER_TIMEOUT_SECONDS", 600)),
                "thinking_level": "off",
            }
        else:
            if model_name is None:
                model_name = str(dataset["answer"]["model"])
            model = eval_model(payload, model_name)
        url = str(model["base_url"]).rstrip("/") + "/chat/completions"
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        body = {
            "model": model["id"],
            "messages": messages,
        }
        thinking_level = str(model.get("thinking_level", "off"))
        if thinking_level == "off":
            body["temperature"] = 0
            if max_tokens is not None:
                body["max_tokens"] = max_tokens
        else:
            body["reasoning_effort"] = thinking_level
            if max_tokens is not None:
                body["max_completion_tokens"] = max_tokens
        headers = {"Content-Type": "application/json"}
        if model.get("api_key"):
            headers["Authorization"] = f"Bearer {model['api_key']}"
        timeout = float(model.get("timeout_seconds", 600))
        try:
            response = self._answer_session().post(
                url, json=body, headers=headers, timeout=timeout,
            )
        except requests.RequestException as error:
            raise RetryableStageError(str(error)) from error
        if response.status_code in {408, 429} or response.status_code >= 500:
            raise RetryableStageError(
                f"answer HTTP {response.status_code}: {response.text[:1000]}"
            )
        if not response.ok:
            raise RuntimeError(
                f"answer HTTP {response.status_code}: {response.text[:2000]}"
            )
        try:
            answer = response.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise RuntimeError("answer response violates OpenAI chat schema") from error
        if not isinstance(answer, str) or not answer.strip():
            if dataset is None:
                raise RuntimeError("answer completion is empty")
            raise RetryableStageError("completion is empty")
        return answer.strip()

    def _answer_request(self, payload: Mapping[str, Any], prompt: str) -> str:
        dataset = settings(payload)
        max_tokens = (
            None
            if dataset is None
            else dataset["answer"].get("max_tokens")
        )
        return self._completion_request(
            payload,
            prompt,
            max_tokens=None if max_tokens is None else int(max_tokens),
        )

    def _beam_retrieval(self, payload: Mapping[str, Any]) -> StageResult:
        scripts = str(Path(str(payload["omni_root"])) / "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        from beam.beam_common import build_search_entry, classify_search_status
        from utils.search_helpers import dispatch_search, unpack_search_result

        started = time.monotonic()
        try:
            result = dispatch_search(
                "picorer", self._client(payload), str(payload["question"]),
                str(payload["user_id"]), int(payload.get("top_k", 20)),
            )
            context, duration_ms, reflect_answer, raw_context = unpack_search_result(result)
        except requests.RequestException as error:
            self._raise_retrieval_error(error)
        meta = {
            "key": payload["key"],
            "conv_id": payload["conv_id"],
            "question_idx": payload["question_idx"],
            "dimension": payload["dimension"],
            "scale": payload["scale"],
            "question": {
                "question": payload["question"],
                "answer": payload["golden_answer"],
                "rubric": payload.get("rubric", ""),
                "difficulty": payload.get("difficulty", ""),
            },
        }
        entry = build_search_entry(
            meta,
            context=context or "",
            duration_ms=duration_ms,
            status=classify_search_status(
                context or "", reflect_answer, raw_context=raw_context,
            ),
            reflect_answer=reflect_answer,
        )
        entry["pipeline_wall_seconds"] = time.monotonic() - started
        return StageResult({"search_record": entry})

    def _locomo_retrieval(self, payload: Mapping[str, Any]) -> StageResult:
        scripts = str(Path(str(payload["omni_root"])) / "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        from locomo.locomo_common import classify_search_status
        from locomo.locomo_search import generic_text_search
        from utils.search_helpers import unpack_search_result

        try:
            result = generic_text_search(
                self._client(payload), str(payload["question"]),
                str(payload["speaker_a_user_id"]),
                str(payload["speaker_b_user_id"]),
                int(payload.get("top_k", 20)),
                str(payload["speaker_a"]), str(payload["speaker_b"]),
            )
            context, duration_ms, reflect_answer, raw_context = unpack_search_result(result)
        except requests.RequestException as error:
            self._raise_retrieval_error(error)
        record = {
            "query": payload["question"],
            "context": context or "",
            "duration_ms": duration_ms,
            "status": classify_search_status(
                context or "", reflect_answer, raw_context=raw_context,
            ),
        }
        if reflect_answer is not None:
            record["reflect_answer"] = reflect_answer
        return StageResult({"search_record": record})

    def _answer(self, payload: Mapping[str, Any], search: Mapping[str, Any]) -> StageResult:
        scripts = str(Path(str(payload["omni_root"])) / "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        search_record = search["search_record"]
        reflect_answer = search_record.get("reflect_answer")
        started = time.monotonic()
        dataset = settings(payload)
        if payload["suite"] == "beam":
            if dataset is None:
                from utils.prompts import BEAM_ANSWER_PROMPT

                prompt = BEAM_ANSWER_PROMPT.format(
                    context=search_record.get("search_context", ""),
                    question=payload["question"],
                )
            else:
                prompt_config = referenced(
                    payload, "prompts", str(dataset["answer"]["prompt"])
                )
                prompt = render(
                    str(prompt_config["user"]),
                    context=search_record.get("search_context", ""),
                    question=payload["question"],
                )
            answer = reflect_answer or self._answer_request(payload, prompt)
            duration_ms = (time.monotonic() - started) * 1000
            return StageResult({"response_record": {
                "key": payload["key"],
                "conv_id": payload["conv_id"],
                "question_idx": payload["question_idx"],
                "question": payload["question"],
                "answer": answer,
                "golden_answer": payload["golden_answer"],
                "rubric": payload.get("rubric", ""),
                "dimension": payload["dimension"],
                "scale": payload["scale"],
                "difficulty": payload.get("difficulty", ""),
                "response_duration_ms": duration_ms,
                "search_duration_ms": search_record.get("search_duration_ms", 0),
                "status": "success",
                "model_input": None if reflect_answer else [{"role": "user", "content": prompt}],
            }})
        from locomo.locomo_responses import _dedup_shared_context

        context = _dedup_shared_context(search_record.get("context", ""))
        if dataset is None:
            from utils.prompts import LOCOMO_ANSWER_PROMPT

            prompt = LOCOMO_ANSWER_PROMPT.format(
                context=context, question=payload["question"],
            )
        else:
            prompt_config = referenced(
                payload, "prompts", str(dataset["answer"]["prompt"])
            )
            prompt = render(
                str(prompt_config["user"]),
                context=context,
                question=payload["question"],
            )
        answer = reflect_answer or self._answer_request(payload, prompt)
        duration_ms = (time.monotonic() - started) * 1000
        return StageResult({"response_record": {
            "question": payload["question"],
            "answer": answer,
            "category": payload["category"],
            "golden_answer": payload["golden_answer"],
            "response_duration_ms": duration_ms,
            "search_duration_ms": search_record.get("duration_ms", 0),
            "status": "success",
            "model_input": None if reflect_answer else [{"role": "user", "content": prompt}],
        }})

    def _judge_request(
        self,
        payload: Mapping[str, Any],
        judge: Mapping[str, Any],
        prompt_name: str,
        **values: Any,
    ) -> str:
        prompt = referenced(payload, "prompts", prompt_name)
        return self._completion_request(
            payload,
            render(str(prompt["user"]), **values),
            model_name=str(judge["model"]),
            system_prompt=str(prompt.get("system", "")),
            max_tokens=int(judge.get("max_tokens", 512)),
        )

    def run(
        self,
        stage: str,
        payload: Mapping[str, Any],
        prior: Mapping[str, Mapping[str, Any]],
    ) -> StageResult:
        if stage == "retrieval":
            return (
                self._beam_retrieval(payload)
                if payload["suite"] == "beam"
                else self._locomo_retrieval(payload)
            )
        if stage == "answer":
            return self._answer(payload, prior["retrieval"])
        dataset = settings(payload)
        if dataset is None or dataset["judge"]["method"] == "deferred":
            return StageResult(
                {"reason": "native OmniMemEval LLM judge is intentionally deferred"},
                status="waiting_external",
            )
        judge = dataset["judge"]
        response_record = prior["answer"]["response_record"]

        def call(prompt_name: str, **values: Any) -> str:
            return self._judge_request(payload, judge, prompt_name, **values)

        if judge["method"] == "binary":
            from ..omni_judges import binary

            return StageResult(binary(payload, response_record, judge, call))
        if judge["method"] == "beam":
            from ..omni_judges import beam

            return StageResult(beam(payload, response_record, judge, call))
        raise RuntimeError(f"unsupported OmniMemEval judge method: {judge['method']}")
