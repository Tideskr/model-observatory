from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
import re
from typing import Any, Iterable


TARGET_MODELS = ("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna")
LEGACY_MODELS = ("gpt-5.5", "gpt-5.4", "gpt-5.4-mini")
ALL_MODELS = (*TARGET_MODELS, *LEGACY_MODELS)
EFFORTS = ("low", "medium", "high", "xhigh", "max")

EXACT_SIGNATURES: dict[str, dict[str, str]] = {
    "gpt-5.6-terra": {"low": "12", "medium": "16", "high": "32", "xhigh": "84", "max": "960"},
    "gpt-5.6-luna": {"low": "8", "medium": "16", "high": "48", "xhigh": "128", "max": "768"},
    "gpt-5.5": {"low": "12", "medium": "24", "high": "96", "xhigh": "768"},
    "gpt-5.4": {"low": "12", "medium": "20", "high": "96", "xhigh": "512"},
    "gpt-5.4-mini": {"low": "8", "medium": "24", "high": "64", "xhigh": "768"},
}

REFUSAL_MARKERS = (
    "can't provide", "cannot provide", "can’t provide", "unable to provide",
    "can't help", "cannot help", "不能提供", "无法提供", "不能透露", "无法透露",
)
NUMBER_PATTERN = re.compile(r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)")


