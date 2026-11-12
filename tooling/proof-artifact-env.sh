#!/usr/bin/env bash
# Source only from artifact build scripts after setting ROOT. Cargo's encoded
# flags preserve paths containing spaces. Do not inherit caller-selected flags.
export RUSTUP_HOME="$(cd "$ROOT/.tools/rustup" && pwd -P)"
export CARGO_HOME="$(cd "$ROOT/.cache/cargo" && pwd -P)"
export RUSTUP_TOOLCHAIN=1.99.1
export CARGO_TARGET_DIR="$ROOT/target"
# rustc applies the LAST matching prefix: keep the narrower cache rule last.
# Canonicalize the cache so an explicitly shared repo-local cache maps identically.
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$ROOT=/proofcredit"$'\x1f'"--remap-path-prefix=$CARGO_HOME=/cargo-home"
unset RUSTFLAGS
