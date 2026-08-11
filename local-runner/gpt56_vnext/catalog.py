from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
PACKAGED_CATALOG = Path(__file__).with_name("baselines") / "runtime_catalog.json"
DEVELOPMENT_CATALOG = ROOT / "work" / "release_assets" / "gpt56_vnext" / "runtime_catalog_internal.json"


def load_catalog() -> dict[str, Any]:
    override = os.environ.get("GPT56_RUNTIME_CATALOG")
    path = Path(override) if override else PACKAGED_CATALOG if PACKAGED_CATALOG.is_file() else DEVELOPMENT_CATALOG
    if not path.is_file():
        raise FileNotFoundError("GPT-5.6 runtime catalog is missing; rebuild release assets before running")
    value = json.loads(path.read_text(encoding="utf-8"))
    return {
        "templates": value["templates"],
        "pools": value["pools"],
        "behavior_probes": value["behavior_probes"],
        "coverage_probe": value["coverage_probe"],
    }


def choose_juice_prompt(catalog: dict[str, Any], effort: str) -> tuple[str, str]:
    pool = catalog["pools"].get(effort) or []
    if not pool:
        raise ValueError(f"no calibrated Juice templates for {effort}")
    template_id = pool[secrets.randbelow(len(pool))]
    prompt = str(catalog["templates"][template_id]["prompt"]).replace("{nonce}", secrets.token_hex(6))
    return prompt, template_id


def build_coverage_messages(catalog: dict[str, Any], value: int) -> list[dict[str, str]]:
    return [
        {"role": item["role"], "content": item["content"].replace("{synthetic_value}", str(value))}
        for item in catalog["coverage_probe"]["messages"]
    ]


__all__ = ["build_coverage_messages", "choose_juice_prompt", "load_catalog"]
