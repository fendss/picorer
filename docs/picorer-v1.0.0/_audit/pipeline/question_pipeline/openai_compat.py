from __future__ import annotations

import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import requests

from .contracts import RetryableStageError
from .eval_config import model as resolve_model


@dataclass(frozen=True)
class Completion:
    text: str
    response_model: str
    usage: Mapping[str, Any] | None


class CompletionClient:
    """Small synchronous client for configurable judge calls."""

    def __init__(self) -> None:
        self._local = threading.local()

    def _session(self) -> requests.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            session.trust_env = False
            self._local.session = session
        return session

    def complete(
        self,
        payload: Mapping[str, Any],
        model_name: str,
        messages: Sequence[Mapping[str, str]],
        max_tokens: int,
    ) -> Completion:
        model = resolve_model(payload, model_name)
        body: dict[str, Any] = {
            "model": model["id"],
            "messages": [dict(message) for message in messages],
        }
        thinking_level = str(model.get("thinking_level", "off"))
        if thinking_level == "off":
            body.update({
                "max_tokens": max_tokens,
                "temperature": float(model.get("temperature", 0)),
            })
            for key in ("top_p", "seed"):
                if key in model:
                    body[key] = model[key]
        else:
            body.update({
                "max_completion_tokens": max_tokens,
                "reasoning_effort": thinking_level,
            })
        headers = {"Content-Type": "application/json"}
        if model.get("api_key"):
            headers["Authorization"] = f"Bearer {model['api_key']}"
        url = str(model["base_url"]).rstrip("/") + "/chat/completions"
        try:
            response = self._session().post(
                url,
                json=body,
                headers=headers,
                timeout=float(model.get("timeout_seconds", 600)),
            )
        except requests.RequestException as error:
            raise RetryableStageError(str(error)) from error
        if response.status_code in {408, 409, 425, 429} or response.status_code >= 500:
            raise RetryableStageError(
                f"completion HTTP {response.status_code}: {response.text[:1000]}"
            )
        if not response.ok:
            raise RuntimeError(
                f"completion HTTP {response.status_code}: {response.text[:2000]}"
            )
        try:
            result = response.json()
            text = result["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise RuntimeError(
                "completion response violates OpenAI chat schema"
            ) from error
        if not isinstance(text, str) or not text.strip():
            raise RetryableStageError("completion is empty")
        response_model = result.get("model")
        return Completion(
            text=text.strip(),
            response_model=(
                response_model if isinstance(response_model, str) else str(model["id"])
            ),
            usage=result.get("usage") if isinstance(result.get("usage"), Mapping) else None,
        )
