from __future__ import annotations

import hashlib
import json
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlparse

from runtime.artifacts import write_json_atomic

from .contracts import UpstreamExecutionError


_OPERATIONS = {
    "/memory/initialize": ("initialize", {"user_id", "memory_system_name"}),
    "/memory/add": ("add", {"user_id", "memory_system_name", "chunk"}),
    "/memory/wrap_user_prompt": (
        "wrap_user_prompt",
        {"user_id", "memory_system_name", "question"},
    ),
}


def _payload_digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _normal(value: str) -> str:
    return " ".join(value.casefold().split())


class GoldLeakGuard:
    """Block explicit reference-bearing payloads without logging task content.

    A model prediction can legitimately equal the reference answer, so content
    equality is not taint evidence.  The production worker separately keeps the
    source ``answers`` object out of every MemoryClient call; this final network
    guard rejects explicit ground-truth/reference serialization markers.
    """

    def __init__(self, answers: Iterable[Any]):
        # Retain only a digest proving which reference set armed the guard.
        # Raw reference material is never persisted in the audit artifact.
        self.reference_set_sha256 = _payload_digest(list(answers))

    def check(self, operation: str, payload: Mapping[str, Any]) -> None:
        if operation not in {"add", "wrap_user_prompt"}:
            return
        field = "chunk" if operation == "add" else "question"
        text = payload.get(field)
        if not isinstance(text, str):
            raise UpstreamExecutionError(f"Picorer {operation} payload has no string {field}")
        normalized = _normal(text)
        forbidden_markers = (
            '"ground_truth":',
            '"correct_answer":',
            '"reference_answer":',
            "ground truth answer:",
            "reference answer:",
        )
        if any(marker in normalized for marker in forbidden_markers):
            raise UpstreamExecutionError(
                f"explicit reference-answer payload rejected before Picorer {operation}"
            )


@dataclass(frozen=True)
class AuditEvent:
    sequence: int
    operation: str
    path: str
    user_id: str
    memory_system_name: str
    status: str
    status_code: int | None
    request_sha256: str
    response_sha256: str | None
    error: str | None
    retry_after: str | None
    retryable: bool | None
    elapsed_ms: int

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