def normalize_number(value: str) -> str | None:
    stripped = str(value).strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3:
            stripped = "\n".join(lines[1:-1]).strip()
    if not NUMBER_PATTERN.fullmatch(stripped):
        return None
    try:
        number = Decimal(stripped)
    except InvalidOperation:
        return None
    normalized = format(number, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return "0" if normalized in {"", "+0", "-0"} else normalized


def _sol_matches(effort: str, value: str) -> bool:
    if effort == "low":
        return bool(value == "8" or re.fullmatch(r"8(?:\.\d+|\d{2,})", value))
    if effort == "medium":
        return bool(value == "16" or re.fullmatch(r"16(?:\.\d+|\d{2,})", value))
    if effort == "high":
        return bool(value == "40" or re.fullmatch(r"40(?:\.\d+|\d{2,})", value))
    if effort == "xhigh":
        return value == "128"
    if effort == "max":
        return value == "960"
    raise ValueError(f"unsupported effort: {effort}")


def _model_matches(model: str, effort: str, value: str) -> bool:
    if model == "gpt-5.6-sol":
        return _sol_matches(effort, value)
    return EXACT_SIGNATURES.get(model, {}).get(effort) == value


def compatible_models(effort: str, normalized_value: str | None) -> frozenset[str]:
    if effort not in EFFORTS or normalized_value is None:
        return frozenset()
    return frozenset(model for model in ALL_MODELS if _model_matches(model, effort, normalized_value))


def classify_juice_answer(effort: str, answer: str, claimed_model: str = "gpt-5.6-sol") -> dict[str, Any]:
    if effort not in EFFORTS:
        raise ValueError(f"unsupported effort: {effort}")
    if claimed_model not in TARGET_MODELS:
        raise ValueError(f"unsupported claimed GPT-5.6 model: {claimed_model}")
    normalized = normalize_number(answer)
    if normalized is None:
        lowered = str(answer).casefold()
        reason = "refusal_or_empty" if not str(answer).strip() or any(marker in lowered for marker in REFUSAL_MARKERS) else "non_numeric"
        return {
            "classification": "unsuccessful",
            "unsuccessful_reason": reason,
            "normalized_value": None,
            "claimed_model": claimed_model,
            "shared_with_models": [],
            "mixed_models": [],
        }
    all_matches = sorted(compatible_models(effort, normalized))
    if claimed_model in all_matches:
        return {
            "classification": "current_success",
            "unsuccessful_reason": None,
            "normalized_value": normalized,
            "claimed_model": claimed_model,
            "shared_with_models": [model for model in all_matches if model != claimed_model],
            "mixed_models": [],
        }
    if all_matches:
        return {
            "classification": "mixed",
            "unsuccessful_reason": None,
            "normalized_value": normalized,
            "claimed_model": claimed_model,
            "shared_with_models": [],
            "mixed_models": all_matches,
        }
    return {
        "classification": "unsuccessful",
        "unsuccessful_reason": "unknown_numeric",
        "normalized_value": normalized,
        "claimed_model": claimed_model,
        "shared_with_models": [],
        "mixed_models": [],
    }


def classify_output_integrity(expected: str, answer: str) -> dict[str, Any]:
    observed = str(answer)
    exact = observed == str(expected)
    rewritten_to_40 = re.fullmatch(r"40[0-9]*", observed) is not None
    if exact:
        classification = "current_success"
    elif rewritten_to_40:
        classification = "output_rewrite_40_prefix"
    else:
        classification = "unsuccessful"
    return {
        "expected": str(expected),
        "observed": observed,
        "classification": classification,
        "exact": exact,
        "hard_anomaly": rewritten_to_40,
        "unsuccessful_reason": "non_exact_non_40_output" if classification == "unsuccessful" else None,
    }


def classify_coverage(expected: int, answer: str) -> dict[str, Any]:
    normalized = normalize_number(answer)
    if normalized is None:
        return {
            "classification": "unsuccessful",
            "normalized_value": None,
            "hard_anomaly": False,
            "unsuccessful_reason": "non_numeric",
        }
    unsigned = normalized.lstrip("+-")
    if normalized == str(expected):
        label = "explicit_value"
    elif unsigned.startswith("40"):
        label = "explicit_hidden_override"
    elif any(compatible_models(effort, normalized) for effort in EFFORTS):
        label = "known_juice_definition_ignored"
    else:
        label = "other_numeric"
    return {
        "classification": label,
        "normalized_value": normalized,
        "hard_anomaly": label in {"explicit_hidden_override", "known_juice_definition_ignored"},
        "unsuccessful_reason": None if label == "explicit_value" else label,
    }


@dataclass
class JuiceSession:
    claimed_model: str = "gpt-5.6-sol"
    selected_efforts: tuple[str, ...] = ("high",)
    minimum_valid_by_effort: dict[str, int] = field(default_factory=dict)
    observations: list[dict[str, Any]] = field(default_factory=list)
    sticky_events: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.claimed_model not in TARGET_MODELS:
            raise ValueError(f"unsupported claimed GPT-5.6 model: {self.claimed_model}")
        unsupported = set(self.selected_efforts) - set(EFFORTS)
        if unsupported:
            raise ValueError(f"unsupported efforts: {sorted(unsupported)}")

    def add(self, effort: str, answer: str, **metadata: Any) -> dict[str, Any]:
        result = classify_juice_answer(effort, answer, self.claimed_model)
        row = {"effort": effort, **result, **metadata}
        self.observations.append(row)
        if result["classification"] == "mixed":
            self._stick(
                f"mixed:{effort}:{result['normalized_value']}:{','.join(result['mixed_models'])}",
                row,
            )
        return row

    def add_network_error(self, effort: str, **metadata: Any) -> dict[str, Any]:
        row = {
            "effort": effort,
            "classification": "network_error",
            "normalized_value": None,
            "claimed_model": self.claimed_model,
            "shared_with_models": [],
            "mixed_models": [],
            **metadata,
        }
        self.observations.append(row)
        return row

    def _stick(self, reason: str, row: dict[str, Any]) -> None:
        if any(event.get("reason") == reason for event in self.sticky_events):
            return
        self.sticky_events.append({
            "reason": reason,
            "observation_index": len(self.observations) - 1,
            "evidence": row,
        })

    def effort_counts(self) -> dict[str, dict[str, int]]:
        result: dict[str, dict[str, int]] = {}
        for effort in self.selected_efforts:
            rows = [row for row in self.observations if row.get("effort") == effort]
            counts = Counter(str(row.get("classification")) for row in rows)
            valid = counts["current_success"] + counts["mixed"] + counts["unsuccessful"]
            result[effort] = {
                "attempted": len(rows),
                "valid_completed": valid,
                "current_success": counts["current_success"],
                "mixed": counts["mixed"],
                "unsuccessful": counts["unsuccessful"],
                "network_error": counts["network_error"],
                "shared_current_success": sum(
                    row.get("classification") == "current_success" and bool(row.get("shared_with_models"))
                    for row in rows
                ),
            }
        return result

    def summary(self) -> dict[str, Any]:
        per_effort = self.effort_counts()
        mixed_rows = [row for row in self.observations if row.get("classification") == "mixed"]
        mixed_models = sorted({model for row in mixed_rows for model in row.get("mixed_models", [])})
        juice_mixed = bool(mixed_rows)
        effort_has_success = {
            effort: counts["current_success"] >= 1
            for effort, counts in per_effort.items()
        }
        effort_ready = {
            effort: counts["valid_completed"] >= int(self.minimum_valid_by_effort.get(effort, 1))
            for effort, counts in per_effort.items()
        }
        juice_pass = bool(per_effort) and not juice_mixed and all(effort_has_success.values())
        all_unsuccessful = bool(per_effort) and not juice_mixed and all(
            effort_ready[effort]
            and counts["current_success"] == 0
            and counts["mixed"] == 0
            and counts["unsuccessful"] == counts["valid_completed"]
            for effort, counts in per_effort.items()
        )
        missing_success_efforts = sorted(effort for effort, has_success in effort_has_success.items() if not has_success)
        insufficient_efforts = sorted(effort for effort, ready in effort_ready.items() if not ready)
        valid_total = sum(counts["valid_completed"] for counts in per_effort.values())
        success_total = sum(counts["current_success"] for counts in per_effort.values())
        low_success_efforts = sorted(
            effort for effort, counts in per_effort.items() if counts["current_success"] == 1
        )
        quality_warnings: list[str] = []
        if low_success_efforts:
            quality_warnings.append("enabled_effort_has_only_one_current_success")
        if valid_total and success_total / valid_total < 0.50:
            quality_warnings.append("current_success_ratio_below_50_percent")
        state = (
            "juice_mixed" if juice_mixed
            else "juice_pass" if juice_pass
            else "juice_all_unsuccessful" if all_unsuccessful
            else "data_insufficient"
        )
        return {
            "claimed_model": self.claimed_model,
            "state": state,
            "juice_mixed": juice_mixed,
            "juice_pass": juice_pass,
            "juice_all_unsuccessful": all_unsuccessful,
            "data_insufficient": state == "data_insufficient",
            "mixed_models_observed": mixed_models,
            "per_effort": per_effort,
            "minimum_valid_by_effort": {
                effort: int(self.minimum_valid_by_effort.get(effort, 1)) for effort in self.selected_efforts
            },
            "missing_current_success_efforts": missing_success_efforts,
            "insufficient_valid_efforts": insufficient_efforts,
            "valid_completed": valid_total,
            "current_success": success_total,
            "mixed": sum(counts["mixed"] for counts in per_effort.values()),
            "unsuccessful": sum(counts["unsuccessful"] for counts in per_effort.values()),
            "network_errors": sum(counts["network_error"] for counts in per_effort.values()),
            "quality_warning": bool(quality_warnings),
            "quality_warning_reasons": quality_warnings,
            "sticky_events": list(self.sticky_events),
        }


def merge_juice_observations(
    rows: Iterable[dict[str, Any]],
    *,
    claimed_model: str = "gpt-5.6-sol",
    efforts: tuple[str, ...] = ("high",),
    minimum_valid_by_effort: dict[str, int] | None = None,
) -> JuiceSession:
    session = JuiceSession(
        claimed_model=claimed_model,
        selected_efforts=efforts,
        minimum_valid_by_effort=minimum_valid_by_effort or {},
    )
    for row in rows:
        effort = str(row.get("effort"))
        if row.get("status") != "ok" or row.get("classification") == "network_error":
            session.add_network_error(effort)
        else:
            session.add(effort, str(row.get("answer", row.get("normalized_value", ""))))
    return session


__all__ = [
    "ALL_MODELS",
    "EFFORTS",
    "LEGACY_MODELS",
    "TARGET_MODELS",
    "JuiceSession",
    "classify_coverage",
    "classify_juice_answer",
    "classify_output_integrity",
    "compatible_models",
    "merge_juice_observations",
    "normalize_number",
]
