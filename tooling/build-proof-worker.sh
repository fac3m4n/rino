#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export RUSTUP_HOME="$ROOT/.tools/rustup"
export CARGO_HOME="$ROOT/.cache/cargo"
export RUSTUP_TOOLCHAIN=1.99.1
export CARGO_TARGET_DIR="$ROOT/target"
# Reuse the approved project-local toolchain. Never install or modify user settings.
cargo build --manifest-path workers/collateral-proof/Cargo.toml --locked --offline --target wasm32-wasip2 --release
python3 - <<'PY'
from pathlib import Path
import hashlib,json,subprocess
root=Path.cwd()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def command(*args):return subprocess.check_output(args,text=True).strip()
artifact=root/'target/wasm32-wasip2/release/proofcredit-proof-worker.wasm'
sources=[]
for directory in ['workers/collateral-proof','crates/proof-protocol','crates/collateral-proof']:
 for p in sorted((root/directory).rglob('*')):
  if p.is_file() and (p.suffix in ['.rs','.toml','.md'] or p.name=='Cargo.lock'):
   sources.append(p)
sources.append(root/'tooling/build-proof-worker.sh')
manifest={
 'schema_version':1,
 'artifact':str(artifact.relative_to(root)), 'artifact_bytes':artifact.stat().st_size,'artifact_sha256':sha(artifact),
 'source_base_revision':command('git','rev-parse','HEAD'),
 'source_tree_dirty':bool(command('git','status','--porcelain')),
 'source_revision_note':'Base revision only; uncommitted worker code is identified by the per-file SHA-256 hashes below.',
 'source_files_sha256':{str(p.relative_to(root)):sha(p) for p in sources},
 'lockfile':'workers/collateral-proof/Cargo.lock','lockfile_sha256':sha(root/'workers/collateral-proof/Cargo.lock'),
 'rustc':command('rustc','-vV'),'cargo':command('cargo','--version'),
 'toolchain':'1.99.1','target':'wasm32-wasip2',
 'build_command':'RUSTUP_HOME="$PWD/.tools/rustup" CARGO_HOME="$PWD/.cache/cargo" RUSTUP_TOOLCHAIN=1.99.1 CARGO_TARGET_DIR="$PWD/target" cargo build --manifest-path workers/collateral-proof/Cargo.toml --locked --offline --target wasm32-wasip2 --release',
 'reproduce':'./tooling/build-proof-worker.sh',
 'wasi_bindings':'0.13.3+wasi-0.2.2',
 'providers':[{'id':'publicnode','url':'https://ethereum-sepolia-rpc.publicnode.com'},{'id':'automata','url':'https://public.1rpc.io/sepolia'}],
 'execution_claim':'Compiled WASI component only; no OutLayer or hardware-attested execution claimed.'
}
output=root/'target/proof-worker-manifest.json'
output.write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'artifact':manifest['artifact'],'bytes':manifest['artifact_bytes'],'sha256':manifest['artifact_sha256'],'manifest':str(output.relative_to(root))},indent=2))
PY
