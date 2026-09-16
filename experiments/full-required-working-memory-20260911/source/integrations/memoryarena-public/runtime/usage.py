from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional

from .artifacts import canonical_sha256
from .models import NormalizedUsage


class UsageNormalizationError(ValueError):
    pass


@dataclass(frozen=True)
class PriceRate:
    input: float
    output: float
    cache_read: float
    cache_write: float

    def __post_init__(self) -> None:
        if min(self.input, self.output, self.cache_read, self.cache_write) < 0:
            raise UsageNormalizationError("price rates must be non-negative")


@dataclass(frozen=True)
class PriceTable:
    rates: Mapping[str, PriceRate]
    aliases: Mapping[str, str]
    sha256: str
    source: str

    def rate_for(self, model: str) -> Optional[PriceRate]:
        canonical = self.aliases.get(model, model)
        return self.rates.get(canonical)


def _non_negative_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise UsageNormalizationError(f"{label} must be numeric")
    converted = float(value)
    if converted < 0:
        raise UsageNormalizationError(f"{label} must be non-negative")
    return converted


def _non_negative_int(value: Any, label: str, default: int = 0) -> int:
    if value is None:
        return default
    number = _non_negative_number(value, label)
    if not number.is_integer():
        raise UsageNormalizationError(f"{label} must be an integer")
    return int(number)


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def price_table_from_document(
    document: Mapping[str, Any], *, source: str = "inline"
) -> PriceTable:
    expected = document.get("manifest_sha256")
    if not isinstance(expected, str) or len(expected) != 64:
        raise UsageNormalizationError("price table must contain manifest_sha256")
    body = dict(document)
    body.pop("manifest_sha256", None)
    actual = canonical_sha256(body)
    if actual != expected:
        raise UsageNormalizationError("price table SHA-256 does not match its contents")
    if body.get("schema_version") != 1:
        raise UsageNormalizationError("unsupported price table schema_version")
    if body.get("currency") != "USD" or body.get("unit") != "usd_per_1m_tokens":
        raise UsageNormalizationError(
            "price table must use USD and usd_per_1m_tokens"
        )
    raw_models = body.get("models")
    if not isinstance(raw_models, Mapping) or not raw_models:
        raise UsageNormalizationError("price table models must be a non-empty object")
    rates: dict[str, PriceRate] = {}
    for model, raw_rate in raw_models.items():
        if not isinstance(model, str) or not model:
            raise UsageNormalizationError("price table model ids must be non-empty strings")
        if not isinstance(raw_rate, Mapping):
            raise UsageNormalizationError(f"price rate for {model} must be an object")
        required = {"input", "output", "cache_read", "cache_write"}
        if set(raw_rate) != required:
            raise UsageNormalizationError(
                f"price rate for {model} must contain exactly {sorted(required)}"
            )
        rates[model] = PriceRate(
            input=_non_negative_number(raw_rate["input"], f"{model}.input"),
            output=_non_negative_number(raw_rate["output"], f"{model}.output"),
            cache_read=_non_negative_number(
                raw_rate["cache_read"], f"{model}.cache_read"
            ),
            cache_write=_non_negative_number(
                raw_rate["cache_write"], f"{model}.cache_write"
            ),
        )
    raw_aliases = body.get("aliases", {})
    if not isinstance(raw_aliases, Mapping):
        raise UsageNormalizationError("price table aliases must be an object")
    aliases: dict[str, str] = {}
    for alias, target in raw_aliases.items():
        if not isinstance(alias, str) or not isinstance(target, str):
            raise UsageNormalizationError("price table aliases must map strings to strings")
        if target not in rates:
            raise UsageNormalizationError(
                f"price table alias {alias} references missing model {target}"
            )
        aliases[alias] = target
    return PriceTable(rates=rates, aliases=aliases, sha256=actual, source=source)


def load_price_table(path: Path | str) -> PriceTable:
    source = Path(path).resolve()
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise UsageNormalizationError(f"cannot load price table {source}: {error}") from error
    if not isinstance(value, Mapping):
        raise UsageNormalizationError("price table must contain a JSON object")
    return price_table_from_document(value, source=str(source))


def locked_price_table_document(
    models: Mapping[str, Mapping[str, float]],
    *,
    aliases: Optional[Mapping[str, str]] = None,
) -> dict[str, Any]:
    """Build a canonical table for tests and explicit experiment setup."""

    body: dict[str, Any] = {
        "schema_version": 1,
        "currency": "USD",
        "unit": "usd_per_1m_tokens",
        "models": {model: dict(rate) for model, rate in models.items()},
        "aliases": dict(aliases or {}),
    }
    body["manifest_sha256"] = canonical_sha256(body)
    return body


def _provider_cost(raw: Mapping[str, Any]) -> tuple[Optional[float], bool]:
    """Return provider cost and whether the provider emitted a cost field."""

    if "cost_usd" in raw:
        value = raw.get("cost_usd")
        return (
            None if value is None else _non_negative_number(value, "cost_usd"),
            True,
        )
    if "cost" not in raw:
        return None, False
    value = raw.get("cost")
    if isinstance(value, Mapping):
        if "total" not in value:
            return None, True
        value = value.get("total")
    if value is None:
        return None, True
    return _non_negative_number(value, "cost"), True


