from __future__ import annotations

import re
from typing import Any

import tiktoken


_MEMORY_CONTEXT_RE = re.compile(
    r'(<memory_context\s+authority="read_exact_sources">\n)(.*?)(\n</memory_context>)',
    re.DOTALL,
)
_MEMORY_BLOCK_RE = re.compile(r"<memory>\n.*?\n</memory>", re.DOTALL)
_CHAT_TOKEN_OVERHEAD = 16
_CONTEXT_SAFETY_TOKENS = 1024


def _encoding_for_model(model: str) -> Any:
    try:
        return tiktoken.encoding_for_model(model)
    except KeyError:
        return tiktoken.get_encoding("o200k_base")


def _message_input_tokens(encoding: Any, system_prompt: str, prompt: str) -> int:
    return (
        len(encoding.encode(system_prompt))
        + len(encoding.encode(prompt))
        + _CHAT_TOKEN_OVERHEAD
    )


def fit_memory_prompt_to_context_window(
    system_prompt: str,
    prompt: str,
    *,
    model: str,
    context_window: int,
    max_output_tokens: int,
    safety_tokens: int = _CONTEXT_SAFETY_TOKENS,
) -> str:
    """Fit a structured evidence handoff without cutting source records."""
    if safety_tokens < 0:
        raise ValueError("Answer context safety tokens must be non-negative")
    input_budget = context_window - max_output_tokens - safety_tokens
    if input_budget <= _CHAT_TOKEN_OVERHEAD:
        raise ValueError("Answer model output reservation leaves no input context")
    encoding = _encoding_for_model(model)
    if _message_input_tokens(encoding, system_prompt, prompt) <= input_budget:
        return prompt

    context = _MEMORY_CONTEXT_RE.search(prompt)
    if context is None:
        raise ValueError(
            "Answer prompt exceeds the model context window and has no structured memory context"
        )
    blocks = _MEMORY_BLOCK_RE.findall(context.group(2))
    if not blocks:
        raise ValueError(
            "Answer prompt exceeds the model context window without compactable memory records"
        )

    prefix = prompt[: context.start(2)]
    suffix = prompt[context.end(2) :]
    marker = "[128 selected memories omitted to fit the answer-model context window]"
    fixed_tokens = _message_input_tokens(
        encoding,
        system_prompt,
        prefix + marker + suffix,
    )
    selected: list[str] = []
    selected_tokens = 0
    for block in blocks:
        delimiter = "" if not selected else "\n"
        block_tokens = len(encoding.encode(delimiter + block))
        if fixed_tokens + selected_tokens + block_tokens <= input_budget:
            selected.append(block)
            selected_tokens += block_tokens

    omitted = len(blocks) - len(selected)
    while True:
        noun = "memory" if omitted == 1 else "memories"
        marker = (
            f"[{omitted} selected {noun} omitted to fit the answer-model context window]"
        )
        fitted = prefix + "\n".join([*selected, marker]) + suffix
        if _message_input_tokens(encoding, system_prompt, fitted) <= input_budget:
            return fitted
        if not selected:
            raise ValueError(
                "Answer prompt metadata and question exceed the model context window"
            )
        selected.pop()
        omitted += 1
