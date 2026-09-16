from __future__ import annotations

import json
import hashlib
import os
import time
from ipaddress import ip_address
from dataclasses import dataclass
from http.client import RemoteDisconnected
from typing import Any, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener, urlopen

from .context_fit import fit_memory_prompt_to_context_window


class RemoteError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        http_status: int | None = None,
        error_code: str | None = None,
        retryable: bool | None = None,
        retryability_explicit: bool | None = None,
        diagnostics: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.error_code = error_code
        self.retryable = retryable
        self.retryability_explicit = (
            retryable is not None
            if retryability_explicit is None
            else retryability_explicit
        )
        self.diagnostics = diagnostics


_DIRECT_OPENER = build_opener(ProxyHandler({}))


def _non_empty_string(record: Mapping[str, Any], field: str) -> bool:
    value = record.get(field)
    return isinstance(value, str) and bool(value.strip())


def _valid_runtime_contract(contract: dict[str, Any]) -> bool:
    skill = contract.get("skill")
    retrieval = contract.get("retrieval")
    limits = contract.get("limits")
    handoff = contract.get("answer_handoff")
    if (
        contract.get("schema_version") != 1
        or not _non_empty_string(contract, "source_identity")
        or not _non_empty_string(contract, "build_identity")
        or not isinstance(skill, dict)
        or not _non_empty_string(skill, "id")
        or not _non_empty_string(skill, "sha256")
        or not isinstance(retrieval, dict)
        or not all(
            _non_empty_string(retrieval, field)
            for field in (
                "provider_id",
                "logical_model_id",
                "route_model_id",
                "protocol",
                "thinking_level",
                "transport",
                "base_url",
            )
        )
        or not isinstance(limits, dict)
        or not all(
            isinstance(limits.get(field), int)
            and not isinstance(limits.get(field), bool)
            and limits[field] > 0
            for field in (
                "max_run_ms",
                "max_turns",
                "max_tool_calls",
                "max_search_calls",
                "request_timeout_ms",
                "max_concurrent_wraps",
            )
        )
        or not all(
            isinstance(limits.get(field), int)
            and not isinstance(limits.get(field), bool)
            and limits[field] >= 0
            for field in ("request_max_retries", "request_max_retry_delay_ms")
        )
        or not isinstance(handoff, dict)
    ):
        return False
    return True


def _is_loopback_url(url: str) -> bool:
    hostname = urlsplit(url).hostname
    if hostname == "localhost":
        return True
    if hostname is None:
        return False
    try:
        return ip_address(hostname).is_loopback
    except ValueError:
        return False


def _open(request: Request, url: str, timeout_seconds: float):
    # macOS system proxy settings are consulted by urllib even when no proxy
    # variables are present. Picorer's default loopback endpoint must stay local.
    if _is_loopback_url(url):
        return _DIRECT_OPENER.open(request, timeout=timeout_seconds)
    return urlopen(request, timeout=timeout_seconds)


@dataclass(frozen=True)
class MemoryWrapResult:
    prompt: str
    operator_experiment: dict[str, Any] | None
    retrieval_model: dict[str, Any] | None = None


@dataclass(frozen=True)
class AnswerHandoffContract:
    """Versioned prompt boundary selected from the memory service.

    The handoff identifier is sent over HTTP. ``prompt_version`` names the
    exact serialization behind that identifier and is benchmark-run identity;
    it is deliberately metadata rather than a copy of the generated prompt.
    """

    handoff_id: str
    prompt_version: str

    def __post_init__(self) -> None:
        if not self.handoff_id.strip():
            raise ValueError("answer handoff id must not be empty")
        if not self.prompt_version.strip():
            raise ValueError("answer prompt version must not be empty")


# This value is verified against the service's hashed runtime contract. Bump
# prompt_version whenever renderMemoryArenaEvidencePrompt changes, even if the
# HTTP selector remains evidence-aware-v1.
EVIDENCE_AWARE_ANSWER_HANDOFF = AnswerHandoffContract(
    handoff_id="evidence-aware-v1",
    prompt_version=(
        "memoryarena-public-budgeted-full-parent-no-summary-no-status-20260831-v3"
    ),
)