class MemoryAuditProxy:
    """Attempt-local transparent proxy for attribution and silent-fallback detection."""

    def __init__(
        self,
        *,
        upstream_url: str,
        memory_scope: str,
        audit_path: Path,
        gold_answers: Iterable[Any],
        timeout_seconds: float = 330.0,
    ) -> None:
        parsed = urlparse(upstream_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise UpstreamExecutionError("Picorer upstream must be an HTTP(S) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise UpstreamExecutionError("Picorer upstream URL must not contain credentials/query")
        self.upstream_url = upstream_url.rstrip("/")
        self.memory_scope = memory_scope
        self.audit_path = audit_path
        self.timeout_seconds = timeout_seconds
        self.guard = GoldLeakGuard(gold_answers)
        # The gateway URL is an explicit benchmark input.  Ambient desktop or
        # shell proxy settings must not silently reroute localhost Picorer calls.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self._events: list[AuditEvent] = []
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("memory audit proxy has not started")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def events(self) -> tuple[AuditEvent, ...]:
        with self._lock:
            return tuple(self._events)

    def _append(self, event: AuditEvent) -> None:
        with self._lock:
            self._events.append(event)
            snapshot = {
                "schema_version": 1,
                "memory_scope": self.memory_scope,
                "upstream_url": self.upstream_url,
                "events": [item.to_dict() for item in self._events],
            }
            write_json_atomic(self.audit_path, snapshot)

    def start(self) -> "MemoryAuditProxy":
        owner = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MemoryArenaAuditProxy/1"

            def log_message(self, format: str, *args: Any) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802 - stdlib callback
                started = time.monotonic()
                contract = _OPERATIONS.get(self.path)
                if contract is None:
                    self.send_error(404)
                    return
                operation, keys = contract
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    raw = self.rfile.read(length)
                    payload = json.loads(raw)
                    if not isinstance(payload, dict) or set(payload) != keys:
                        raise UpstreamExecutionError(
                            f"official Picorer {operation} JSON keys changed"
                        )
                    user_id = payload.get("user_id")
                    memory_name = payload.get("memory_system_name")
                    if not isinstance(user_id, str) or not user_id.startswith(
                        owner.memory_scope + "::"
                    ):
                        raise UpstreamExecutionError(
                            f"unscoped official MemoryClient user_id: {user_id!r}"
                        )
                    if memory_name != "picorer":
                        raise UpstreamExecutionError(
                            f"unexpected memory_system_name: {memory_name!r}"
                        )
                    owner.guard.check(operation, payload)
                    request = urllib.request.Request(
                        owner.upstream_url + self.path,
                        data=raw,
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    try:
                        response = owner._opener.open(
                            request, timeout=owner.timeout_seconds
                        )
                        status_code = int(response.status)
                        response_body = response.read()
                        response_type = response.headers.get(
                            "Content-Type", "application/json"
                        )
                        retry_after = response.headers.get("Retry-After")
                        retryable_header = response.headers.get("x-picorer-retryable")
                    except urllib.error.HTTPError as error:
                        status_code = int(error.code)
                        response_body = error.read()
                        response_type = error.headers.get(
                            "Content-Type", "application/json"
                        )
                        retry_after = error.headers.get("Retry-After")
                        retryable_header = error.headers.get("x-picorer-retryable")
                    event = AuditEvent(
                        sequence=len(owner.events) + 1,
                        operation=operation,
                        path=self.path,
                        user_id=user_id,
                        memory_system_name=memory_name,
                        status="ok" if 200 <= status_code < 300 else "error",
                        status_code=status_code,
                        request_sha256=_payload_digest(payload),
                        response_sha256=hashlib.sha256(response_body).hexdigest(),
                        error=None if 200 <= status_code < 300 else response_body[:500].decode(
                            "utf-8", errors="replace"
                        ),
                        retry_after=retry_after,
                        retryable=(
                            retryable_header.strip().casefold() == "true"
                            if retryable_header is not None
                            else None
                        ),
                        elapsed_ms=round((time.monotonic() - started) * 1000),
                    )
                    owner._append(event)
                    self.send_response(status_code)
                    self.send_header("Content-Type", response_type)
                    if retry_after is not None:
                        self.send_header("Retry-After", retry_after)
                    if retryable_header is not None:
                        self.send_header("x-picorer-retryable", retryable_header)
                    self.send_header("Content-Length", str(len(response_body)))
                    self.end_headers()
                    self.wfile.write(response_body)
                except Exception as error:
                    deterministic_contract_error = isinstance(error, UpstreamExecutionError)
                    local_status = 422 if deterministic_contract_error else 502
                    user_id = payload.get("user_id", "") if isinstance(
                        locals().get("payload"), dict
                    ) else ""
                    memory_name = payload.get("memory_system_name", "") if isinstance(
                        locals().get("payload"), dict
                    ) else ""
                    event = AuditEvent(
                        sequence=len(owner.events) + 1,
                        operation=operation,
                        path=self.path,
                        user_id=str(user_id),
                        memory_system_name=str(memory_name),
                        status="error",
                        status_code=local_status,
                        request_sha256=_payload_digest(
                            payload if isinstance(locals().get("payload"), dict) else {}
                        ),
                        response_sha256=None,
                        error=f"{type(error).__name__}: {error}"[:1000],
                        retry_after=None,
                        retryable=not deterministic_contract_error,
                        elapsed_ms=round((time.monotonic() - started) * 1000),
                    )
                    owner._append(event)
                    body = json.dumps({"detail": "memory audit proxy rejected request"}).encode()
                    self.send_response(local_status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header(
                        "x-picorer-retryable",
                        "false" if deterministic_contract_error else "true",
                    )
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

    def __enter__(self) -> "MemoryAuditProxy":
        return self.start()

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()


def validate_lifecycle(
    events: Sequence[AuditEvent],
    *,
    suite: str,
    question_count: int,
    expected_shopping_adds: int | None = None,
) -> dict[str, Any]:
    errors = [event for event in events if event.status != "ok"]
    if errors:
        first = errors[0]
        raise UpstreamExecutionError(
            f"Picorer {first.operation} failed with {first.status_code}: {first.error}"
        )
    counts = {name: 0 for name in ("initialize", "wrap_user_prompt", "add")}
    users = set()
    for event in events:
        counts[event.operation] = counts.get(event.operation, 0) + 1
        users.add(event.user_id)
    expected_adds: int
    if suite == "progressive_search":
        expected_adds = question_count - 1
    elif suite in {"group_travel_planner", "formal_reasoning_math", "formal_reasoning_phys"}:
        expected_adds = question_count + 1
    elif suite == "bundled_shopping":
        if expected_shopping_adds is None:
            raise UpstreamExecutionError("shopping output did not expose interaction-turn count")
        expected_adds = expected_shopping_adds
    else:
        raise UpstreamExecutionError(f"unknown suite lifecycle: {suite}")
    expected = {
        "initialize": 1,
        "wrap_user_prompt": question_count,
        "add": expected_adds,
    }
    if counts != expected or len(users) != 1:
        raise UpstreamExecutionError(
            f"Picorer lifecycle mismatch for {suite}: expected {expected}, got {counts}, users={len(users)}"
        )
    return {"counts": counts, "user_id": next(iter(users))}
