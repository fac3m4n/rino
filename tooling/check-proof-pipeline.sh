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
 'target/wasm32-unknown-unknown/release/rino_controller.wasm': 'fca67033f7ab648c105e28063797d9c07a317e487e626cb040fc089af46e0779',
 'target/wasm32-wasip2/release/rino-proof-worker.wasm': '3828a8e08162e4dd28a4e69981a29fc2ba2412a91735b62e5e4b00c642be5eec',
 'target/wasm32-unknown-unknown/release/rino_pipeline_services.wasm': 'bee5dd8aa0c4db4218cfc8ac87b0fc566c8a533a820d1927521e76f911b48b0e',
 '.tools/near-sandbox/2.14.0/near-sandbox': '8e0e1521372b0fce801b7464078c1e95e5a25a0f92ad4b4241451c33fe9e5a2a',
}
for name, expected in pins.items():
    actual = hashlib.sha256(Path(name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f'Pinned artifact mismatch: {name}: {actual}; rebuild securely or review intentional pin changes')
PIN
CARGO_TARGET_DIR="$ROOT/target/proof-pipeline-native" cargo test --manifest-path tests/proof-pipeline/Cargo.toml --locked --offline -- --nocapture --test-threads=1
