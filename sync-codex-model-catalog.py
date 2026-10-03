#!/usr/bin/env python3
"""同步 OpenCode 代理模型到 Codex catalog。

默认只生成，不发起真实模型请求。首次使用请先执行：
  python sync-codex-model-catalog.py --limit 3 --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
DEFAULT_SOURCE = "http://127.0.0.1:8799/v1/models"
DEFAULT_OUTPUT = Path.home() / ".codex" / "cc-switch-model-catalog.json"
CAPABILITIES = ROOT / "model-capabilities.json"


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def fetch_models(source: str) -> list[dict]:
    with urlopen(source, timeout=5) as response:
        payload = json.loads(response.read().decode("utf-8"))
    models = payload.get("models") if isinstance(payload, dict) else payload
    if not isinstance(models, list):
        models = payload.get("data", []) if isinstance(payload, dict) else []
    result = []
    seen = set()
    for item in models:
        if not isinstance(item, dict):
            continue
        slug = item.get("slug") or item.get("id")
        if isinstance(slug, str) and slug and slug not in seen:
            seen.add(slug)
            result.append({"slug": slug, "display_name": item.get("display_name") or slug})
    return result


def capability(slug: str, metadata: dict) -> dict:
    exact = metadata.get("models", {}).get(slug, {})
    if exact:
        return {**metadata.get("defaults", {}), **exact}
    for prefix, value in metadata.get("prefixes", {}).items():
        if slug.lower().startswith(prefix.lower()):
            return {**metadata.get("defaults", {}), **value}
    return dict(metadata.get("defaults", {}))


def catalog_entry(model: dict, existing: dict, metadata: dict) -> dict:
    slug = model["slug"]
    old = existing.get(slug)
    if isinstance(old, dict):
        entry = dict(old)
        entry["slug"] = slug
        entry.setdefault("display_name", model["display_name"])
        return entry

    cap = capability(slug, metadata)
    reasoning = cap.get("reasoning", ["low", "medium"])
    entry = {
        "additional_speed_tiers": [],
        "availability_nux": None,
        "base_instructions": "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
        "context_window": cap.get("context_window", 128000),
        "default_reasoning_level": reasoning[0] if reasoning else "low",
        "default_reasoning_summary": "none",
        "description": model["display_name"],
        "display_name": model["display_name"],
        "effective_context_window_percent": 95,
        "experimental_supported_tools": [],
        "input_modalities": cap.get("input_modalities", ["text"]),
        "max_context_window": cap.get("context_window", 128000),
        "priority": 2000,
        "service_tiers": [],
        "shell_type": "shell_command",
        "slug": slug,
        "support_verbosity": False,
        "supported_in_api": True,
        "supported_reasoning_levels": [
            {"description": "Fast responses with lighter reasoning", "effort": level}
            for level in reasoning
        ],
        "supports_image_detail_original": False,
        "supports_parallel_tool_calls": False,
        "supports_reasoning_summaries": True,
        "supports_search_tool": False,
        "truncation_policy": {"limit": 10000, "mode": "bytes"},
        "upgrade": None,
        "visibility": "list",
    }
    return entry


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 个模型；首次验证建议使用 3")
    parser.add_argument("--dry-run", action="store_true", help="只打印结果，不写入目标文件")
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit 必须是非负整数")

    remote = fetch_models(args.source)
    if args.limit:
        remote = remote[:args.limit]
    metadata = load_json(CAPABILITIES, {})
    current = load_json(args.output, {"models": []})
    existing_models = current.get("models", []) if isinstance(current, dict) else []
    existing = {m.get("slug"): m for m in existing_models if isinstance(m, dict) and m.get("slug")}
    generated = [catalog_entry(model, existing, metadata) for model in remote]
    output = {"models": generated}

    print(f"source={args.source}")
    print(f"models={len(generated)}")
    print("slugs=" + ",".join(item["slug"] for item in generated))
    if args.dry_run:
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=args.output.name + ".", suffix=".tmp", dir=args.output.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(output, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, args.output)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    print(f"written={args.output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
