from __future__ import annotations

import importlib
from functools import lru_cache
from typing import Any


@lru_cache(maxsize=32)
def load_adapter(specification: str) -> Any:
    module_name, separator, attribute = specification.partition(":")
    if not separator or not module_name or not attribute:
        raise ValueError(f"adapter must be module:attribute, got {specification!r}")
    factory = getattr(importlib.import_module(module_name), attribute)
    return factory()

