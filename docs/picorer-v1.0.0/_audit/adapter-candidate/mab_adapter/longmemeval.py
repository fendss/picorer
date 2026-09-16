from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass
from datetime import datetime

from .contracts import ContractError


_CHAT_TIME = re.compile(
    r"^Chat Time: (\d{4}/\d{2}/\d{2}) \([A-Za-z]{3}\) (\d{2}:\d{2})$"
)
_ROLES = frozenset(("user", "assistant", "system", "other"))


@dataclass(frozen=True)
class StructuredMemoryAppend:
    chunk: str
    messages: tuple[dict[str, str], ...]


def _timestamp(value: str, path: str) -> str:
    match = _CHAT_TIME.fullmatch(value)
    if match is None:
        raise ContractError(f"{path} is not a LongMemEval Chat Time")
    try:
        parsed = datetime.strptime(
            f"{match.group(1)} {match.group(2)}", "%Y/%m/%d %H:%M"
        )
    except ValueError as error:
        raise ContractError(f"{path} is not a valid calendar timestamp") from error
    return parsed.isoformat(timespec="seconds")


def structured_longmemeval_appends(
    context: str,
) -> tuple[StructuredMemoryAppend, ...] | None:
    """Decode the public LongMemEval context without hidden QA metadata."""

    if not context.lstrip().startswith("["):
        return None
    try:
        value = ast.literal_eval(context)
    except (SyntaxError, ValueError) as error:
        raise ContractError("LongMemEval context is not a literal sequence") from error
    if not isinstance(value, list) or not value or len(value) % 2 != 0:
        raise ContractError(
            "LongMemEval context must alternate Chat Time and message lists"
        )

    appends: list[StructuredMemoryAppend] = []
    for offset in range(0, len(value), 2):
        session_index = offset // 2
        raw_time = value[offset]
        raw_messages = value[offset + 1]
        if not isinstance(raw_time, str):
            raise ContractError(
                f"LongMemEval session[{session_index}].time must be a string"
            )
        timestamp = _timestamp(
            raw_time, f"LongMemEval session[{session_index}].time"
        )
        if not isinstance(raw_messages, list) or not raw_messages:
            raise ContractError(
                f"LongMemEval session[{session_index}].messages must be non-empty"
            )
        messages: list[dict[str, str]] = []
        for message_index, raw_message in enumerate(raw_messages):
            path = (
                f"LongMemEval session[{session_index}].messages[{message_index}]"
            )
            if not isinstance(raw_message, dict):
                raise ContractError(f"{path} must be an object")
            if set(raw_message) != {"role", "content"}:
                raise ContractError(f"{path} must contain only role and content")
            role = raw_message.get("role")
            content = raw_message.get("content")
            if role not in _ROLES:
                raise ContractError(f"{path}.role is unsupported")
            if not isinstance(content, str) or not content:
                raise ContractError(f"{path}.content must be a non-empty string")
            messages.append(
                {"role": role, "content": content, "timestamp": timestamp}
            )
        canonical_chunk = json.dumps(
            {"chat_time": raw_time, "messages": raw_messages},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        appends.append(
            StructuredMemoryAppend(
                chunk=canonical_chunk,
                messages=tuple(messages),
            )
        )
    return tuple(appends)
