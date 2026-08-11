from __future__ import annotations

import re
from typing import Any


NORMALIZER_IDS = (
    "exact_trimmed_casefold",
    "exact_trimmed",
    "integer",
    "b80_exact_3",
    "behavior_label",
    "fixed_enum",
    "regex_capture",
    "whitespace_collapse",
)


def validate_normalizer(config: dict[str, Any]) -> None:
    normalizer_id = str(config.get("id", "exact_trimmed_casefold"))
    if normalizer_id not in NORMALIZER_IDS:
        raise ValueError(f"unsupported normalizer: {normalizer_id}")
    parameters = config.get("parameters") or {}
    if not isinstance(parameters, dict):
        raise ValueError("normalizer parameters must be an object")
    if normalizer_id == "fixed_enum":
        values = parameters.get("values")
        if not isinstance(values, dict) or not values:
            raise ValueError("fixed_enum requires a non-empty values mapping")
        if any(not isinstance(key, str) or not isinstance(value, str) for key, value in values.items()):
            raise ValueError("fixed_enum values must map strings to strings")
    if normalizer_id == "regex_capture":
        pattern = parameters.get("pattern")
        if not isinstance(pattern, str) or len(pattern) > 256:
            raise ValueError("regex_capture requires a pattern up to 256 characters")
        compiled = re.compile(pattern)
        if compiled.groups != 1:
            raise ValueError("regex_capture requires exactly one capture group")
        if "(?" in pattern and not pattern.startswith("(?:"):
            raise ValueError("regex_capture does not allow advanced inline constructs")


def normalize_answer(value: Any, config: dict[str, Any] | None = None) -> str:
    config = config or {"id": "exact_trimmed_casefold", "parameters": {}}
    validate_normalizer(config)
    normalizer_id = str(config.get("id"))
    parameters = config.get("parameters") or {}
    text = str(value or "")
    if normalizer_id == "exact_trimmed_casefold":
        normalized = text.strip().casefold()
    elif normalizer_id == "exact_trimmed":
        normalized = text.strip()
    elif normalizer_id == "integer":
        stripped = text.strip()
        if not re.fullmatch(r"[+-]?\d+", stripped):
            return "__INVALID_OUTPUT__"
        normalized = str(int(stripped))
    elif normalizer_id == "b80_exact_3":
        stripped = text.strip()
        if not re.fullmatch(r"[+-]?\d+", stripped):
            return "__INVALID_OUTPUT__"
        normalized = "exact_3" if str(int(stripped)) == "3" else "other_integer"
    elif normalizer_id == "behavior_label":
        normalized = text.strip().strip('`"\'.,:;!?()[]{}').casefold()
        normalized = re.sub(r"\s+", " ", normalized)
        if not re.fullmatch(r"[a-z][a-z .'-]*", normalized):
            return "__INVALID_OUTPUT__"
    elif normalizer_id == "fixed_enum":
        mapping = {str(key).strip().casefold(): str(value) for key, value in parameters["values"].items()}
        normalized = mapping.get(text.strip().casefold(), "__OTHER__")
    elif normalizer_id == "regex_capture":
        match = re.fullmatch(str(parameters["pattern"]), text.strip())
        normalized = match.group(1) if match else "__INVALID_OUTPUT__"
    elif normalizer_id == "whitespace_collapse":
        normalized = " ".join(text.split())
    else:
        raise AssertionError(normalizer_id)
    if not normalized:
        return "__INVALID_OUTPUT__"
    if len(normalized) > int(parameters.get("max_length", 128)):
        return "__INVALID_OUTPUT__"
    return normalized


def builtin_probability_normalizer(probe_id: str) -> dict[str, Any]:
    if probe_id == "b80_letter_count":
        return {"id": "b80_exact_3", "parameters": {}}
    if probe_id in {"rand_country", "rand_bird"}:
        return {"id": "behavior_label", "parameters": {}}
    return {"id": "exact_trimmed_casefold", "parameters": {}}


__all__ = ["NORMALIZER_IDS", "builtin_probability_normalizer", "normalize_answer", "validate_normalizer"]
