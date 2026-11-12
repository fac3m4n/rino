#!/usr/bin/env python3
"""Run the actual tracked pin blocks against isolated full artifact copies."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PATHS = [
    "target/wasm32-unknown-unknown/release/proofcredit_controller.wasm",
    "target/wasm32-wasip2/release/proofcredit-proof-worker.wasm",
    "target/wasm32-unknown-unknown/release/proofcredit_pipeline_services.wasm",
    ".tools/near-sandbox/2.14.0/near-sandbox",
    "target/wasm32-wasip2/release/proofcredit-settlement-worker.wasm",
]


def main():
    legacy = (ROOT / "tooling/check-proof-pipeline.sh").read_text().split(
        "python3 - <<'PIN'\n", 1
    )[1].split("\nPIN\n", 1)[0]
    host = (ROOT / "tooling/check-worker-host.sh").read_text().split(
        'python3 - "$ROOT" <<\'PY\'\n', 1
    )[1].split("\nPY\n", 1)[0]
    scratch = ROOT / ".cache/artifact-gate-check"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="actual-blocks-", dir=scratch) as directory:
        base = Path(directory)
        for name in PATHS:
            path = base / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, path)

        def run(kind, modified=None):
            body = legacy if kind == "legacy" else host
            args = [sys.executable, "-c", body]
            if kind == "host":
                args.append(str(base))
            result = subprocess.run(
                args, cwd=base, text=True, capture_output=True, timeout=30
            )
            if modified is None:
                assert result.returncode == 0, (kind, result.stderr)
            else:
                assert result.returncode != 0 and (
                    modified in result.stderr
                    or "canonical guest bytes differ" in result.stderr
                ), (kind, modified, result.returncode, result.stderr)
            return {
                "gate": kind,
                "case": "baseline" if modified is None else "one-bit:" + modified,
                "exit": result.returncode,
                "passed": True,
            }

        checks = [run("legacy"), run("host")]
        for kind, names in [("legacy", PATHS[:4]), ("host", [PATHS[1], PATHS[4]])]:
            for name in names:
                path = base / name
                offset = path.stat().st_size // 2
                with path.open("r+b") as stream:
                    stream.seek(offset)
                    old = stream.read(1)
                    stream.seek(offset)
                    stream.write(bytes([old[0] ^ 1]))
                checks.append(run(kind, name))
                with path.open("r+b") as stream:
                    stream.seek(offset)
                    stream.write(old)
        for name in PATHS:
            assert hashlib.sha256((base / name).read_bytes()).digest() == hashlib.sha256(
                (ROOT / name).read_bytes()
            ).digest()
        result = {
            "method": "Unmodified Python pin blocks extracted from tracked shell scripts; executed on isolated full artifact copies. Root artifacts never mutated.",
            "pin_block_sha256": {
                "legacy": hashlib.sha256(legacy.encode()).hexdigest(),
                "host": hashlib.sha256(host.encode()).hexdigest(),
            },
            "checks": checks,
            "source_artifacts_unchanged": True,
        }
        (scratch / "results.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"passed": len(checks), "failed": 0, "source_artifacts_unchanged": True}))


if __name__ == "__main__":
    main()
