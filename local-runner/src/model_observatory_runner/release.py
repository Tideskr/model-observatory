from __future__ import annotations

from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
from typing import Any


RELEASE_NAME = "gpt56-v3"


def release_root() -> Path:
    override = os.environ.get("MODEL_OBSERVATORY_SCORING_RELEASE_DIR")
    candidates = [
        Path(override).expanduser() if override else None,
        Path(__file__).with_name("_release"),
        Path(__file__).resolve().parents[3] / "scoring-releases" / RELEASE_NAME,
    ]
    for candidate in candidates:
        if candidate is not None and (candidate / "manifest.json").is_file():
            return candidate
    raise FileNotFoundError(f"Model Observatory scoring release {RELEASE_NAME} is missing")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache(maxsize=1)
def load_release_manifest() -> dict[str, Any]:
    root = release_root()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        raise ValueError("unsupported scoring release manifest schema")
    if manifest.get("release_id") != "stage-c-trusted-fingerprint-v3":
        raise ValueError("unexpected scoring release id")
    for name, item in (manifest.get("artifacts") or {}).items():
        path = root / str(item.get("file") or "")
        if not path.is_file() or _sha256(path) != item.get("sha256"):
            raise ValueError(f"scoring release artifact hash mismatch: {name}")
    return manifest


def release_file(artifact: str) -> Path:
    manifest = load_release_manifest()
    item = (manifest.get("artifacts") or {}).get(artifact)
    if not isinstance(item, dict):
        raise KeyError(artifact)
    return release_root() / str(item["file"])


SCORING_RELEASE_ID = str(load_release_manifest()["release_id"])


__all__ = ["RELEASE_NAME", "SCORING_RELEASE_ID", "load_release_manifest", "release_file", "release_root"]
