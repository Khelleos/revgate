"""The camelCase wire boundary.

The `/api/*` contract is camelCase and the review page tells an absent field
from a `null` one, so both halves are spelled out here: the snake_case field
names are renamed on the way out, and a field that is unset is dropped rather
than serialised as `null`.
"""

import dataclasses
import json
from collections.abc import Mapping, Sequence
from typing import Any


def to_camel(name: str) -> str:
    """`old_path` -> `oldPath`. A name with no underscore is returned unchanged."""
    head, *rest = name.split("_")
    return head + "".join(word[:1].upper() + word[1:] for word in rest)


def to_wire(value: Any) -> Any:
    """Convert a value to its JSON shape: camelCase field names, no `None`.

    Dataclass field names are converted; mapping keys are **not**, because those
    keys are data — `states` is keyed by file path, and a path is not a field
    name. A `None` is dropped rather than emitted as `null`, so an optional
    field is absent on the wire.
    """
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        wired: dict[str, Any] = {}
        for field in dataclasses.fields(value):
            attr = getattr(value, field.name)
            if attr is None:
                continue
            wired[to_camel(field.name)] = to_wire(attr)
        return wired
    if isinstance(value, Mapping):
        return {key: to_wire(item) for key, item in value.items() if item is not None}
    if isinstance(value, str | bytes):
        return value
    if isinstance(value, Sequence):
        return [to_wire(item) for item in value]
    return value


def dumps_compact(value: Any) -> str:
    """Serialize with no incidental whitespace and no escaping of non-ASCII.

    The annotation and permission contracts are byte-compared, so neither the
    separators nor a `\\uXXXX` escape may drift.
    """
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
