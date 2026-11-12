#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export RUSTUP_HOME="$ROOT/.tools/rustup"
export CARGO_HOME="$ROOT/.cache/cargo"
export RUSTUP_TOOLCHAIN=1.99.1
export CARGO_TARGET_DIR="$ROOT/target"
for manifest in crates/collateral-proof/Cargo.toml crates/proof-protocol/Cargo.toml workers/collateral-proof/Cargo.toml contracts/controller/Cargo.toml; do
    cargo fmt --manifest-path "$manifest" -- --check
    cargo test --manifest-path "$manifest" --locked --offline
    cargo clippy --manifest-path "$manifest" --locked --offline --all-targets -- -D warnings
done
cargo fmt --manifest-path tests/proof-pipeline/Cargo.toml -- --check
CARGO_TARGET_DIR="$ROOT/target/proof-pipeline-native" cargo clippy --manifest-path tests/proof-pipeline/Cargo.toml --locked --offline --all-targets -- -D warnings
cargo fmt --manifest-path tests/proof-pipeline/contracts/services/Cargo.toml -- --check
RUSTFLAGS='--cfg near' cargo clippy --manifest-path tests/proof-pipeline/contracts/services/Cargo.toml --target wasm32-unknown-unknown --locked --offline -- -D warnings
cargo clippy --manifest-path workers/collateral-proof/Cargo.toml --locked --offline --target wasm32-wasip2 --all-targets -- -D warnings
python3 scripts/verify_superpowers.py
./tooling/check-proof-pipeline.sh
