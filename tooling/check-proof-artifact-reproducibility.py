#!/usr/bin/env python3
"""Build actual artifacts in two fresh source locations; compare bytes, not metadata.

Uses only the already provisioned repo-local cache/toolchain. The two target trees
are separate, so Cargo cannot satisfy either build with the other's outputs.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = [
    'wasm32-wasip2/release/rino-proof-worker.wasm',
    'wasm32-wasip2/release/rino-settlement-worker.wasm',
    'wasm32-unknown-unknown/release/rino_controller.wasm',
    'wasm32-unknown-unknown/release/rino_pipeline_services.wasm',
]


def main():
    scratch = ROOT / '.cache/artifact-reproducibility'
    scratch.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='check-', dir=scratch))
    checkouts = [run / 'checkout-a', run / 'different-location' / 'checkout-b']
    digests = {}
    # Snapshot source once before either build. Otherwise live development during
    # checkout-a's build can copy different source into checkout-b and masquerade
    # as a location-dependent artifact failure.
    snapshot = checkouts[0]
    snapshot.mkdir(parents=True)
    for directory in ['crates', 'contracts', 'workers', 'tests/proof-pipeline', 'tooling']:
        shutil.copytree(ROOT / directory, snapshot / directory,
                        ignore=shutil.ignore_patterns('target', '__pycache__'))
    (snapshot / '.tools').symlink_to(ROOT / '.tools', target_is_directory=True)
    (snapshot / '.cache').mkdir()
    (snapshot / '.cache/cargo').symlink_to(ROOT / '.cache/cargo', target_is_directory=True)
    checkouts[1].parent.mkdir(parents=True)
    shutil.copytree(snapshot, checkouts[1], symlinks=True)
    for checkout in checkouts:
        # A source-only copy has no Git metadata; the worker manifest must say so.
        for command in ['./tooling/build-proof-worker.sh', './tooling/build-settlement-worker.sh', './tooling/build-proof-contracts.sh']:
            subprocess.run([command], cwd=checkout, check=True)
        for name in ['proof-worker-manifest.json', 'settlement-worker-manifest.json']:
            manifest = json.loads((checkout / 'target' / name).read_text())
            if manifest['source_base_revision'] is not None or manifest['source_tree_dirty'] is not None:
                raise SystemExit('Source-only provenance incorrectly claims a Git revision')
        digests[str(checkout.relative_to(ROOT))] = {
            artifact: hashlib.sha256((checkout / 'target' / artifact).read_bytes()).hexdigest()
            for artifact in ARTIFACTS
        }
    mismatches = []
    for artifact in ARTIFACTS:
        left, right = [(checkout / 'target' / artifact).read_bytes() for checkout in checkouts]
        if left != right:
            mismatches.append(artifact)
    evidence = {'checkouts': digests, 'byte_comparison': 'FAIL' if mismatches else 'PASS',
                'mismatches': mismatches, 'platform_scope': 'macOS ARM64 Rust 1.99.1 only'}
    (run / 'comparison.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2), flush=True)
    if mismatches:
        raise SystemExit('Artifact bytes depend on checkout location')


if __name__ == '__main__':
    main()