@dataclass(frozen=True)
class JsonHttpClient:
    base_url: str
    api_key: str | None = None
    timeout_seconds: float = 300.0
    retries: int = 3

    def get(self, path: str) -> dict[str, Any]:
        url = path if path.startswith("http://") or path.startswith("https://") else (
            self.base_url.rstrip("/") + "/" + path.lstrip("/")
        )
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        try:
            request = Request(url, headers=headers, method="GET")
            with _open(request, url, self.timeout_seconds) as response:
                value = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            raise RemoteError(
                f"HTTP {error.code} from {url}",
                http_status=error.code,
                retryable=False,
            ) from error
        except (URLError, TimeoutError, RemoteDisconnected, json.JSONDecodeError) as error:
            raise RemoteError(
                f"Unable to read the runtime contract from {url}",
                retryable=False,
            ) from error
        if not isinstance(value, dict):
            raise RemoteError(f"HTTP response from {url} is not an object")
        return value

    def post(
        self,
        path: str,
        body: dict[str, Any],
        retries: int | None = None,
    ) -> dict[str, Any]:
        url = path if path.startswith("http://") or path.startswith("https://") else (
            self.base_url.rstrip("/") + "/" + path.lstrip("/")
        )
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        last_error: Exception | None = None
        retry_budget = self.retries if retries is None else retries
        if retry_budget < 0:
            raise ValueError("retries must be non-negative")
        for attempt in range(retry_budget + 1):
            try:
                request = Request(url, data=payload, headers=headers, method="POST")
                with _open(request, url, self.timeout_seconds) as response:
                    value = json.loads(response.read().decode("utf-8"))
                if not isinstance(value, dict):
                    raise RemoteError(f"HTTP response from {url} is not an object")
                return value
            except HTTPError as error:
                detail = ""
                error_code: str | None = None
                explicit_retryable: bool | None = None
                diagnostics: dict[str, Any] | None = None
                try:
                    error_body = json.loads(error.read().decode("utf-8"))
                    if isinstance(error_body, dict):
                        if isinstance(error_body.get("detail"), str):
                            detail = f": {error_body['detail'][:1000]}"
                        if isinstance(error_body.get("error_code"), str):
                            error_code = error_body["error_code"][:128]
                        if isinstance(error_body.get("retryable"), bool):
                            explicit_retryable = error_body["retryable"]
                        if isinstance(error_body.get("diagnostics"), dict):
                            diagnostics = error_body["diagnostics"]
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    pass
                if error_code is None:
                    header_code = error.headers.get("x-picorer-error-code")
                    if header_code:
                        error_code = header_code[:128]
                if explicit_retryable is None:
                    header_retryable = error.headers.get("x-picorer-retryable")
                    if header_retryable is not None:
                        normalized = header_retryable.strip().casefold()
                        if normalized in {"true", "false"}:
                            explicit_retryable = normalized == "true"
                retryable = (
                    explicit_retryable
                    if explicit_retryable is not None
                    else error.code in {408, 409, 425, 429} or error.code >= 500
                )
                code_text = f" [{error_code}]" if error_code else ""
                last_error = RemoteError(
                    f"HTTP {error.code}{code_text} from {url}{detail}",
                    http_status=error.code,
                    error_code=error_code,
                    retryable=retryable,
                    retryability_explicit=explicit_retryable is not None,
                    diagnostics=diagnostics,
                )
                if not retryable or attempt == retry_budget:
                    raise last_error from error
            except (URLError, TimeoutError, RemoteDisconnected, json.JSONDecodeError) as error:
                last_error = error
                if attempt == retry_budget:
                    break
            time.sleep(min(2**attempt, 8))
        raise RemoteError(
            f"Request failed for {url}",
            retryable=True,
            retryability_explicit=False,
        ) from last_error


