from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse

from runtime.artifacts import (
    ArtifactStore,
    JudgeCacheKey,
    canonical_sha256,
    locked_manifest_document,
    read_json,
    validate_locked_manifest,
    write_json_atomic,
)
from runtime.usage import PriceTable, UsageNormalizationError, normalize_usage

from .contracts import OFFICIAL_CODE_REVISION, UpstreamExecutionError


def _messages(body: Mapping[str, Any], role: str) -> list[Any]:
    messages = body.get("messages")
    if not isinstance(messages, list):
        return []
    return [item.get("content") for item in messages if isinstance(item, Mapping) and item.get("role") == role]


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        preferred = [
            value[key]
            for key in ("text", "content", "input_text", "output_text")
            if key in value
        ]
        return "\n".join(_content_text(item) for item in preferred)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return "\n".join(_content_text(item) for item in value)
    return ""


def _cache_key(body: Mapping[str, Any], endpoint: str, adapter_version: str) -> JudgeCacheKey:
    model = body.get("model")
    if not isinstance(model, str) or not model:
        raise UpstreamExecutionError("official evaluator judge request has no model")
    system = body.get("instructions", _messages(body, "system"))
    user = body.get("input", _messages(body, "user"))
    request_digest = canonical_sha256(body)
    reasoning = body.get("reasoning")
    return JudgeCacheKey(
        evaluator_revision=OFFICIAL_CODE_REVISION,
        judge_adapter_version=f"{adapter_version}:{endpoint}",
        system_prompt_sha256=canonical_sha256(system),
        user_prompt_sha256=canonical_sha256(user),
        # The complete immutable request binds prediction and reference even
        # where an official prompt does not expose safe field delimiters.
        prediction_sha256=request_digest,
        reference_sha256=request_digest,
        requested_model=model,
        observed_model_policy="provider-response-model-recorded",
        temperature=float(body.get("temperature", 0.0)),
        reasoning=(canonical_sha256(reasoning) if reasoning is not None else None),
        max_output_tokens=(
            int(body["max_output_tokens"])
            if body.get("max_output_tokens") is not None
            else (
                int(body["max_tokens"])
                if body.get("max_tokens") is not None
                else None
            )
        ),
    )


def _response_text(endpoint: str, value: Mapping[str, Any]) -> str:
    if endpoint.endswith("/chat/completions"):
        choices = value.get("choices")
        if isinstance(choices, list) and choices and isinstance(choices[0], Mapping):
            message = choices[0].get("message")
            if isinstance(message, Mapping) and isinstance(message.get("content"), str):
                return str(message["content"])
        return ""
    direct = value.get("output_text")
    if isinstance(direct, str):
        return direct
    output = value.get("output")
    if isinstance(output, list):
        for item in reversed(output):
            content = item.get("content") if isinstance(item, Mapping) else None
            if not isinstance(content, list):
                continue
            for part in reversed(content):
                if isinstance(part, Mapping) and part.get("type") == "output_text":
                    text = part.get("text")
                    if isinstance(text, str):
                        return text
    return ""


def _parse_valid(endpoint: str, value: Mapping[str, Any]) -> tuple[bool, Any]:
    text = _response_text(endpoint, value)
    if not text:
        return False, None
    if endpoint.endswith("/chat/completions"):
        cleaned = re.sub(r"^```[a-zA-Z0-9_-]*\n|\n```$", "", text.strip())
        start, end = cleaned.find("{"), cleaned.rfind("}")
        try:
            parsed = json.loads(cleaned[start : end + 1])
        except (ValueError, json.JSONDecodeError):
            return False, None
        matches = parsed.get("matches") if isinstance(parsed, Mapping) else None
        valid = isinstance(matches, list) and all(
            isinstance(item, Mapping)
            and isinstance(item.get("attribute"), str)
            and isinstance(item.get("has_attribute"), bool)
            for item in matches
        )
        return valid, parsed if valid else None
    correct = re.search(r"(?:\*\*)?correct(?::\*\*|\*\*:|:)\s*(yes|no)", text, re.I)
    return correct is not None, {"correct": correct.group(1).lower() == "yes"} if correct else None


