#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/tooling/proof-artifact-env.sh"
BASE_FLAGS="$CARGO_ENCODED_RUSTFLAGS"$'\x1f'"--cfg"$'\x1f'"near"
for kind in controller services; do
    STAGE="$(python3 "$ROOT/tooling/prepare-proof-artifact.py" "$kind")"
    export CARGO_ENCODED_RUSTFLAGS="$BASE_FLAGS"$'\x1f'"--remap-path-prefix=$STAGE=/proofcredit"
    if [[ "$kind" == controller ]]; then
        PACKAGE=proofcredit-controller
    else
        PACKAGE=proofcredit-pipeline-services
    fi
    cargo build --manifest-path "$STAGE/Cargo.toml" --package "$PACKAGE" --target wasm32-unknown-unknown --release --locked --offline
    python3 "$ROOT/tooling/prepare-proof-artifact.py" "$kind" --verify
done
