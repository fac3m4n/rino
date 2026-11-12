#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export npm_config_cache="$ROOT/.cache/npm"
export RUSTUP_HOME="$ROOT/.tools/rustup"
export CARGO_HOME="$ROOT/.cache/cargo"
export RUSTUP_TOOLCHAIN=1.99.1
export PATH="$RUSTUP_HOME/toolchains/1.99.1-aarch64-apple-darwin/bin:$PATH"
export TMPDIR="$ROOT/.cache/sandbox/tmp"
mkdir -p "$TMPDIR"
./tooling/build-financial-fixtures.sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run services/coordinator/tests
cargo fmt --manifest-path tests/financial-flow/Cargo.toml -- --check
cargo fmt --manifest-path tests/financial-flow/contracts/services/Cargo.toml -- --check
CARGO_TARGET_DIR="$ROOT/target/financial-flow-native" cargo clippy --manifest-path tests/financial-flow/Cargo.toml --offline --locked --all-targets -- -D warnings
for scenario in smoke scenarios faults pending zero-cancel; do
    ./node_modules/.bin/tsx "tests/financial-flow/$scenario.ts"
done
MAX_WIRE=1 ./node_modules/.bin/tsx tests/financial-flow/aliases.ts
RECOVER_ALIAS=1 ./node_modules/.bin/tsx tests/financial-flow/aliases.ts
./node_modules/.bin/tsx tests/financial-flow/lifecycle.ts
./node_modules/.bin/tsx tests/financial-flow/startup-signals.ts
python3 tooling/check-financial-fixture-reproducibility.py
