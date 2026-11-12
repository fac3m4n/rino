#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export RUSTUP_HOME="$ROOT/.tools/rustup"
export CARGO_HOME="$ROOT/.cache/cargo"
export RUSTUP_TOOLCHAIN=1.99.1
export CARGO_TARGET_DIR="$ROOT/target"
export NEAR_SANDBOX_BIN_PATH="$ROOT/.tools/near-sandbox/2.14.0/near-sandbox"
export TMPDIR="$ROOT/.cache/sandbox/tmp"
mkdir -p "$TMPDIR" "$ROOT/.cache/proof-pipeline"
# Dependencies and the pinned binary/toolchain must already be cached locally.
# No installer, public account, global configuration or public RPC is used here.
./tooling/build-proof-worker.sh
./tooling/build-proof-contracts.sh
python3 - <<'PIN'
from pathlib import Path
import hashlib
pins = {
 'target/wasm32-unknown-unknown/release/proofcredit_controller.wasm': '0f4b582d1c1240fbbfe5617daf2431501b9c1b1bd089612f512b786b5ea7b2b4',
 'target/wasm32-wasip2/release/proofcredit-proof-worker.wasm': 'be818d821f076d5e1dbf3650b03811b7658c85b14fd5c2fa7abce4ac87184c69',
 'target/wasm32-unknown-unknown/release/proofcredit_pipeline_services.wasm': 'f9cdcc14eb15f7f77849f8be95e0e058bca0cd986a6831f94747e2c5157a7c2a',
 '.tools/near-sandbox/2.14.0/near-sandbox': '8e0e1521372b0fce801b7464078c1e95e5a25a0f92ad4b4241451c33fe9e5a2a',
}
for name, expected in pins.items():
    actual = hashlib.sha256(Path(name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f'Pinned artifact mismatch: {name}: {actual}; rebuild securely or review intentional pin changes')
PIN
CARGO_TARGET_DIR="$ROOT/target/proof-pipeline-native" cargo test --manifest-path tests/proof-pipeline/Cargo.toml --locked --offline -- --nocapture --test-threads=1
