#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/tooling/proof-artifact-env.sh"
STAGE="$(python3 "$ROOT/tooling/prepare-proof-artifact.py" worker)"
export CARGO_ENCODED_RUSTFLAGS+=$'\x1f'"--remap-path-prefix=$STAGE=/rino"
cargo build --manifest-path "$STAGE/Cargo.toml" --package rino-proof-worker --locked --offline --target wasm32-wasip2 --release
python3 "$ROOT/tooling/prepare-proof-artifact.py" worker --verify
python3 - <<'PY'
from pathlib import Path
import hashlib,json,os,subprocess
root=Path.cwd()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def command(*args):return subprocess.check_output(args,text=True).strip()
artifact=root/'target/wasm32-wasip2/release/rino-proof-worker.wasm'
sources=[]
for directory in ['workers/collateral-proof','crates/proof-protocol','crates/collateral-proof']:
 for p in sorted((root/directory).rglob('*')):
  if p.is_file() and (p.suffix in ['.rs','.toml','.md'] or p.name=='Cargo.lock'):
   sources.append(p)
sources.extend([root/'tooling/build-proof-worker.sh',root/'tooling/proof-artifact-env.sh',root/'tooling/prepare-proof-artifact.py'])
revision=command('git','rev-parse','HEAD') if (root/'.git').exists() else None
status=command('git','status','--porcelain') if revision is not None else None
manifest={
 'schema_version':1,
 'artifact':str(artifact.relative_to(root)), 'artifact_bytes':artifact.stat().st_size,'artifact_sha256':sha(artifact),
 'source_base_revision':revision,
 'source_tree_dirty':None if status is None else bool(status),
 'source_revision_note':'Base revision only when this source root has Git metadata; null means unavailable. Exact per-file SHA-256 hashes identify the build inputs, including copied source-only trees.',
 'source_files_sha256':{str(p.relative_to(root)):sha(p) for p in sources},
 'lockfile':'workers/collateral-proof/Cargo.lock','lockfile_sha256':sha(root/'workers/collateral-proof/Cargo.lock'),
 'rustc':command('rustc','-vV'),'cargo':command('cargo','--version'),
 'toolchain':'1.99.1','target':'wasm32-wasip2',
 'build_command':'./tooling/build-proof-worker.sh (environment and exact rustc flags recorded below)',
 'rustc_flags':os.environ['CARGO_ENCODED_RUSTFLAGS'].split('\x1f'),
 'stable_path_mapping':{'checkout_root':'/rino','canonical_cargo_home':'/cargo-home','build_source_stage':'/rino','precedence':'last matching prefix wins; stage mapping last'},
 'build_source_preparation':'python3 tooling/prepare-proof-artifact.py worker; minimal ignored build-only workspace with original source files and unchanged package lockfile',
 'build_source_derivation':json.loads((root/'.cache/proof-artifact-sources/worker/derivation.json').read_text()),
 'cargo_command':['cargo','build','--manifest-path','.cache/proof-artifact-sources/worker/Cargo.toml','--package','rino-proof-worker','--locked','--offline','--target','wasm32-wasip2','--release'],
 'reproduce':'./tooling/build-proof-worker.sh',
 'wasi_bindings':'0.13.3+wasi-0.2.2',
 'providers':[{'id':'publicnode','url':'https://ethereum-sepolia-rpc.publicnode.com'},{'id':'alchemy','url':'https://eth-sepolia.g.alchemy.com'}],
 'runtime_credentials':{'environment_key':'ALCHEMY_API_KEY','path_template':'/v2/<key>','key_shape':'8-128 ASCII letters/digits/underscore/hyphen','secret_in_manifest':False},
 'execution_claim':'Compiled WASI component only; no OutLayer or hardware-attested execution claimed.'
}
output=root/'target/proof-worker-manifest.json'
output.write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'artifact':manifest['artifact'],'bytes':manifest['artifact_bytes'],'sha256':manifest['artifact_sha256'],'manifest':str(output.relative_to(root))},indent=2))
PY
