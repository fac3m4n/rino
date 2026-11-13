#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
source tooling/local-env.sh
MODE="${1:---all}"
if [[ "$MODE" != --all && "$MODE" != --unit-build ]]; then
    echo 'Usage: tooling/check.sh [--all|--unit-build]' >&2
    exit 2
fi
for manifest in crates/collateral-proof/Cargo.toml crates/proof-protocol/Cargo.toml crates/loan-core/Cargo.toml crates/settlement-protocol/Cargo.toml workers/collateral-proof/Cargo.toml workers/settlement/Cargo.toml contracts/controller/Cargo.toml; do
    cargo fmt --manifest-path "$manifest" -- --check
    cargo test --manifest-path "$manifest" --locked --offline
    cargo clippy --manifest-path "$manifest" --locked --offline --all-targets -- -D warnings
done
for manifest in tests/proof-pipeline/Cargo.toml tests/proof-pipeline/contracts/services/Cargo.toml tests/financial-flow/Cargo.toml tests/financial-flow/contracts/services/Cargo.toml tests/worker-host/Cargo.toml; do
    cargo fmt --manifest-path "$manifest" -- --check
done
CARGO_TARGET_DIR="$ROOT/target/proof-pipeline-native" cargo clippy --manifest-path tests/proof-pipeline/Cargo.toml --locked --offline --all-targets -- -D warnings
CARGO_TARGET_DIR="$ROOT/target/financial-flow-native" cargo clippy --manifest-path tests/financial-flow/Cargo.toml --locked --offline --all-targets -- -D warnings
for manifest in tests/proof-pipeline/contracts/services/Cargo.toml tests/financial-flow/contracts/services/Cargo.toml; do
    RUSTFLAGS='--cfg near' cargo clippy --manifest-path "$manifest" --target wasm32-unknown-unknown --locked --offline -- -D warnings
done
for manifest in workers/collateral-proof/Cargo.toml workers/settlement/Cargo.toml; do
    cargo clippy --manifest-path "$manifest" --locked --offline --target wasm32-wasip2 --all-targets -- -D warnings
done
RUSTFLAGS='--cfg near' cargo clippy --manifest-path contracts/controller/Cargo.toml --locked --offline --target wasm32-unknown-unknown -- -D warnings
CARGO_TARGET_DIR="$ROOT/target/worker-host-native" cargo clippy --manifest-path tests/worker-host/Cargo.toml --locked --offline --all-targets --all-features -- -D warnings
npm test
npm run test:web
npm run build
./node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types node --allowImportingTsExtensions tests/browser/*.ts
./node_modules/.bin/prettier --check apps/web/src apps/web/tests apps/web/vite.config.ts apps/web/tsconfig.json tests/browser services/coordinator/src services/coordinator/tests
./tooling/build-proof-worker.sh
./tooling/build-settlement-worker.sh
./tooling/build-proof-contracts.sh
./tooling/build-financial-fixtures.sh
CARGO_TARGET_DIR="$ROOT/target/worker-host-native" cargo build --manifest-path tests/worker-host/Cargo.toml --locked --offline
if [[ "$MODE" == --all ]]; then
    ./tooling/check-worker-host.sh
    ./tooling/check-proof-pipeline.sh
    ./tooling/check-financial-flow.sh
    python3 tooling/check-proof-artifact-reproducibility.py
    python3 tooling/check-artifact-negative-gates.py
    env -u NO_COLOR npm run test:browser
fi