class JudgeCacheProxy:
    """OpenAI-compatible, resumable cache around unmodified official judges."""

    def __init__(
        self,
        *,
        upstream_base_url: str,
        api_key: str,
        store: ArtifactStore,
        adapter_version: str,
        audit_path: Path,
        attribution_markers: Mapping[str, Sequence[tuple[str, str]]] | None = None,
        price_table: PriceTable | None = None,
        timeout_seconds: float = 330.0,
    ) -> None:
        parsed = urlparse(upstream_base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise UpstreamExecutionError("judge upstream base URL must be HTTP(S)")
        normalized_base = upstream_base_url.rstrip("/")
        self.upstream_base_url = (
            normalized_base
            if normalized_base.endswith("/v1")
            else normalized_base + "/v1"
        )
        self.api_key = api_key
        self.store = store
        self.adapter_version = adapter_version
        self.audit_path = audit_path
        self.attribution_markers = {
            endpoint: tuple(markers)
            for endpoint, markers in (attribution_markers or {}).items()
        }
        self.price_table = price_table
        self.timeout_seconds = timeout_seconds
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self._events: list[dict[str, Any]] = []
        self._occurrences: dict[str, int] = {}
        self._lock = threading.Lock()
        self._cache_lock = threading.Lock()
        self.response_cache_dir = store.run_dir / "evaluator-judge-response-cache"
        self.response_cache_dir.mkdir(parents=True, exist_ok=True)
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("judge cache proxy is not running")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    @property
    def events(self) -> tuple[Mapping[str, Any], ...]:
        with self._lock:
            return tuple(self._events)

    def _append(self, event: Mapping[str, Any]) -> None:
        with self._lock:
            self._events.append(dict(event))
            write_json_atomic(
                self.audit_path,
                {
                    "schema_version": 1,
                    "upstream_origin": urlparse(self.upstream_base_url).netloc,
                    "events": list(self._events),
                },
            )

    def _attribution(self, endpoint: str, body: Mapping[str, Any]) -> tuple[str, tuple[str, ...]]:
        suite = "bundled_shopping" if endpoint.endswith("/chat/completions") else "progressive_search"
        user = body.get("input", _messages(body, "user"))
        text = _content_text(user)
        matches = sorted(
            {
                task_key
                for marker, task_key in self.attribution_markers.get(endpoint, ())
                if marker and marker in text
            }
        )
        if not matches:
            raise UpstreamExecutionError(f"cannot attribute official {suite} judge request to TaskSpec")
        return suite, tuple(matches)

    def _cached_responses(self, key: JudgeCacheKey) -> list[Mapping[str, Any]]:
        path = self.response_cache_dir / f"{key.digest}.json"
        if not path.exists():
            return []
        try:
            document = validate_locked_manifest(read_json(path))
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise UpstreamExecutionError(f"judge response cache is corrupt: {path}: {error}") from error
        if (
            document.get("kind") != "memoryarena-public-judge-response-sequence"
            or document.get("cache_key") != key.digest
            or document.get("key_payload") != key.payload()
            or not isinstance(document.get("responses"), list)
        ):
            raise UpstreamExecutionError(f"judge response cache provenance mismatch: {path}")
        return list(document["responses"])

    def _append_cached_response(
        self,
        key: JudgeCacheKey,
        *,
        status_code: int,
        response_value: Mapping[str, Any],
        response_body: bytes,
        raw_usage: Mapping[str, Any] | None,
    ) -> int:
        path = self.response_cache_dir / f"{key.digest}.json"
        with self._cache_lock:
            responses = self._cached_responses(key)
            responses.append({
                "sequence": len(responses) + 1,
                "status_code": status_code,
                "response_sha256": hashlib.sha256(response_body).hexdigest(),
                "response": dict(response_value),
                "response_id": response_value.get("id"),
                "response_model": response_value.get("model"),
                "usage": dict(raw_usage) if raw_usage is not None else None,
            })
            document = locked_manifest_document({
                "schema_version": 1,
                "kind": "memoryarena-public-judge-response-sequence",
                "cache_key": key.digest,
                "key_payload": key.payload(),
                "responses": responses,
            })
            write_json_atomic(path, document)
            return len(responses)

    def start(self) -> "JudgeCacheProxy":
        owner = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MemoryArenaJudgeCacheProxy/1"

            def log_message(self, format: str, *args: Any) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802
                started = time.monotonic()
                endpoint = self.path
                if endpoint not in {"/v1/responses", "/v1/chat/completions"}:
                    self.send_error(404)
                    return
                try:
                    raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                    body = json.loads(raw)
                    if not isinstance(body, dict):
                        raise UpstreamExecutionError("judge request must be a JSON object")
                    key = _cache_key(body, endpoint, owner.adapter_version)
                    suite, task_keys = owner._attribution(endpoint, body)
                    with owner._lock:
                        occurrence = owner._occurrences.get(key.digest, 0) + 1
                        owner._occurrences[key.digest] = occurrence
                    cached_responses = owner._cached_responses(key)
                    if len(cached_responses) >= occurrence:
                        cached = cached_responses[occurrence - 1]
                        response_value = cached["response"]
                        response_body = json.dumps(response_value, separators=(",", ":")).encode()
                        owner._append({
                            "sequence": len(owner.events) + 1,
                            "endpoint": endpoint,
                            "suite": suite,
                            "task_key": task_keys[0],
                            "task_keys": list(task_keys),
                            "request_sha256": canonical_sha256(body),
                            "cache_key": key.digest,
                            "occurrence": occurrence,
                            "cache": "hit",
                            "status_code": cached["status_code"],
                            "response_id": cached.get("response_id"),
                            "response_model": cached.get("response_model"),
                            "usage": cached.get("usage"),
                            "usage_present": cached.get("usage") is not None,
                            "billed_this_request": False,
                            "elapsed_ms": round((time.monotonic() - started) * 1000),
                        })
                        self._send(int(cached["status_code"]), response_body)
                        return
                    request = urllib.request.Request(
                        owner.upstream_base_url + endpoint.removeprefix("/v1"),
                        data=raw,
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {owner.api_key}",
                        },
                        method="POST",
                    )
                    try:
                        upstream = owner._opener.open(request, timeout=owner.timeout_seconds)
                        status = int(upstream.status)
                        response_body = upstream.read()
                        retry_after = upstream.headers.get("Retry-After")
                    except urllib.error.HTTPError as error:
                        status = int(error.code)
                        response_body = error.read()
                        retry_after = error.headers.get("Retry-After")
                    response_value = json.loads(response_body)
                    parse_valid, parsed = (
                        _parse_valid(endpoint, response_value)
                        if 200 <= status < 300 and isinstance(response_value, Mapping)
                        else (False, None)
                    )
                    usage = None
                    raw_usage = response_value.get("usage") if isinstance(response_value, Mapping) else None
                    if isinstance(raw_usage, Mapping):
                        try:
                            usage = normalize_usage(
                                raw_usage,
                                model=key.requested_model,
                                price_table=owner.price_table,
                            )
                        except UsageNormalizationError:
                            usage = None
                    response_id = (
                        str(response_value.get("id"))
                        if isinstance(response_value, Mapping) and response_value.get("id")
                        else None
                    )
                    response_model = (
                        str(response_value.get("model"))
                        if isinstance(response_value, Mapping) and response_value.get("model")
                        else None
                    )
                    if usage is not None:
                        owner.store.record_usage(
                            task_key=task_keys[0],
                            attempt_id=None,
                            stage=f"judge-{suite}",
                            model=key.requested_model,
                            usage=usage,
                            request_id=response_id,
                            response_model=response_model,
                            disposition_hint=(
                                "accepted_evaluation"
                                if 200 <= status < 300
                                else "retry_overhead"
                            ),
                        )
                    cached_sequence = None
                    if 200 <= status < 300 and isinstance(response_value, Mapping):
                        cached_sequence = owner._append_cached_response(
                            key,
                            status_code=status,
                            response_value=response_value,
                            response_body=response_body,
                            raw_usage=(raw_usage if isinstance(raw_usage, Mapping) else None),
                        )
                    owner._append({
                        "sequence": len(owner.events) + 1,
                        "endpoint": endpoint,
                        "suite": suite,
                        "task_key": task_keys[0],
                        "task_keys": list(task_keys),
                        "request_sha256": canonical_sha256(body),
                        "response_sha256": hashlib.sha256(response_body).hexdigest(),
                        "cache_key": key.digest,
                        "occurrence": occurrence,
                        "cached_response_sequence": cached_sequence,
                        "cache": "miss",
                        "status_code": status,
                        "parse_valid": parse_valid,
                        "response_id": response_id,
                        "response_model": response_model,
                        "usage": dict(raw_usage) if isinstance(raw_usage, Mapping) else None,
                        "usage_present": isinstance(raw_usage, Mapping),
                        "usage_normalized": usage is not None,
                        "billed_this_request": True,
                        "retry_after": retry_after,
                        "elapsed_ms": round((time.monotonic() - started) * 1000),
                    })
                    self._send(status, response_body, retry_after=retry_after)
                except Exception as error:
                    owner._append({
                        "sequence": len(owner.events) + 1,
                        "endpoint": endpoint,
                        "suite": locals().get("suite"),
                        "task_key": (
                            locals().get("task_keys", (None,))[0]
                            if locals().get("task_keys")
                            else None
                        ),
                        "request_sha256": (
                            canonical_sha256(locals()["body"])
                            if isinstance(locals().get("body"), Mapping)
                            else None
                        ),
                        "cache": "error",
                        "status_code": 502,
                        "usage": None,
                        "usage_present": False,
                        "billed_this_request": "unknown",
                        "error": f"{type(error).__name__}: {error}"[:1000],
                        "elapsed_ms": round((time.monotonic() - started) * 1000),
                    })
                    self._send(502, b'{"error":{"message":"judge cache proxy failure"}}')

            def _send(self, status: int, body: bytes, retry_after: str | None = None) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                if retry_after is not None:
                    self.send_header("Retry-After", retry_after)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def close(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._server = None
        self._thread = None

    def __enter__(self) -> "JudgeCacheProxy":
        return self.start()

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()
