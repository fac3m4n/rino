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
for name,expected in [('proofcredit-proof-worker','fbd5e0664aa18b3fe11f07d383cfbb73ef9eeff9d7747f623b33f09c4570f96e'),('proofcredit-settlement-worker','a0efb7959a1f227d7e81579820bf3b3cec9804d94e5095fa6a90b301052e19c7')]:
    actual=hashlib.sha256((root/'target/wasm32-wasip2/release'/f'{name}.wasm').read_bytes()).hexdigest()
    print(f'{name} sha256={actual}')
    if actual != expected: raise SystemExit('canonical guest bytes differ from reviewed Alchemy worker fixtures')
PY
