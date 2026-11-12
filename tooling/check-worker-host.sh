#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
export RUSTUP_HOME="$ROOT/.tools/rustup"
export CARGO_HOME="$ROOT/.cache/cargo"
export RUSTUP_TOOLCHAIN=1.99.1
export CARGO_TARGET_DIR="$ROOT/target/worker-host-native"
CARGO="$RUSTUP_HOME/toolchains/1.99.1-aarch64-apple-darwin/bin/cargo"
MANIFEST="$ROOT/tests/worker-host/Cargo.toml"
for artifact in proofcredit-proof-worker proofcredit-settlement-worker; do
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
for name,expected in [('proofcredit-proof-worker','be818d821f076d5e1dbf3650b03811b7658c85b14fd5c2fa7abce4ac87184c69'),('proofcredit-settlement-worker','986b205eb5287e20ceb0a43db918607402fc524bd056126437ae441c5f07cb6a')]:
    actual=hashlib.sha256((root/'target/wasm32-wasip2/release'/f'{name}.wasm').read_bytes()).hexdigest()
    print(f'{name} sha256={actual}')
    if actual != expected: raise SystemExit('canonical guest bytes differ from reviewed Task4 fixtures')
PY
