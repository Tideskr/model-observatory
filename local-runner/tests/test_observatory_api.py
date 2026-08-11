from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import shutil
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from model_observatory_runner.api import ApiProblem, ObservatoryApi, translate_run_config  # noqa: E402
from model_observatory_runner.juice import classify_juice_answer  # noqa: E402
from model_observatory_runner.release import release_file  # noqa: E402
from model_observatory_runner.server import create_server  # noqa: E402


def quote_body() -> dict[str, object]:
    return {
        "base_url": "https://api.example.com/v1",
        "model": "gpt-5.6-sol",
        "config": {
            "probes": [{"probe_id": "juice_high", "requests": 1}],
            "formats": ["normal"],
            "contexts": ["no_history"],
            "workers": 1,
            "retries": 0,
        },
        "maximum_budget_usd": 0.01,
        "pricing": {"input_per_million": 0, "output_per_million": 0, "multiplier": 1},
    }


class FakeStore:
    def __init__(self) -> None:
        self.value: dict[str, object] | None = None

    def report(self, _session_id: str) -> dict[str, object] | None:
        return self.value


class FakeState:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.store = FakeStore()
        self.status: dict[str, object] = {
            "status": "running",
            "session_id": session_id,
            "progress": {"logical_completed": 0, "planned": 1},
        }

    def safe_status(self, _name: str) -> dict[str, object]:
        return self.status

    def current_detector_store(self) -> FakeStore:
        return self.store


class MockResponsesHandler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        effort = request.get("reasoning", {}).get("effort")
        answer = {"low": "8", "medium": "16", "high": "40", "xhigh": "128", "max": "960"}.get(effort, "40")
        event = {
            "type": "response.completed",
            "response": {
                "id": "resp_test",
                "status": "completed",
                "output_text": answer,
                "output": [],
                "usage": {"input_tokens": 10, "output_tokens": 1},
            },
        }
        body = ("data: " + json.dumps(event, separators=(",", ":")) + "\n\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ObservatoryApiTests(unittest.TestCase):
    def test_shared_juice_conformance_cases(self) -> None:
        cases = json.loads(release_file("conformance").read_text(encoding="utf-8"))["juice_cases"]
        for case in cases:
            with self.subTest(case=case):
                result = classify_juice_answer(case["effort"], case["answer"], case["claimed_model"])
                self.assertEqual(result["normalized_value"], case["normalized_value"])
                self.assertEqual(result["classification"], case["classification"])
                self.assertEqual(result["mixed_models"], case["mixed_models"])

    def test_translates_native_config_and_restricts_b80_profile(self) -> None:
        normalized, legacy = translate_run_config({
            "probes": [{"probe_id": "b80_letter_count", "requests": 3}],
            "formats": ["normal", "native_codex"],
            "contexts": ["no_history", "fixed_32k_history"],
            "workers": 4,
            "retries": 3,
        })
        self.assertEqual(normalized["retries"], 3)
        self.assertEqual(legacy["request_formats"], ["normal", "native_codex"])
        self.assertEqual(legacy["probes"]["b80_letter_count"]["profiles"], ["normal+no_history"])

    def test_quote_run_events_and_report_lifecycle(self) -> None:
        api = ObservatoryApi()
        quote = api.issue_quote(quote_body())
        session_id = "session-a"
        created = api.create_run(
            {
                "quote_token": quote["quote_token"],
                "api_key": "temporary-key",
                "consent": {"disclosure_version": "remote-normal-v1"},
            },
            "idempotency-key-a",
            lambda _payload: {"session_id": session_id},
        )
        replay = api.create_run({}, "idempotency-key-a", lambda _payload: self.fail("must not restart"))
        self.assertEqual(replay["run_id"], created["run_id"])

        state = FakeState(session_id)
        events = api.events(created["run_id"], created["owner_token"], 0, state)
        self.assertGreaterEqual(len(events), 1)
        with self.assertRaises(ApiProblem) as pending:
            api.report(created["run_id"], created["owner_token"], state)
        self.assertEqual(pending.exception.status, 409)

        state.status = {
            "status": "complete",
            "session_id": session_id,
            "progress": {"logical_completed": 1, "planned": 1},
        }
        state.store.value = {
            "overall_verdict": "Juice通过；指纹证据不明确",
            "outcome_code": "juice_pass_fingerprint_unclear",
            "official": False,
            "scoring_version": "fingerprint-v3",
            "updated_at": "2026-08-10T00:00:00+00:00",
            "network_summary": {"logical_tasks": 1, "logical_completed": 1},
            "profile_summary": {"normal+no_history": {"logical_tasks": 1, "successful": 1}},
            "run_stopped": False,
        }
        report = api.report(created["run_id"], created["owner_token"], state)
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["summary"]["overall_verdict"], "Juice通过；指纹证据不明确")
        self.assertEqual(len(report["observations"]), 1)

        failed_legacy = dict(state.store.value)
        failed_legacy["network_summary"] = {
            "logical_tasks": 1,
            "logical_completed": 1,
            "successful": 0,
            "final_errors": 1,
            "http_attempts": 2,
            "retries": 1,
        }
        failed_legacy["observations"] = [{
            "job_id": "job-1",
            "probe_id": "juice_high",
            "profile": "normal+no_history",
            "status": "error",
            "attempts_sent": 2,
            "safe_error": {
                "category": "upstream_http_error",
                "http_status": 401,
                "retryable": False,
                "safe_message": "Upstream rejected the credential.",
            },
        }]
        state.store.value = failed_legacy
        api._cache_report(api.runs[created["run_id"]], failed_legacy)
        failed_report = api.report(created["run_id"], created["owner_token"], state)
        self.assertEqual(failed_report["status"], "failed")
        self.assertEqual(failed_report["summary"]["error_summary"][0]["http_status"], 401)
        self.assertEqual(failed_report["summary"]["error_summary"][0]["attempts"], 2)

    def test_idempotency_key_is_single_flight_under_concurrency(self) -> None:
        api = ObservatoryApi()
        quote = api.issue_quote(quote_body())
        body = {
            "quote_token": quote["quote_token"],
            "api_key": "temporary-key",
            "consent": {"disclosure_version": "remote-normal-v1"},
        }
        starter_calls = 0
        starter_lock = threading.Lock()

        def starter(_payload: dict[str, object]) -> dict[str, str]:
            nonlocal starter_calls
            with starter_lock:
                starter_calls += 1
            time.sleep(0.1)
            return {"session_id": "concurrent-session"}

        results: list[dict[str, object]] = []
        errors: list[BaseException] = []

        def create() -> None:
            try:
                results.append(api.create_run(body, "concurrent-idempotency-key", starter))
            except BaseException as error:  # pragma: no cover - assertion below reports unexpected failures
                errors.append(error)

        threads = [threading.Thread(target=create) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertFalse(errors)
        self.assertEqual(starter_calls, 1)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["run_id"], results[1]["run_id"])


class RunnerHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_root = Path(tempfile.mkdtemp(prefix="runner-tests-", dir=ROOT.parent))
        self.server = create_server(port=0, runs_root=self.temp_root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        for _attempt in range(5):
            try:
                shutil.rmtree(self.temp_root)
                break
            except PermissionError:
                time.sleep(0.1)
        else:
            shutil.rmtree(self.temp_root, ignore_errors=True)

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        origin: str = "https://check.skr.moe",
        body: object | None = None,
        extra_headers: dict[str, str] | None = None,
    ):
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Origin": origin}
        if data is not None:
            headers["Content-Type"] = "application/json"
        headers.update(extra_headers or {})
        return urlopen(Request(self.base_url + path, data=data, headers=headers, method=method), timeout=5)

    def test_status_and_private_network_preflight(self) -> None:
        with self.request("/status") as response:
            body = json.load(response)
            self.assertEqual(body["service"], "model-observatory-runner")
            self.assertEqual(body["protocol_version"], "private-runs-v1")
            self.assertEqual(body["scoring_release_id"], "stage-c-trusted-fingerprint-v4")
            self.assertTrue(body["capabilities"]["detailed_progress"])
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "https://check.skr.moe")
            self.assertEqual(response.headers["Access-Control-Allow-Private-Network"], "true")
        with self.request("/api/v1/private-runs/quote", method="OPTIONS") as response:
            self.assertEqual(response.status, 204)
            self.assertIn("Idempotency-Key", response.headers["Access-Control-Allow-Headers"])
        with self.assertRaises(HTTPError) as missing_ui:
            self.request("/")
        self.assertEqual(missing_ui.exception.code, 404)

    def test_accepts_any_web_origin_and_accepts_quote(self) -> None:
        with self.request("/status", origin="https://another-compatible-site.example") as response:
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "https://another-compatible-site.example")
        with self.request("/api/v1/private-runs/quote", method="POST", body=quote_body()) as response:
            body = json.load(response)
            self.assertEqual(body["model"], "gpt-5.6-sol")
            self.assertTrue(body["quote_token"])

    def test_real_detector_run_reaches_compatible_report(self) -> None:
        try:
            (self.temp_root / "detector").mkdir(parents=True, exist_ok=True)
        except PermissionError as error:
            self.skipTest(f"detector integration requires a writable nested run directory: {error}")
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), MockResponsesHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        try:
            body = quote_body()
            body["base_url"] = f"http://127.0.0.1:{upstream.server_address[1]}/v1"
            with self.request("/api/v1/private-runs/quote", method="POST", body=body) as response:
                quote = json.load(response)
            with self.request(
                "/api/v1/private-runs",
                method="POST",
                body={
                    "quote_token": quote["quote_token"],
                    "api_key": "temporary-test-key",
                    "consent": {"disclosure_version": "remote-normal-v1"},
                },
                extra_headers={"Idempotency-Key": "integration-run-key"},
            ) as response:
                created = json.load(response)

            report = None
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    with self.request(
                        f"/api/v1/private-runs/{created['run_id']}/report",
                        extra_headers={"Authorization": f"Bearer {created['owner_token']}"},
                    ) as response:
                        report = json.load(response)
                        break
                except HTTPError as error:
                    if error.code != 409:
                        raise
                    time.sleep(0.1)
            self.assertIsNotNone(report)
            self.assertEqual(report["status"], "completed")
            self.assertIn("overall_verdict", report["summary"])
        finally:
            upstream.shutdown()
            upstream.server_close()
            upstream_thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
