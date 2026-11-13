#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
export RUSTUP_HOME="$ROOT/.tools/rustup"
export CARGO_HOME="$ROOT/.cache/cargo"
export RUSTUP_TOOLCHAIN=1.99.1
export CARGO_TARGET_DIR="$ROOT/target/worker-host-native"
CARGO="$RUSTUP_HOME/toolchains/1.99.1-aarch64-apple-darwin/bin/cargo"
MANIFEST="$ROOT/tests/worker-host/Cargo.toml"
for artifact in rino-proof-worker rino-settlement-worker; do
  if [[ ! -f "$ROOT/target/wasm32-wasip2/release/$artifact.wasm" ]]; then
    echo "Missing canonical $artifact.wasm; run its tooling/build-*-worker.sh first" >&2
    exit 1
  fi
done
"$CARGO" fmt --manifest-path "$MANIFEST" -- --check
"$CARGO" clippy --manifest-path "$MANIFEST" --locked --offline --all-targets --all-features -- -D warnings
"$CARGO" test --manifest-path "$MANIFEST" --locked --offline --features test-hooks -- --nocapture
"$CARGO" build --manifest-path "$MANIFEST" --locked --offline
python3 - "$ROOT" <<'PY'
import hashlib, pathlib, sys
root=pathlib.Path(sys.argv[1])
for name,expected in [('rino-proof-worker','3828a8e08162e4dd28a4e69981a29fc2ba2412a91735b62e5e4b00c642be5eec'),('rino-settlement-worker','11a8f330d8f6698c9e644230d37e86ebb7c985d77a697b05934a0bf482404758')]:
    actual=hashlib.sha256((root/'target/wasm32-wasip2/release'/f'{name}.wasm').read_bytes()).hexdigest()
    print(f'{name} sha256={actual}')
    if actual != expected: raise SystemExit('canonical guest bytes differ from reviewed Alchemy worker fixtures')
PY