def _canonical_tokens(raw: Mapping[str, Any]) -> Optional[dict[str, int | None]]:
    canonical_keys = {
        "input_tokens",
        "output_tokens",
        "cached_input_tokens",
        "cache_write_tokens",
        "reasoning_tokens",
        "total_tokens",
    }
    if not canonical_keys.intersection(raw):
        return None
    return {
        "input": _non_negative_int(raw.get("input_tokens"), "input_tokens"),
        "output": _non_negative_int(raw.get("output_tokens"), "output_tokens"),
        "cache_read": _non_negative_int(
            raw.get("cached_input_tokens"), "cached_input_tokens"
        ),
        "cache_write": _non_negative_int(
            raw.get("cache_write_tokens"), "cache_write_tokens"
        ),
        "reasoning": _non_negative_int(
            raw.get("reasoning_tokens"), "reasoning_tokens"
        ),
        "total": (
            _non_negative_int(raw["total_tokens"], "total_tokens")
            if raw.get("total_tokens") is not None
            else None
        ),
    }


def _picorer_tokens(raw: Mapping[str, Any]) -> Optional[dict[str, int | None]]:
    if not {"input", "output", "totalTokens"}.intersection(raw):
        return None
    if "input" not in raw or "output" not in raw:
        raise UsageNormalizationError("partial Picorer usage object")
    return {
        # Pi agent reports uncached input separately from cache reads/writes.
        "input": _non_negative_int(raw.get("input"), "input"),
        "output": _non_negative_int(raw.get("output"), "output"),
        "cache_read": _non_negative_int(raw.get("cacheRead"), "cacheRead"),
        "cache_write": _non_negative_int(raw.get("cacheWrite"), "cacheWrite"),
        "reasoning": _non_negative_int(raw.get("reasoning"), "reasoning"),
        "total": (
            _non_negative_int(raw["totalTokens"], "totalTokens")
            if raw.get("totalTokens") is not None
            else None
        ),
    }


def _openai_tokens(raw: Mapping[str, Any]) -> Optional[dict[str, int | None]]:
    is_completion = "prompt_tokens" in raw or "completion_tokens" in raw
    is_responses = "input_tokens" in raw or "output_tokens" in raw
    if not is_completion and not is_responses:
        return None
    input_key = "prompt_tokens" if is_completion else "input_tokens"
    output_key = "completion_tokens" if is_completion else "output_tokens"
    input_details_key = (
        "prompt_tokens_details" if is_completion else "input_tokens_details"
    )
    output_details_key = (
        "completion_tokens_details" if is_completion else "output_tokens_details"
    )
    gross_input = _non_negative_int(raw.get(input_key), input_key)
    input_details = _as_mapping(raw.get(input_details_key))
    output_details = _as_mapping(raw.get(output_details_key))
    cached = _non_negative_int(input_details.get("cached_tokens"), "cached_tokens")
    if cached > gross_input:
        raise UsageNormalizationError("cached_tokens exceeds provider input tokens")
    output = _non_negative_int(raw.get(output_key), output_key)
    reasoning = _non_negative_int(
        output_details.get("reasoning_tokens"), "reasoning_tokens"
    )
    total_value = raw.get("total_tokens")
    return {
        "input": gross_input - cached,
        "output": output,
        "cache_read": cached,
        "cache_write": 0,
        "reasoning": reasoning,
        "total": (
            _non_negative_int(total_value, "total_tokens")
            if total_value is not None
            else gross_input + output
        ),
    }


def _estimated_cost(tokens: Mapping[str, int | None], rate: PriceRate) -> float:
    return (
        int(tokens["input"] or 0) * rate.input
        + int(tokens["output"] or 0) * rate.output
        + int(tokens["cache_read"] or 0) * rate.cache_read
        + int(tokens["cache_write"] or 0) * rate.cache_write
    ) / 1_000_000


def normalize_usage(
    value: Mapping[str, Any],
    *,
    model: str,
    price_table: Optional[PriceTable] = None,
) -> NormalizedUsage:
    """Normalize Picorer, Chat Completions, Responses, or canonical usage.

    A provider-emitted zero is treated as an unreliable placeholder unless the
    model has an explicit rate entry.  This is important for OpenAI-compatible
    adapters whose local model catalog initializes all costs to zero.
    """

    if not isinstance(value, Mapping):
        raise UsageNormalizationError("usage must be an object")
    raw = value
    if isinstance(value.get("usage"), Mapping):
        raw = value["usage"]

    tokens = _picorer_tokens(raw)
    if tokens is None:
        # Canonical must be checked before OpenAI Responses because both use
        # input_tokens/output_tokens. Canonical is distinguished by its extra
        # normalized fields or cost_usd.
        is_canonical = any(
            key in raw
            for key in (
                "cached_input_tokens",
                "cache_write_tokens",
                "reasoning_tokens",
                "price_source",
            )
        )
        tokens = _canonical_tokens(raw) if is_canonical else _openai_tokens(raw)
    if tokens is None:
        raise UsageNormalizationError("unrecognized provider usage shape")

    provider_cost, emitted_cost = _provider_cost(raw)
    rate = price_table.rate_for(model) if price_table else None
    if provider_cost is not None and provider_cost > 0:
        cost_usd: Optional[float] = provider_cost
        price_source = "provider-reported"
        price_sha256 = None
    elif rate is not None and price_table is not None:
        cost_usd = _estimated_cost(tokens, rate)
        price_source = f"price-table:{price_table.source}"
        price_sha256 = price_table.sha256
    else:
        cost_usd = None
        price_source = "unknown-provider-zero" if emitted_cost else "unpriced"
        price_sha256 = None

    return NormalizedUsage(
        input_tokens=int(tokens["input"] or 0),
        output_tokens=int(tokens["output"] or 0),
        cached_input_tokens=int(tokens["cache_read"] or 0),
        cache_write_tokens=int(tokens["cache_write"] or 0),
        reasoning_tokens=int(tokens["reasoning"] or 0),
        total_tokens=(int(tokens["total"]) if tokens["total"] is not None else None),
        cost_usd=cost_usd,
        price_source=price_source,
        price_sha256=price_sha256,
    )
