#!/usr/bin/env python3
"""Check the repository-local Superpowers installation against its pinned manifest."""

import hashlib
import json
from pathlib import Path
import stat


ROOT = Path(__file__).resolve().parents[1]


def verify_file(record):
    path = ROOT / record["localPath"]
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Missing or symlinked file: {record['localPath']}")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != record["sha256"]:
        raise ValueError(f"SHA-256 mismatch: {record['localPath']}")
    blob = b"blob " + str(len(data)).encode() + b"\0" + data
    if hashlib.sha1(blob).hexdigest() != record["blobSha"]:
        raise ValueError(f"Upstream Git blob mismatch: {record['localPath']}")
    if "bytes" in record and len(data) != record["bytes"]:
        raise ValueError(f"Size mismatch: {record['localPath']}")
    if "gitMode" in record:
        executable = bool(path.stat().st_mode & stat.S_IXUSR)
        if executable != (record["gitMode"] == "100755"):
            raise ValueError(f"Executable mode mismatch: {record['localPath']}")


def main():
    manifest = json.loads((ROOT / "docs/proofcredit/superpowers-skills.json").read_text())
    expected = {ROOT / f["localPath"] for f in manifest["files"]}
    actual = set()
    for skill in manifest["skills"]:
        directory = ROOT / ".agents/skills" / skill
        if directory.is_symlink() or not (directory / "SKILL.md").is_file():
            raise ValueError(f"Missing or symlinked skill directory: {skill}")
        for path in directory.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"Unexpected symlink: {path.relative_to(ROOT)}")
            if path.is_file():
                actual.add(path)
    if actual != expected:
        raise ValueError("Missing or unexpected Superpowers files")
    for record in manifest["files"]:
        verify_file(record)
    verify_file(manifest["license"])
    print(f"Verified {len(manifest['skills'])} Superpowers skills, {len(expected)} pinned files and MIT license at {manifest['ref'][:12]}.")


if __name__ == "__main__":
    main()
