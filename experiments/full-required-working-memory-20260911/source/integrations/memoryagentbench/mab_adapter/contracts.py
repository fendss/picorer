from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence


class ContractError(ValueError):
    pass


@dataclass(frozen=True)
class Query:
    question: str
    answers: tuple[str, ...]
    qa_pair_id: str
    question_id: str | None
    question_type: str | None


@dataclass(frozen=True)
class Context:
    ordinal: int
    text: str
    queries: tuple[Query, ...]


def _string_list(value: Any, label: str) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if not isinstance(value, Sequence) or isinstance(value, (bytes, bytearray)):
        raise ContractError(f"{label} must be a string or list of strings")
    flattened: list[str] = []
    for item in value:
        if isinstance(item, str):
            flattened.append(item)
        elif isinstance(item, Sequence) and not isinstance(item, (bytes, bytearray)):
            for nested in item:
                if not isinstance(nested, str):
                    raise ContractError(f"{label} contains a non-string answer")
                flattened.append(nested)
        else:
            raise ContractError(f"{label} contains a non-string answer")
    if not flattened:
        raise ContractError(f"{label} must not be empty")
    return tuple(flattened)


def _metadata_value(metadata: Mapping[str, Any], field: str, index: int) -> Any:
    value = metadata.get(field)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return value[index] if index < len(value) else None
    return value


def parse_context(record: Mapping[str, Any], ordinal: int) -> Context:
    text = record.get("context")
    questions = record.get("questions")
    answers = record.get("answers")
    metadata = record.get("metadata")
    if not isinstance(text, str) or not text:
        raise ContractError(f"context[{ordinal}].context must be non-empty text")
    if not isinstance(questions, Sequence) or isinstance(questions, (str, bytes)):
        raise ContractError(f"context[{ordinal}].questions must be a list")
    if not isinstance(answers, Sequence) or isinstance(answers, (str, bytes)):
        raise ContractError(f"context[{ordinal}].answers must be a list")
    if len(questions) != len(answers) or not questions:
        raise ContractError(f"context[{ordinal}] question/answer lengths do not match")
    if not isinstance(metadata, Mapping):
        raise ContractError(f"context[{ordinal}].metadata must be an object")

    queries: list[Query] = []
    for index, (question, answer) in enumerate(zip(questions, answers)):
        if not isinstance(question, str) or not question:
            raise ContractError(f"context[{ordinal}].questions[{index}] is invalid")
        qa_pair_id = _metadata_value(metadata, "qa_pair_ids", index)
        if not isinstance(qa_pair_id, str) or not qa_pair_id:
            qa_pair_id = f"context-{ordinal}-query-{index}"
        question_id = _metadata_value(metadata, "question_ids", index)
        question_type = _metadata_value(metadata, "question_types", index)
        queries.append(
            Query(
                question=question,
                answers=_string_list(answer, f"context[{ordinal}].answers[{index}]"),
                qa_pair_id=qa_pair_id,
                question_id=question_id if isinstance(question_id, str) else None,
                question_type=question_type if isinstance(question_type, str) else None,
            )
        )
    return Context(ordinal=ordinal, text=text, queries=tuple(queries))
