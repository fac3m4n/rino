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
RUSTFLAGS='--cfg near' cargo build --manifest-path contracts/controller/Cargo.toml --target wasm32-unknown-unknown --release --locked --offline
RUSTFLAGS='--cfg near' cargo build --manifest-path tests/proof-pipeline/contracts/services/Cargo.toml --target wasm32-unknown-unknown --release --locked --offline
python3 - <<'PIN'
from pathlib import Path
import hashlib
pins = {
 'target/wasm32-unknown-unknown/release/proofcredit_controller.wasm': '3ac0e62e263a4e2c3f41e3c83f2cef00908d5121dc51ec12779fdf0b17c405a5',
 'target/wasm32-wasip2/release/proofcredit-proof-worker.wasm': '2b4e8582fe62cdedee47718a5cbe186406bcba96c1c0a51290fb57cc2e2d2efa',
 '.tools/near-sandbox/2.14.0/near-sandbox': '8e0e1521372b0fce801b7464078c1e95e5a25a0f92ad4b4241451c33fe9e5a2a',
}
for name, expected in pins.items():
    actual = hashlib.sha256(Path(name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f'Pinned artifact mismatch: {name}: {actual}; rebuild securely or review intentional pin changes')
PIN
CARGO_TARGET_DIR="$ROOT/target/proof-pipeline-native" cargo test --manifest-path tests/proof-pipeline/Cargo.toml --locked --offline -- --nocapture --test-threads=1
