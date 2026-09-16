"""Pinned production seam for the official MemoryArena Public checkout."""

from typing import Any

__all__ = ["materialize_locked_task_manifest", "memoryarena_executor"]


def __getattr__(name: str) -> Any:
    # Keep package import side-effect free so every CLI can be invoked as
    # ``python -m upstream.<module>`` without pre-importing the executor.
    if name == "memoryarena_executor":
        from .executor import memoryarena_executor

        return memoryarena_executor
    if name == "materialize_locked_task_manifest":
        from .manifest import materialize_locked_task_manifest

        return materialize_locked_task_manifest
    raise AttributeError(name)
