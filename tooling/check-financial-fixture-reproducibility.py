#!/usr/bin/env python3
"""Compare actual local financial mock bytes from two independent source paths."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tests/financial-flow/contracts/services"
BASE = ROOT / ".cache/financial-mock-reproducibility"
BASE.mkdir(parents=True, exist_ok=True)
WORK = Path(tempfile.mkdtemp(prefix="check-", dir=BASE))
FILES = ["Cargo.toml", "Cargo.lock", "src/lib.rs"]
sha = lambda data: hashlib.sha256(data).hexdigest()
snapshot = {name: (SOURCE / name).read_bytes() for name in FILES}
records = []
for location in ["source-a", "a-different-directory/source-b"]:
    stage = WORK / location
    stage.mkdir(parents=True)
    for name, data in snapshot.items():
        (stage / name).parent.mkdir(parents=True, exist_ok=True)
        (stage / name).write_bytes(data)
    env = os.environ.copy()
    env.update(RUSTUP_HOME=str(ROOT / ".tools/rustup"), CARGO_HOME=str(ROOT / ".cache/cargo"),
               RUSTUP_TOOLCHAIN="1.99.1", CARGO_TARGET_DIR=str(stage / "target"))
    cargo = ROOT / ".tools/rustup/toolchains/1.99.1-aarch64-apple-darwin/bin/cargo"
    env["PATH"] = str(cargo.parent) + os.pathsep + env["PATH"]
    flags = [f"--remap-path-prefix={ROOT}=/rino",
             f"--remap-path-prefix={env['CARGO_HOME']}=/cargo-home", "--cfg", "near",
             f"--remap-path-prefix={stage}=/rino/tests/financial-flow/contracts/services"]
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(flags)
    env.pop("RUSTFLAGS", None)
    command = [str(cargo), "build", "--manifest-path", str(stage / "Cargo.toml"),
               "--target", "wasm32-unknown-unknown", "--release", "--locked", "--offline"]
    subprocess.run(command, cwd=ROOT, env=env, check=True)
    artifact = stage / "target/wasm32-unknown-unknown/release/rino_financial_services.wasm"
    data = artifact.read_bytes()
    records.append({"source": str(stage), "artifact": str(artifact), "bytes": len(data),
                    "sha256": sha(data), "flags": flags, "command": command})
canonical = ROOT / "target/financial-services/wasm32-unknown-unknown/release/rino_financial_services.wasm"
actual = canonical.read_bytes()
result = {"status": "PASS" if records[0]["sha256"] == records[1]["sha256"] == sha(actual) else "FAIL",
          "sources": {name: sha(data) for name, data in snapshot.items()}, "builds": records,
          "canonical": {"artifact": str(canonical), "bytes": len(actual), "sha256": sha(actual)},
          "scope": "macOS ARM64; Rust1.99.1; local mock only; no production-service equivalence"}
(WORK / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
raise SystemExit(0 if result["status"] == "PASS" else 1)
