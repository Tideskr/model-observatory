from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from typing import Any
import uuid

from .utils import atomic_write_json, utc_now


AUTH_LIKE = re.compile(r"(?i)(?:bearer\s+)?sk-[A-Za-z0-9_-]{8,}")


class RetentionWriteError(RuntimeError):
    pass


def _redact_auth_like(value: str) -> str:
    return AUTH_LIKE.sub("[AUTH_VALUE_OMITTED]", value)


def _safe_headers(headers: dict[str, Any] | None) -> dict[str, str]:
    result = {}
    for key, value in (headers or {}).items():
        if str(key).casefold() in {"authorization", "proxy-authorization", "x-api-key", "api-key"}:
            continue
        result[str(key)] = _redact_auth_like(str(value))
    return result


def _redact_tree(value: Any, key: str | None = None) -> Any:
    if key and key.casefold() in {"authorization", "proxy-authorization", "x-api-key", "api-key", "api_key", "apikey"}:
        return "[AUTH_VALUE_OMITTED]"
    if isinstance(value, dict):
        return {str(child_key): _redact_tree(child, str(child_key)) for child_key, child in value.items()}
    if isinstance(value, list):
        return [_redact_tree(child) for child in value]
    if isinstance(value, str):
        return _redact_auth_like(value)
    return value


def _sanitize_url(value: str) -> tuple[str, bool]:
    from urllib.parse import urlsplit, urlunsplit
    parsed = urlsplit(value)
    hostname = parsed.hostname or ""
    if parsed.port:
        hostname += f":{parsed.port}"
    sanitized = urlunsplit((parsed.scheme, hostname, parsed.path, "", ""))
    return sanitized, sanitized != value


class RawRetention:
    def __init__(self, base_directory: str | Path, session_id: str):
        base = Path(base_directory)
        if not base.is_absolute():
            raise RetentionWriteError("retention path must be absolute")
        lowered = str(base.resolve()).casefold()
        system_temp = str(Path(tempfile.gettempdir()).resolve()).casefold()
        if lowered.startswith(system_temp) or "outputs\\gpt56_api_detector" in lowered or "outputs/gpt56_api_detector" in lowered:
            raise RetentionWriteError("retention path cannot be the system temp or public package tree")
        self.directory = base / f"session-{session_id}"
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            probe = self.directory / ".retention-write-test"
            with probe.open("wb") as handle:
                handle.write(b"ok")
                handle.flush()
                os.fsync(handle.fileno())
            probe.unlink(missing_ok=True)
        except OSError as exc:
            raise RetentionWriteError(f"所选目录无写入权限：{base}\n请改选当前用户有权限写入的目录。") from exc
        self.raw_path = self.directory / "raw_exchange.jsonl"
        self.index_path = self.directory / "raw_exchange.index.jsonl"
        self.manifest_path = self.directory / "retention_manifest.json"
        self._lock = threading.Lock()
        existing_index = []
        if self.index_path.exists():
            existing_index = [json.loads(line) for line in self.index_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.record_count = len(existing_index)
        self.byte_count = self.raw_path.stat().st_size if self.raw_path.exists() else 0
        self._raw_hasher = hashlib.sha256()
        if self.raw_path.exists():
            self._raw_hasher.update(self.raw_path.read_bytes())
        self.failures = 0
        self.complete = True
        self._record_ids: list[str] = [str(item.get("record_id")) for item in existing_index]

    def write(self, record: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            record_id = str(record.get("record_id") or f"rec-{self.record_count + 1:08d}-{uuid.uuid4().hex[:8]}")
            sanitized_url, changed = _sanitize_url(str(record.get("sanitized_url") or record.get("url") or ""))
            safe = {
                "record_id": record_id,
                "session_id": str(record.get("session_id", "")),
                "job_id": str(record.get("job_id", "")),
                "started_at": record.get("started_at"),
                "first_event_at": record.get("first_event_at"),
                "completed_at": record.get("completed_at") or utc_now(),
                "request_id": record.get("request_id"),
                "sanitized_url": sanitized_url,
                "url_sanitized": changed or bool(record.get("url_sanitized")),
                "request_format": record.get("request_format"),
                "context_mode": record.get("context_mode"),
                "model": record.get("model"),
                "effort": record.get("effort"),
                "http_status": record.get("http_status"),
                "response_headers_without_auth": _safe_headers(record.get("response_headers_without_auth") or record.get("response_headers")),
                "elapsed_ms": record.get("elapsed_ms"),
                "time_to_first_event_ms": record.get("time_to_first_event_ms"),
                "stream_event_count": record.get("stream_event_count"),
                "request_body_utf8_exact": _redact_auth_like(str(record.get("request_body_utf8_exact", ""))),
                "response_stream_utf8_exact": _redact_auth_like(str(record.get("response_stream_utf8_exact", ""))),
                "parsed_response_json_if_available": _redact_tree(record.get("parsed_response_json_if_available")),
                "transport_error_if_any": _redact_auth_like(str(record.get("transport_error_if_any", ""))) or None,
                "auth_header_omitted": True,
            }
            safe["request_body_sha256"] = hashlib.sha256(safe["request_body_utf8_exact"].encode("utf-8")).hexdigest()
            safe["response_stream_sha256"] = hashlib.sha256(safe["response_stream_utf8_exact"].encode("utf-8")).hexdigest()
            encoded = (json.dumps(safe, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            temporary = self.directory / f".{record_id}.tmp"
            try:
                with temporary.open("wb") as handle:
                    handle.write(encoded)
                    handle.flush()
                    os.fsync(handle.fileno())
                with self.raw_path.open("ab") as raw:
                    offset = raw.tell()
                    raw.write(encoded)
                    raw.flush()
                    os.fsync(raw.fileno())
                index = {
                    "record_id": record_id, "job_id": safe["job_id"], "completed_at": safe["completed_at"],
                    "byte_offset": offset, "byte_length": len(encoded),
                }
                with self.index_path.open("ab") as output:
                    output.write((json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
                    output.flush()
                    os.fsync(output.fileno())
                temporary.unlink(missing_ok=True)
            except OSError as exc:
                self.failures += 1
                self.complete = False
                temporary.unlink(missing_ok=True)
                self._raw_hasher = hashlib.sha256()
                if self.raw_path.exists():
                    self._raw_hasher.update(self.raw_path.read_bytes())
                try:
                    self.finalize()
                except OSError:
                    pass
                raise RetentionWriteError(f"raw retention failed: {type(exc).__name__}") from exc
            self.record_count += 1
            self.byte_count += len(encoded)
            self._raw_hasher.update(encoded)
            self._record_ids.append(record_id)
            return index

    def finalize(self) -> dict[str, Any]:
        raw_hash = self._raw_hasher.hexdigest() if self.raw_path.exists() else None
        manifest = {
            "schema_version": 1,
            "updated_at": utc_now(),
            "record_count": self.record_count,
            "bytes": self.byte_count,
            "first_record_id": self._record_ids[0] if self._record_ids else None,
            "last_record_id": self._record_ids[-1] if self._record_ids else None,
            "gaps": [],
            "write_failures": self.failures,
            "complete": self.complete and self.failures == 0,
            "raw_exchange_sha256": raw_hash,
            "auth_values_persisted": False,
        }
        atomic_write_json(self.manifest_path, manifest)
        return manifest


__all__ = ["RawRetention", "RetentionWriteError"]
