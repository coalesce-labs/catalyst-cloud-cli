#!/usr/bin/env python3
"""Publish native filesystem headroom for a supervisor inside a VM."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import time


def publish(path: Path, output: Path) -> dict:
    filesystem = os.statvfs(path)
    sample = {
        "schemaVersion": 1,
        "path": str(path.resolve(strict=True)),
        "observedAtMs": time.time_ns() // 1_000_000,
        "availableBytes": filesystem.f_bavail * filesystem.f_frsize,
        "totalBytes": filesystem.f_blocks * filesystem.f_frsize,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=output.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(sample, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o644)
        os.replace(temporary, output)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return sample


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", required=True, type=Path, help="Native filesystem backing the VM disk")
    parser.add_argument("--output", required=True, type=Path, help="Sample in a read-only supervisor bind")
    args = parser.parse_args()
    publish(args.path, args.output)
