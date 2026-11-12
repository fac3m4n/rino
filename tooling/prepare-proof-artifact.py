#!/usr/bin/env python3
"""Stage a build-only workspace, keeping standalone package lockfiles unchanged.

Cargo hashes out-of-workspace path dependencies using absolute paths (#7645).
Containing those dependencies in this disposable workspace normalizes identity;
rustc remapping separately normalizes source paths. No repository manifest moves.
"""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = {
    'worker': ['workers/collateral-proof', 'crates/proof-protocol', 'crates/collateral-proof'],
    'controller': ['contracts/controller', 'crates/proof-protocol', 'crates/collateral-proof'],
    'services': ['tests/proof-pipeline/contracts/services'],
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    kind = sys.argv[1]
    members = PACKAGES[kind]
    stage = ROOT / '.cache/proof-artifact-sources' / kind
    if '--verify' in sys.argv:
        evidence = json.loads((stage / 'derivation.json').read_text())
        for source, expected in evidence['source_files_sha256'].items():
            if not sha(ROOT / source) == expected == sha(stage / source):
                raise SystemExit('Staged source mismatch: ' + source)
        if not sha(stage / 'Cargo.lock') == sha(ROOT / members[0] / 'Cargo.lock') == evidence['lockfile_sha256']:
            raise SystemExit('Staged lockfile mismatch')
        if sha(stage / 'Cargo.toml') != evidence['workspace_manifest_sha256']:
            raise SystemExit('Generated workspace manifest mismatch')
        evidence['rustc_flags'] = os.environ['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')
        (stage / 'derivation.json').write_text(json.dumps(evidence, indent=2) + '\n')
        return
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    for member in members:
        shutil.copytree(ROOT / member, stage / member,
                        ignore=shutil.ignore_patterns('target', '__pycache__'))
    original = (ROOT / members[0] / 'Cargo.toml').read_text()
    edition = re.search(r'^edition\s*=\s*"(2021|2024)"', original, re.M)
    if not edition:
        raise SystemExit('Unsupported edition: review resolver explicitly')
    resolver = '3' if edition.group(1) == '2024' else '2'
    manifest = f'[workspace]\nmembers = {json.dumps(members[:1])}\nexclude = {json.dumps(members[1:])}\nresolver = "{resolver}"\n'
    # Copy complete profile tables verbatim; member profiles are ignored by Cargo.
    manifest += '\n'.join(re.findall(r'(?ms)^\[profile\.[^\n]+\]\n.*?(?=^\[|\Z)', original))
    (stage / 'Cargo.toml').write_text(manifest)
    shutil.copyfile(ROOT / members[0] / 'Cargo.lock', stage / 'Cargo.lock')
    sources = {str(p.relative_to(ROOT)): sha(p)
               for member in members for p in sorted((ROOT / member).rglob('*'))
               if p.is_file() and 'target' not in p.relative_to(ROOT / member).parts}
    evidence = {'schema_version': 1, 'source_packages': members, 'workspace_members': members[:1], 'excluded_path_dependencies': members[1:], 'resolver': resolver,
                'source_files_sha256': sources,
                'lockfile': members[0] + '/Cargo.lock',
                'lockfile_sha256': sha(stage / 'Cargo.lock'),
                'workspace_manifest': manifest,
                'workspace_manifest_sha256': sha(stage / 'Cargo.toml')}
    (stage / 'derivation.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(stage)


if __name__ == '__main__':
    main()
