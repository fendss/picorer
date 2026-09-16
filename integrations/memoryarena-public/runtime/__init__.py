"""Reliable execution primitives for the MemoryArena Public integration.

This package deliberately has no dependency on the vendored benchmark.  The
benchmark adapter supplies task execution while this package owns retry,
checkpoint, provenance, and completeness semantics.
"""

from .artifacts import (
    ArtifactStore,
    JudgeCacheKey,
    canonical_sha256,
    locked_manifest_document,
    validate_locked_manifest,
)
from .integrity import (
    ArtifactInventoryReport,
    CompletenessReport,
    IntegrityError,
    require_clean_artifact_inventory,
    require_complete_run,
)
from .models import (
    AttemptContext,
    FailureClassification,
    FailureKind,
    NormalizedUsage,
    TaskExecutionResult,
    TaskSpec,
    TaskStatus,
)
from .retry import (
    CircuitBreaker,
    ProviderRequestError,
    RetryExhaustedError,
    RetryPolicy,
    classify_provider_error,
    retry_provider_call,
)
from .runner import MemoryArenaRunner, RunnerPolicy, RunSummary
from .usage import (
    PriceRate,
    PriceTable,
    UsageNormalizationError,
    load_price_table,
    locked_price_table_document,
    normalize_usage,
)

__all__ = [
    "ArtifactStore",
    "ArtifactInventoryReport",
    "AttemptContext",
    "CircuitBreaker",
    "CompletenessReport",
    "FailureClassification",
    "FailureKind",
    "IntegrityError",
    "JudgeCacheKey",
    "MemoryArenaRunner",
    "NormalizedUsage",
    "ProviderRequestError",
    "PriceRate",
    "PriceTable",
    "RetryExhaustedError",
    "RetryPolicy",
    "RunSummary",
    "RunnerPolicy",
    "TaskExecutionResult",
    "TaskSpec",
    "TaskStatus",
    "UsageNormalizationError",
    "canonical_sha256",
    "classify_provider_error",
    "load_price_table",
    "locked_manifest_document",
    "locked_price_table_document",
    "normalize_usage",
    "require_clean_artifact_inventory",
    "require_complete_run",
    "retry_provider_call",
    "validate_locked_manifest",
]
