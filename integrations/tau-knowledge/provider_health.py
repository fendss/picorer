"""Bounded OpenAI-compatible model availability preflight.

This gate prevents a provider-wide outage from being expanded into dozens of
whole-episode tau2 retries.  It never returns or persists credentials.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import re
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


Transport = Callable[[Request, float], tuple[int, bytes]]


def _default_transport(request: Request, timeout: float) -> tuple[int, bytes]:
    try:
        with urlopen(request, timeout=timeout) as response:
            return int(response.status), response.read()
    except HTTPError as error:
        return int(error.code), error.read()
    except URLError as error:
        raise RuntimeError(f"provider network error: {error.reason}") from error


def _matches_alias(expected: str, observed: str) -> bool:
    return observed == expected or re.fullmatch(
        re.escape(expected) + r"-\d{4}-\d{2}-\d{2}", observed
    ) is not None


def probe_openai_chat_model(
    *,
    endpoint: str,
    api_key: str,
    model: str,
    timeout: float,
    transport: Transport = _default_transport,
) -> dict[str, Any]:
    payload = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "max_completion_tokens": 16,
            "temperature": 0,
        }
    ).encode()
    request = Request(
        endpoint.rstrip("/") + "/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    status, body = transport(request, timeout)
    try:
        response = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RuntimeError(f"provider returned invalid JSON (HTTP {status})") from error
    error_value = response.get("error") if isinstance(response, dict) else None
    if status < 200 or status >= 300 or isinstance(error_value, dict):
        error_type = (
            str(error_value.get("type") or "provider_error")
            if isinstance(error_value, dict)
            else "provider_error"
        )
        raise RuntimeError(f"provider unavailable (HTTP {status}, {error_type})")
    response_model = response.get("model") if isinstance(response, dict) else None
    if not isinstance(response_model, str):
        raise RuntimeError("provider response omitted model identity")
    if not _matches_alias(model, response_model):
        raise RuntimeError(
            f"provider resolved {model!r} to unexpected model {response_model!r}"
        )
    return {
        "http_status": status,
        "requested_model": model,
        "response_model": response_model,
    }


def wait_for_openai_chat_model(
    *,
    endpoint: str,
    api_key: str,
    model: str,
    attempts: int,
    delay: float,
    timeout: float,
    transport: Transport = _default_transport,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []
    for attempt in range(1, attempts + 1):
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            success = probe_openai_chat_model(
                endpoint=endpoint,
                api_key=api_key,
                model=model,
                timeout=timeout,
                transport=transport,
            )
            return {
                "schema_version": 1,
                "available": True,
                "attempt": attempt,
                "checked_at": checked_at,
                "endpoint": endpoint,
                **success,
                "failures": failures,
            }
        except RuntimeError as error:
            failures.append(
                {
                    "attempt": attempt,
                    "checked_at": checked_at,
                    "error": str(error),
                }
            )
            if attempt < attempts:
                sleep(delay)
    return {
        "schema_version": 1,
        "available": False,
        "attempt": attempts,
        "checked_at": failures[-1]["checked_at"],
        "endpoint": endpoint,
        "requested_model": model,
        "failures": failures,
    }
