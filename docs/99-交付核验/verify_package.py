#!/usr/bin/env python3
"""Verify this extracted document package; does not run historical application tests."""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path, PurePosixPath


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    manifest_path = root / "99-交付核验" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entries = manifest["files"]
        expected = set()
        failures = []
        for entry in entries:
            name = entry["path"]
            rel = PurePosixPath(name)
            if rel.is_absolute() or ".." in rel.parts or "\\" in name:
                failures.append(f"unsafe relative path: {name}")
                continue
            if name in expected:
                failures.append(f"duplicate manifest entry: {name}")
                continue
            expected.add(name)
            path = root.joinpath(*rel.parts)
            if path.is_symlink() or not path.is_file():
                failures.append(f"missing or symbolic file: {name}")
                continue
            if root not in path.resolve().parents:
                failures.append(f"path leaves package: {name}")
                continue
            content = path.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
            if len(content) != entry["bytes"] or digest != entry["sha256"]:
                failures.append(f"size/hash mismatch: {name}")
        exclusions = set(manifest["exclusions"])
        actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
        unexpected = actual - expected - exclusions
        for name in sorted(unexpected):
            failures.append(f"unexpected file: {name}")
        if failures:
            print("FAIL")
            for failure in failures:
                print(f"- {failure}")
            return 1
        print(f"PASS: {len(entries)} file hashes and sizes match; no unexpected files.")
        print("Scope: archive/document integrity only; no application or integration tests.")
        print("SHA-256 detects changes against this manifest; it is not a signed authenticity proof.")
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"FAIL: cannot validate package: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
