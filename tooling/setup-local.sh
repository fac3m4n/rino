#!/usr/bin/env bash
# macOS ARM64; --download fills only repository-local tools/caches.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
source tooling/local-env.sh
MODE="${1:---cached}"
if [[ "$MODE" != --cached && "$MODE" != --download ]]; then
    echo 'Usage: tooling/setup-local.sh [--cached|--download]' >&2
    exit 2
fi
[[ "$(node --version)" == v24.19.0 ]] || { echo 'Node v24.19.0 required' >&2; exit 1; }
[[ "$(npm --version)" == 12.2.2 ]] || { echo 'npm 12.2.2 required' >&2; exit 1; }
if [[ "$MODE" == --download ]]; then
    command -v rustup >/dev/null
    rustup toolchain install 1.99.1 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown --target wasm32-wasip2 --no-self-update
    for manifest in crates/collateral-proof/Cargo.toml crates/proof-protocol/Cargo.toml crates/loan-core/Cargo.toml crates/settlement-protocol/Cargo.toml workers/collateral-proof/Cargo.toml workers/settlement/Cargo.toml contracts/controller/Cargo.toml tests/proof-pipeline/Cargo.toml tests/proof-pipeline/contracts/services/Cargo.toml tests/financial-flow/Cargo.toml tests/financial-flow/contracts/services/Cargo.toml tests/worker-host/Cargo.toml; do
        cargo fetch --manifest-path "$manifest" --locked
    done
    python3 tooling/install-local-binaries.py
    npm ci --ignore-scripts --cache "$npm_config_cache"
    ./node_modules/.bin/playwright install chromium
else
    npm ci --ignore-scripts --offline --cache "$npm_config_cache"
fi
[[ "$(rustc --version)" == 'rustc 1.99.1 '* ]] || { echo 'Rust 1.99.1 required' >&2; exit 1; }
for target in wasm32-unknown-unknown wasm32-wasip2; do
    [[ -d "$RUSTUP_HOME/toolchains/1.99.1-aarch64-apple-darwin/lib/rustlib/$target/lib" ]]
done
python3 tooling/install-local-binaries.py --verify-only
node --input-type=module -e 'import { chromium } from "playwright"; import { access } from "node:fs/promises"; await access(chromium.executablePath()); console.log("Pinned Chromium cached:", chromium.executablePath());'
printf 'Cached setup verified. Run ./tooling/check.sh --unit-build, then npm run dev:local.\n'
