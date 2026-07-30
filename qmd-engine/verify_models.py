#!/usr/bin/env python3
"""Verify QMD model files against the public immutable model lock."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "models.lock.json"
MODELS_DIR = Path(
    os.environ.get("QMD_MODELS_DIR", str(Path.home() / ".qmd" / "models"))
).expanduser()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify() -> dict:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    results = []
    for model in lock.get("models", []):
        filename = model.get("filename", "")
        file = MODELS_DIR / filename
        result = {"name": model.get("name", filename), "filename": filename}
        if not file.is_file():
            result.update(ok=False, status="missing")
        elif file.stat().st_size != model.get("size"):
            result.update(ok=False, status="size_mismatch")
        elif sha256(file) != model.get("sha256"):
            result.update(ok=False, status="sha256_mismatch")
        else:
            result.update(ok=True, status="verified")
        results.append(result)
    return {
        "ok": bool(results) and all(item["ok"] for item in results),
        "models": results,
    }


def main() -> int:
    report = verify()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
