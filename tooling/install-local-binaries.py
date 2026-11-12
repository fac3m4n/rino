#!/usr/bin/env python3
"""Install exact official development binaries into this checkout, or verify only."""
import hashlib
from pathlib import Path
import platform
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TOOLS = [
    ("near-sandbox", "2.14.0", "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Darwin-arm64/2.14.0/near-sandbox.tar.gz", "ea53448ef97540c012e5c3d967c74d78292b0465a98cf7027811a936718fe232", "8e0e1521372b0fce801b7464078c1e95e5a25a0f92ad4b4241451c33fe9e5a2a"),
    ("anvil", "1.7.1", "https://github.com/foundry-rs/foundry/releases/download/v1.7.1/foundry_v1.7.1_darwin_arm64.tar.gz", "eacdc67718fac857cad9e19c7f6729dd80de731d09df81856391d093cfcab547", "5c9f9aad323062b1c0421a63595741430acaea150da3611e38c45071e4cf4e28"),
]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("Only macOS ARM64 artifacts are reviewed")
    if sys.argv[1:] not in ([], ["--verify-only"]):
        raise SystemExit("Usage: install-local-binaries.py [--verify-only]")
    for name, version, url, archive_sha, binary_sha in TOOLS:
        binary = ROOT / ".tools" / name / version / name
        if not binary.is_file():
            if sys.argv[1:]:
                raise SystemExit("Missing " + str(binary))
            cache = ROOT / ".cache" / "tool-downloads"
            cache.mkdir(parents=True, exist_ok=True)
            archive = cache / (name + "-" + version + "-darwin-arm64.tar.gz")
            if not archive.is_file():
                with urllib.request.urlopen(url, timeout=120) as response:
                    data = response.read()
                if digest(data) != archive_sha:
                    raise SystemExit("Archive SHA-256 mismatch: " + name)
                archive.write_bytes(data)
            if digest(archive.read_bytes()) != archive_sha:
                raise SystemExit("Archive SHA-256 mismatch: " + name)
            with tarfile.open(archive) as tar:
                matches = [m for m in tar.getmembers() if Path(m.name).name == name and m.isfile()]
                if len(matches) != 1:
                    raise SystemExit("Expected exactly one regular binary: " + name)
                stream = tar.extractfile(matches[0])
                data = stream.read()
            if digest(data) != binary_sha:
                raise SystemExit("Binary SHA-256 mismatch: " + name)
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_bytes(data)
            binary.chmod(0o755)
        if binary.is_symlink() or digest(binary.read_bytes()) != binary_sha:
            raise SystemExit("Installed binary SHA-256 mismatch: " + name)
        print(name + " " + version + " SHA-256 " + binary_sha)

if __name__ == "__main__":
    main()
