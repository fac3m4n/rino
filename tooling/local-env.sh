#!/usr/bin/env bash
# Source from the checkout root. Never install or change global configuration.
if [[ -n "${ZSH_VERSION:-}" ]]; then
    RINO_ENV_PATH="${(%):-%x}"
else
    RINO_ENV_PATH="${BASH_SOURCE[0]}"
fi
RINO_ROOT="$(cd "$(dirname "$RINO_ENV_PATH")/.." && pwd -P)"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
    echo 'Verified platform is macOS ARM64 only; review platform artifacts before porting.' >&2
    return 1 2>/dev/null || exit 1
fi
export RUSTUP_HOME="$RINO_ROOT/.tools/rustup"
export CARGO_HOME="$RINO_ROOT/.cache/cargo"
export RUSTUP_TOOLCHAIN=1.99.1
export CARGO_TARGET_DIR="$RINO_ROOT/target"
export PATH="$RUSTUP_HOME/toolchains/1.99.1-aarch64-apple-darwin/bin:$PATH"
export npm_config_cache="$RINO_ROOT/.cache/npm"
export PLAYWRIGHT_BROWSERS_PATH="$RINO_ROOT/.cache/playwright"
export NEAR_SANDBOX_BIN_PATH="$RINO_ROOT/.tools/near-sandbox/2.14.0/near-sandbox"
export TMPDIR="$RINO_ROOT/.cache/sandbox/tmp"
export PYTHONPYCACHEPREFIX="$RINO_ROOT/.cache/python"
export SUPERPOWERS_DISABLE_TELEMETRY=1
mkdir -p "$CARGO_HOME" "$TMPDIR" "$npm_config_cache"
