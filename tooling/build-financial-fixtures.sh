#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source tooling/proof-artifact-env.sh
export CARGO_TARGET_DIR="$ROOT/target/financial-flow-native"
cargo build --manifest-path tests/financial-flow/Cargo.toml --locked --offline
export CARGO_TARGET_DIR="$ROOT/target/financial-services"
export CARGO_ENCODED_RUSTFLAGS="$CARGO_ENCODED_RUSTFLAGS"$'\x1f'"--cfg"$'\x1f'"near"
cargo build --manifest-path tests/financial-flow/contracts/services/Cargo.toml --target wasm32-unknown-unknown --release --locked --offline
