#!/usr/bin/env python3
"""Validate the repository's Conventional Commit subject format."""

from pathlib import Path
import re
import sys


def main():
    lines = Path(sys.argv[1]).read_text().splitlines()
    subject = lines[0] if lines else ""
    pattern = r"(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9][a-z0-9./_-]*\))?!?: \S.*"
    if len(subject) > 72 or re.fullmatch(pattern, subject) is None:
        print("Commit subject must be <=72 characters: type(scope): description", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