@dataclass(frozen=True)
class MemoryClient:
    http: JsonHttpClient
    memory_system_name: str = "picorer"
    answer_handoff: AnswerHandoffContract = EVIDENCE_AWARE_ANSWER_HANDOFF

    def runtime_identity(self) -> tuple[dict[str, Any], str, str]:
        value = self.http.get("/runtime")
        contract = value.get("runtime_contract")
        identity = value.get("runtime_identity_sha256")
        persistence_identity = value.get("persistence_identity")
        if (
            value.get("status") != "ok"
            or not isinstance(contract, dict)
            or not _valid_runtime_contract(contract)
            or not isinstance(identity, str)
            or len(identity) != 64
            or not isinstance(persistence_identity, str)
            or not persistence_identity.strip()
        ):
            raise RemoteError("Picorer runtime response violates the contract")
        actual = hashlib.sha256(
            json.dumps(
                contract,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        if actual != identity:
            raise RemoteError("Picorer runtime identity hash does not match its contract")
        handoff = contract.get("answer_handoff")
        if handoff != {
            "id": self.answer_handoff.handoff_id,
            "prompt_version": self.answer_handoff.prompt_version,
        }:
            raise RemoteError("Picorer runtime answer handoff does not match the client")
        return contract, identity, persistence_identity

    def initialize(self, user_id: str) -> None:
        value = self.http.post(
            "/memory/initialize",
            {"user_id": user_id, "memory_system_name": self.memory_system_name},
            retries=0,
        )
        if value.get("status") != "ok" or value.get("user_id") != user_id:
            raise RemoteError("Picorer initialize response violates the contract")

    def add(
        self,
        user_id: str,
        chunk: str,
        messages: Sequence[Mapping[str, str]] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "user_id": user_id,
            "memory_system_name": self.memory_system_name,
            "chunk": chunk,
        }
        if messages is not None:
            payload["messages"] = [dict(message) for message in messages]
        value = self.http.post(
            "/memory/add",
            payload,
            # If the server commits the chunk but its response is lost, a
            # transport retry would silently duplicate benchmark memory.
            retries=0,
        )
        if value.get("status") != "ok" or value.get("user_id") != user_id:
            raise RemoteError("Picorer add response violates the contract")

    def wrap(
        self,
        user_id: str,
        question: str,
        *,
        question_id: str,
        operator_mode: str,
        max_search_calls: int,
        evolution_snapshot: dict[str, Any] | None,
    ) -> MemoryWrapResult:
        experiment: dict[str, Any] = {
            "mode": operator_mode,
            "question_id": question_id,
            "max_search_calls": max_search_calls,
        }
        if evolution_snapshot is not None:
            experiment["evolution_snapshot"] = evolution_snapshot
        value = self.http.post(
            "/memory/wrap_user_prompt",
            {
                "user_id": user_id,
                "memory_system_name": self.memory_system_name,
                "question": question,
                "answer_handoff": self.answer_handoff.handoff_id,
                "operator_experiment": experiment,
            },
            # A completed retrieval changes cumulative state. Never turn a
            # method failure into retry-until-success inside the HTTP client.
            retries=0,
        )
        prompt = value.get("prompt")
        if value.get("status") != "ok" or not isinstance(prompt, str):
            raise RemoteError("Picorer wrap response violates the contract")
        raw_experiment = value.get("operator_experiment")
        if not isinstance(raw_experiment, dict):
            raise RemoteError("Picorer wrap response omitted operator experiment audit")
        if raw_experiment.get("mode") != operator_mode:
            raise RemoteError("Picorer wrap response changed operator experiment mode")
        if raw_experiment.get("questionId") != question_id:
            raise RemoteError("Picorer wrap response changed benchmark question identity")
        if raw_experiment.get("maxSearchCalls") != max_search_calls:
            raise RemoteError("Picorer wrap response changed the search-call budget")
        search_calls = raw_experiment.get("searchCalls")
        if (
            not isinstance(search_calls, int)
            or isinstance(search_calls, bool)
            or not 0 <= search_calls <= max_search_calls
        ):
            raise RemoteError("Picorer wrap response violated the search-call budget")
        snapshot = raw_experiment.get("evolutionSnapshot")
        if operator_mode == "cumulative" and not isinstance(snapshot, dict):
            raise RemoteError("Cumulative Picorer response omitted evolution snapshot")
        if operator_mode != "cumulative" and snapshot is not None:
            raise RemoteError("Non-cumulative Picorer response returned evolution state")
        retrieval_model = value.get("retrieval_model")
        if (
            not isinstance(retrieval_model, dict)
            or not isinstance(retrieval_model.get("providerId"), str)
            or not isinstance(retrieval_model.get("modelId"), str)
            or not isinstance(retrieval_model.get("responseModels"), list)
            or any(
                not isinstance(model, str)
                for model in retrieval_model.get("responseModels", [])
            )
            or not isinstance(retrieval_model.get("thinkingLevel"), str)
            or retrieval_model.get("transport") not in {"sse", "non-stream"}
        ):
            raise RemoteError("Picorer wrap response omitted retrieval model audit")
        return MemoryWrapResult(
            prompt=prompt,
            operator_experiment=raw_experiment,
            retrieval_model=retrieval_model,
        )


@dataclass(frozen=True)
class ChatClient:
    http: JsonHttpClient
    model: str
    thinking_level: str = "off"
    request_max_tokens: int | None = None
    context_window: int | None = None
    context_safety_tokens: int = 1024

    @staticmethod
    def _message(value: Any) -> Mapping[str, Any]:
        try:
            message = value["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as error:
            raise RemoteError(
                "Chat completion response violates the contract"
            ) from error
        if not isinstance(message, Mapping):
            raise RemoteError("Chat completion response violates the contract")
        return message

    @staticmethod
    def _audit_fallback(
        path: str | None,
        *,
        prompt: str,
        primary: Mapping[str, Any],
        primary_finish_reason: Any,
        fallback: Mapping[str, Any],
        fallback_finish_reason: Any,
    ) -> None:
        if not path:
            return
        record = {
            "at": time.time(),
            "policy": "same-evidence-no-thinking-v1",
            "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            "primary_content_chars": len(primary.get("content") or ""),
            "primary_reasoning_chars": len(primary.get("reasoning_content") or ""),
            "primary_finish_reason": primary_finish_reason,
            "fallback_content_chars": len(fallback.get("content") or ""),
            "fallback_reasoning_chars": len(fallback.get("reasoning_content") or ""),
            "fallback_finish_reason": fallback_finish_reason,
        }
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.write(
                descriptor,
                (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8"),
            )
        finally:
            os.close(descriptor)

    def complete(self, system_prompt: str, prompt: str, max_tokens: int) -> str:
        effective_max_tokens = self.request_max_tokens or max_tokens
        try:
            effective_prompt = (
                prompt
                if self.context_window is None
                else fit_memory_prompt_to_context_window(
                    system_prompt,
                    prompt,
                    model=self.model,
                    context_window=self.context_window,
                    max_output_tokens=effective_max_tokens,
                    safety_tokens=self.context_safety_tokens,
                )
            )
        except ValueError as error:
            raise RemoteError(
                str(error),
                error_code="answer_context_overflow",
                retryable=False,
            ) from error
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": effective_prompt},
            ],
        }
        if self.thinking_level == "off":
            body.update({"temperature": 0, "max_tokens": effective_max_tokens})
        else:
            body.update(
                {
                    "reasoning_effort": self.thinking_level,
                    "max_completion_tokens": effective_max_tokens,
                }
            )
        value = self.http.post(
            "/chat/completions",
            body,
            # Keep each answer HTTP attempt one-shot. The runner can checkpoint
            # its already-persisted prompt and let the suite resume a provider
            # outage without resampling retrieval inside this call.
            retries=0,
        )
        message = self._message(value)
        content = message.get("content")
        if (
            (not isinstance(content, str) or not content.strip())
            and self.thinking_level != "off"
            and os.environ.get("MAB_EMPTY_COMPLETION_FALLBACK") == "no-thinking"
        ):
            fallback_body = {
                **body,
                "reasoning_effort": "none",
                "max_completion_tokens": effective_max_tokens,
            }
            fallback_value = self.http.post(
                "/chat/completions", fallback_body, retries=0
            )
            fallback_message = self._message(fallback_value)
            self._audit_fallback(
                os.environ.get("MAB_ANSWER_FALLBACK_AUDIT"),
                prompt=effective_prompt,
                primary=message,
                primary_finish_reason=(
                    value.get("choices", [{}])[0].get("finish_reason")
                    if isinstance(value, Mapping)
                    else None
                ),
                fallback=fallback_message,
                fallback_finish_reason=(
                    fallback_value.get("choices", [{}])[0].get("finish_reason")
                    if isinstance(fallback_value, Mapping)
                    else None
                ),
            )
            content = fallback_message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise RemoteError(
                "Chat completion returned an empty answer",
                error_code="empty_completion",
                retryable=False,
            )
        return content.strip()
