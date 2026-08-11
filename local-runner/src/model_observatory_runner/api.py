from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import math
import secrets
import threading
import time
from typing import Any, Callable
from urllib.parse import urlsplit
import uuid

from .utils import normalize_api_base_url, utc_now
from .release import SCORING_RELEASE_ID


DISCLOSURE_VERSION = "remote-normal-v1"
VALID_MODELS = {"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}
VALID_FORMATS = {"normal", "native_codex"}
VALID_CONTEXTS = {"no_history", "fixed_32k_history"}
VALID_PROBES = {
    "juice_low",
    "juice_medium",
    "juice_high",
    "juice_xhigh",
    "juice_max",
    "output_luna_48",
    "output_terra_32",
    "juice_coverage",
    "rand_country",
    "rand_bird",
    "b80_letter_count",
}
TERMINAL_STATUSES = {"completed", "failed", "cancelled", "incomplete", "timed_out"}


class ApiProblem(ValueError):
    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


def _integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise ApiProblem(400, "invalid_request", f"{name} must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ApiProblem(400, "invalid_request", f"{name} must be an integer") from exc
    if parsed != value or not minimum <= parsed <= maximum:
        raise ApiProblem(400, "invalid_request", f"{name} must be between {minimum} and {maximum}")
    return parsed


def _number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool):
        raise ApiProblem(400, "invalid_request", f"{name} must be a number")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ApiProblem(400, "invalid_request", f"{name} must be a number") from exc
    if not math.isfinite(parsed) or not minimum <= parsed <= maximum:
        raise ApiProblem(400, "invalid_request", f"{name} is outside the allowed range")
    return parsed


def translate_run_config(value: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(value, dict):
        raise ApiProblem(400, "invalid_config", "config must be an object")
    selections = value.get("probes")
    if not isinstance(selections, list) or not 1 <= len(selections) <= len(VALID_PROBES):
        raise ApiProblem(400, "invalid_config", "config.probes must contain 1-11 probes")

    probes: dict[str, dict[str, Any]] = {}
    normalized_selections: list[dict[str, Any]] = []
    for selection in selections:
        if not isinstance(selection, dict):
            raise ApiProblem(400, "invalid_config", "each probe selection must be an object")
        probe_id = str(selection.get("probe_id") or "")
        if probe_id not in VALID_PROBES or probe_id in probes:
            raise ApiProblem(400, "invalid_config", f"unsupported or duplicate probe: {probe_id}")
        requests = _integer(selection.get("requests"), f"requests for {probe_id}", 1, 100)
        probe = {"enabled": True, "requests": requests}
        if probe_id.startswith("juice_") and probe_id != "juice_coverage":
            probe["effort"] = probe_id.removeprefix("juice_")
        elif probe_id.startswith("output_") or probe_id == "juice_coverage":
            probe["effort"] = "high"
        else:
            probe["effort"] = "low"
        if probe_id == "b80_letter_count":
            probe["profiles"] = ["normal+no_history"]
        probes[probe_id] = probe
        normalized_selections.append({"probe_id": probe_id, "requests": requests})

    formats = value.get("formats")
    contexts = value.get("contexts")
    if not isinstance(formats, list) or not formats or len(formats) != len(set(formats)):
        raise ApiProblem(400, "invalid_config", "config.formats must be a non-empty unique array")
    if not isinstance(contexts, list) or not contexts or len(contexts) != len(set(contexts)):
        raise ApiProblem(400, "invalid_config", "config.contexts must be a non-empty unique array")
    if any(item not in VALID_FORMATS for item in formats):
        raise ApiProblem(400, "invalid_config", "config.formats contains an unsupported format")
    if any(item not in VALID_CONTEXTS for item in contexts):
        raise ApiProblem(400, "invalid_config", "config.contexts contains an unsupported context")

    workers = _integer(value.get("workers"), "config.workers", 1, 16)
    retries = _integer(value.get("retries"), "config.retries", 0, 3)
    normalized = {
        "probes": normalized_selections,
        "formats": list(formats),
        "contexts": list(contexts),
        "workers": workers,
        "retries": retries,
    }
    legacy = {
        "mode": "single",
        "base_preset": "low",
        "workers": workers,
        "retries": retries,
        "request_formats": list(formats),
        "context_modes": list(contexts),
        "probes": probes,
        "custom_probes": [],
    }
    return normalized, legacy


def estimate_run(config: dict[str, Any], pricing: Any) -> dict[str, Any]:
    profiles = [
        f"{request_format}+{context_mode}"
        for request_format in config["formats"]
        for context_mode in config["contexts"]
    ]
    requests = 0
    long_context_requests = 0
    weighted_seconds = 0.0
    for selection in config["probes"]:
        applicable = profiles
        if selection["probe_id"] == "b80_letter_count":
            applicable = [profile for profile in profiles if profile == "normal+no_history"]
        for profile in applicable:
            count = selection["requests"]
            requests += count
            request_format, context_mode = profile.split("+", 1)
            if context_mode == "fixed_32k_history":
                long_context_requests += count
            weighted_seconds += count * (6.0 if request_format == "native_codex" else 3.5)
    if requests < 1:
        raise ApiProblem(400, "invalid_config", "the selected probes do not apply to any selected profile")

    input_tokens = long_context_requests * 33792 + (requests - long_context_requests) * 320
    output_tokens = requests * 40
    attempts = config["retries"] + 1
    maximum_input_tokens = input_tokens * attempts
    maximum_output_tokens = requests * attempts * 2048
    prices = pricing if isinstance(pricing, dict) else {}
    input_price = _number(prices.get("input_per_million", 0), "pricing.input_per_million", 0, 100_000)
    output_price = _number(prices.get("output_per_million", 0), "pricing.output_per_million", 0, 100_000)
    multiplier = _number(prices.get("multiplier", 1), "pricing.multiplier", 0, 1000)

    def cost(inputs: int, outputs: int) -> float:
        return ((inputs * input_price + outputs * output_price) / 1_000_000) * multiplier

    return {
        "requests": requests,
        "maximum_attempts": requests * attempts,
        "long_context_requests": long_context_requests,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "maximum_input_tokens": maximum_input_tokens,
        "maximum_output_tokens": maximum_output_tokens,
        "estimated_seconds": max(1, round(weighted_seconds / config["workers"])),
        "estimated_cost_usd": cost(input_tokens, output_tokens),
        "maximum_cost_usd": cost(maximum_input_tokens, maximum_output_tokens),
    }


def _expires(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _expired(value: str) -> bool:
    return datetime.fromisoformat(value).timestamp() <= time.time()


def _private_status(value: str) -> str:
    return {
        "idle": "failed",
        "running": "running",
        "stopping": "running",
        "complete": "completed",
        "stopped": "cancelled",
        "error": "failed",
        "interrupted": "incomplete",
    }.get(value, "failed")


class ObservatoryApi:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.quotes: dict[str, dict[str, Any]] = {}
        self.runs: dict[str, dict[str, Any]] = {}
        self.idempotency: dict[str, str] = {}

    def issue_quote(self, body: Any) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise ApiProblem(400, "invalid_request", "request body must be an object")
        try:
            target_base_url = normalize_api_base_url(str(body.get("base_url") or ""))
        except ValueError as exc:
            raise ApiProblem(400, "invalid_target", str(exc)) from exc
        model = str(body.get("model") or "")
        if model not in VALID_MODELS:
            raise ApiProblem(400, "invalid_model", "only gpt-5.6 Sol, Terra, and Luna are supported")
        config, legacy_config = translate_run_config(body.get("config"))
        estimate = estimate_run(config, body.get("pricing"))
        budget = _number(body.get("maximum_budget_usd"), "maximum_budget_usd", 0.01, 1000)
        if estimate["maximum_cost_usd"] > budget + 1e-9:
            raise ApiProblem(400, "budget_exceeded", "the estimated maximum cost exceeds the approved budget")
        parsed = urlsplit(target_base_url)
        target_origin = f"{parsed.scheme}://{parsed.netloc}"
        token = secrets.token_urlsafe(48)
        quote_id = str(uuid.uuid4())
        expires_at = _expires(10 * 60)
        quote = {
            "quote_id": quote_id,
            "target_origin": target_origin,
            "target_base_url": target_base_url,
            "target_hostname": parsed.hostname or "",
            "model": model,
            "config": config,
            "legacy_config": legacy_config,
            "estimate": estimate,
            "expires_at": expires_at,
        }
        with self.lock:
            self._cleanup()
            self.quotes[token] = quote
        return {
            "api_version": "v1",
            "quote_id": quote_id,
            "quote_token": token,
            "target_origin": target_origin,
            "target_base_url": target_base_url,
            "target_hostname": parsed.hostname or "",
            "model": model,
            "config": config,
            "estimate": estimate,
            "disclosure_version": DISCLOSURE_VERSION,
            "retention": {"raw_response": "not_retained", "report_hours": 24},
            "expires_at": expires_at,
        }

    def create_run(
        self,
        body: Any,
        idempotency_key: str,
        starter: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise ApiProblem(400, "invalid_request", "request body must be an object")
        if not 8 <= len(idempotency_key) <= 128:
            raise ApiProblem(400, "invalid_idempotency_key", "Idempotency-Key must contain 8-128 characters")
        with self.lock:
            self._cleanup()
            existing_id = self.idempotency.get(idempotency_key)
            if existing_id:
                return self._create_response(self.runs[existing_id])
            quote_token = str(body.get("quote_token") or "")
            quote = self.quotes.get(quote_token)
            if quote is None or _expired(quote["expires_at"]):
                raise ApiProblem(400, "invalid_quote", "the local run quote is invalid or expired")
        api_key = body.get("api_key")
        if not isinstance(api_key, str) or not api_key or len(api_key) > 4096:
            raise ApiProblem(400, "invalid_api_key", "api_key must contain 1-4096 characters")
        consent = body.get("consent")
        if not isinstance(consent, dict) or consent.get("disclosure_version") != DISCLOSURE_VERSION:
            raise ApiProblem(400, "invalid_consent", "the disclosure version was not accepted")

        start_result = starter({
            "base_url": quote["target_base_url"],
            "model": quote["model"],
            "api_key": api_key,
            "config": deepcopy(quote["legacy_config"]),
            "retention_enabled": False,
        })
        run_id = str(uuid.uuid4())
        owner_token = secrets.token_urlsafe(48)
        run = {
            "run_id": run_id,
            "owner_token": owner_token,
            "session_id": start_result["session_id"],
            "quote": deepcopy(quote),
            "status": "running",
            "created_at": utc_now(),
            "expires_at": _expires(24 * 60 * 60),
            "events": [{
                "id": 1,
                "type": "status",
                "payload": {
                    "status": "running",
                    "phase": "executing",
                    "completed": 0,
                    "total": quote["estimate"]["requests"],
                    "successful": 0,
                    "errors": 0,
                    "cancelled": 0,
                    "pending": quote["estimate"]["requests"],
                    "in_flight": 0,
                    "http_attempts": 0,
                    "retries": 0,
                },
            }],
            "last_snapshot": None,
            "report": None,
        }
        with self.lock:
            self.runs[run_id] = run
            self.idempotency[idempotency_key] = run_id
        return self._create_response(run)

    def events(self, run_id: str, owner_token: str, after: int, app_state: Any) -> list[dict[str, Any]]:
        deadline = time.monotonic() + 1.0
        while True:
            run = self._authorized_run(run_id, owner_token)
            self._refresh(run, app_state)
            with self.lock:
                available = [deepcopy(event) for event in run["events"] if event["id"] > after]
                terminal = run["status"] in TERMINAL_STATUSES
            if available or terminal or time.monotonic() >= deadline:
                return available
            time.sleep(0.1)

    def report(self, run_id: str, owner_token: str, app_state: Any) -> dict[str, Any]:
        run = self._authorized_run(run_id, owner_token)
        self._refresh(run, app_state)
        with self.lock:
            if run["report"] is None:
                raise ApiProblem(409, "report_not_ready", "the local run report is not ready")
            return deepcopy(run["report"])

    def cancel(
        self,
        run_id: str,
        owner_token: str,
        app_state: Any,
        stopper: Callable[[], dict[str, Any]],
    ) -> dict[str, Any]:
        run = self._authorized_run(run_id, owner_token)
        self._refresh(run, app_state)
        with self.lock:
            if run["status"] in TERMINAL_STATUSES:
                return {"api_version": "v1", "run_id": run_id, "status": run["status"]}
        current = app_state.safe_status("detector")
        if current.get("session_id") != run["session_id"]:
            raise ApiProblem(409, "run_not_active", "the local detector is no longer executing this run")
        stopper()
        deadline = time.monotonic() + 15.0
        while True:
            self._refresh(run, app_state)
            with self.lock:
                if run["status"] in TERMINAL_STATUSES or time.monotonic() >= deadline:
                    break
            time.sleep(0.1)
        return {"api_version": "v1", "run_id": run_id, "status": run["status"]}

    def _authorized_run(self, run_id: str, owner_token: str) -> dict[str, Any]:
        with self.lock:
            self._cleanup()
            run = self.runs.get(run_id)
            if run is None:
                raise ApiProblem(404, "run_not_found", "the local run was not found")
            if not secrets.compare_digest(run["owner_token"], owner_token):
                raise ApiProblem(401, "invalid_owner_token", "the local run owner token is invalid")
            return run

    def _refresh(self, run: dict[str, Any], app_state: Any) -> None:
        current = app_state.safe_status("detector")
        if current.get("session_id") != run["session_id"]:
            return
        status = _private_status(str(current.get("status") or "error"))
        progress = current.get("progress") if isinstance(current.get("progress"), dict) else {}
        completed = int(progress.get("logical_completed") or 0)
        total = int(progress.get("planned") or run["quote"]["estimate"]["requests"])
        payload = {
            "status": status,
            "phase": "finished" if status in TERMINAL_STATUSES else "executing",
            "completed": completed,
            "total": total,
            "successful": int(progress.get("successful") or 0),
            "errors": int(progress.get("errors") or 0),
            "cancelled": int(progress.get("cancelled") or 0),
            "pending": int(progress.get("pending") or max(0, total - completed)),
            "in_flight": int(progress.get("in_flight") or 0),
            "http_attempts": int(progress.get("http_attempts") or 0),
            "retries": int(progress.get("retries") or 0),
            "updated_at": progress.get("updated_at") or current.get("updated_at"),
        }
        snapshot = tuple(payload.items())
        with self.lock:
            if snapshot != run["last_snapshot"]:
                run["status"] = status
                event_type = "finished" if status in TERMINAL_STATUSES else "status"
                run["events"].append({
                    "id": run["events"][-1]["id"] + 1,
                    "type": event_type,
                    "payload": payload,
                })
                run["last_snapshot"] = snapshot

        store = app_state.current_detector_store()
        legacy_report = None
        if store is not None:
            try:
                legacy_report = store.report(run["session_id"])
            except (KeyError, RuntimeError):
                legacy_report = None
        if legacy_report is not None:
            self._cache_report(run, legacy_report)
        elif status == "failed":
            self._cache_failure(run, str(current.get("error") or "local detector failed"))

    def _cache_report(self, run: dict[str, Any], legacy: dict[str, Any]) -> None:
        network = legacy.get("network_summary") if isinstance(legacy.get("network_summary"), dict) else {}
        if legacy.get("run_stopped"):
            status = "cancelled"
        elif int(network.get("logical_completed") or 0) < int(network.get("logical_tasks") or 0):
            status = "incomplete"
        elif int(network.get("successful") or 0) == 0 and int(network.get("final_errors") or 0) > 0:
            status = "failed"
        elif int(network.get("final_errors") or 0) > 0:
            status = "incomplete"
        else:
            status = "completed"
        summary_keys = (
            "overall_verdict",
            "outcome_code",
            "title_cn",
            "subtitle_cn",
            "official",
            "official_grade",
            "trust_scope",
            "juice_summary",
            "output_integrity_summary",
            "coverage_summary",
            "fingerprint_summary",
            "profile_summary",
            "network_summary",
            "limitations",
        )
        summary = {key: deepcopy(legacy[key]) for key in summary_keys if key in legacy}
        error_groups: dict[tuple[Any, ...], dict[str, Any]] = {}
        raw_observations = legacy.get("observations")
        if isinstance(raw_observations, list):
            for value in raw_observations:
                if not isinstance(value, dict) or value.get("status") != "error":
                    continue
                error = value.get("safe_error") if isinstance(value.get("safe_error"), dict) else {}
                key = (
                    error.get("category") or "unknown_error",
                    error.get("safe_message"),
                    error.get("http_status"),
                    bool(error.get("retryable")),
                )
                group = error_groups.setdefault(key, {
                    "code": key[0],
                    "message": key[1],
                    "http_status": key[2],
                    "retryable": key[3],
                    "count": 0,
                    "attempts": 0,
                })
                group["count"] += 1
                group["attempts"] += int(value.get("attempts_sent") or 1)
        summary["error_summary"] = list(error_groups.values())
        network = legacy.get("network_summary") if isinstance(legacy.get("network_summary"), dict) else {}
        summary.update({
            "verdict_available": legacy.get("overall_verdict") is not None,
            "operational_status": status,
            "completed_requests": int(network.get("logical_completed") or 0),
            "successful_requests": int(network.get("successful") or 0),
            "failed_requests": int(network.get("final_errors") or 0),
            "cancelled_requests": int(network.get("cancelled") or 0),
            "http_attempts": int(network.get("http_attempts") or 0),
            "retries": int(network.get("retries") or 0),
        })
        if "output_integrity_summary" in summary:
            summary["output_integrity"] = deepcopy(summary["output_integrity_summary"])
        if "coverage_summary" in summary:
            summary["coverage"] = deepcopy(summary["coverage_summary"])
        observations = deepcopy(legacy.get("observations")) if isinstance(legacy.get("observations"), list) else []
        if not observations:
            profiles = legacy.get("profile_summary")
            if isinstance(profiles, dict):
                observations = [
                    {"profile": profile, **deepcopy(value)}
                    for profile, value in profiles.items()
                    if isinstance(value, dict)
                ]
        report = {
            "api_version": "v1",
            "run_id": run["run_id"],
            "status": status,
            "terminal": True,
            "scoring_release_id": SCORING_RELEASE_ID,
            "target": {"origin": run["quote"]["target_origin"], "model": run["quote"]["model"]},
            "summary": summary,
            "observations": observations,
            "created_at": str(legacy.get("updated_at") or utc_now()),
        }
        with self.lock:
            run["status"] = status
            run["report"] = report

    def _cache_failure(self, run: dict[str, Any], detail: str) -> None:
        report = {
            "api_version": "v1",
            "run_id": run["run_id"],
            "status": "failed",
            "terminal": True,
            "scoring_release_id": SCORING_RELEASE_ID,
            "target": {"origin": run["quote"]["target_origin"], "model": run["quote"]["model"]},
            "summary": {
                "overall_verdict": "检测失败",
                "title_cn": "检测失败",
                "subtitle_cn": detail,
                "verdict_available": False,
                "operational_status": "failed",
                "safe_error": "local_runner_failed",
                "completed_requests": 0,
                "successful_requests": 0,
                "failed_requests": 0,
                "error_detail": {
                    "stage": "local_runner",
                    "code": "local_runner_failed",
                    "status_code": None,
                    "retryable": False,
                    "message": detail,
                },
            },
            "observations": [],
            "created_at": utc_now(),
        }
        with self.lock:
            run["status"] = "failed"
            run["report"] = report

    @staticmethod
    def _create_response(run: dict[str, Any]) -> dict[str, Any]:
        return {
            "api_version": "v1",
            "run_id": run["run_id"],
            "owner_token": run["owner_token"],
            "owner_token_tail": run["owner_token"][-6:],
            "status": run["status"],
            "events_url": f"/api/v1/private-runs/{run['run_id']}/events",
            "expires_at": run["expires_at"],
        }

    def _cleanup(self) -> None:
        for token, quote in list(self.quotes.items()):
            if _expired(quote["expires_at"]):
                self.quotes.pop(token, None)
        expired_runs = [run_id for run_id, run in self.runs.items() if _expired(run["expires_at"])]
        for run_id in expired_runs:
            self.runs.pop(run_id, None)
        for key, run_id in list(self.idempotency.items()):
            if run_id not in self.runs:
                self.idempotency.pop(key, None)


__all__ = [
    "ApiProblem",
    "DISCLOSURE_VERSION",
    "ObservatoryApi",
    "estimate_run",
    "translate_run_config",
]
