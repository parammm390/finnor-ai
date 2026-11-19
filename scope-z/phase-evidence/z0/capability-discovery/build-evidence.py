#!/usr/bin/env python3
"""Retain exact discovery-run inputs and outputs, without nested checkouts."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def bounded(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 8 * 1024 * 1024:
            raise ValueError(f"Not a bounded regular file: {path}")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(8 * 1024 * 1024 + 1)
        if len(data) != info.st_size:
            raise ValueError(f"File changed while reading: {path}")
        return data
    finally:
        os.close(fd)


def safe(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or str(path) != name:
        raise ValueError("Unsafe evidence member")
    return name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    if not args.root.is_absolute():
        parser.error("--root must be absolute")
    root = args.root.resolve()
    evidence = root / "scope-z/phase-evidence/z0/capability-discovery"
    names = ["run-KAFYLh", "run-aODQI2", "run-6r9b7P", "run-nyn65Y",
             "run-oQYNki", "run-UfA8os"]
    members = {}
    runs = []

    def add(name, data):
        safe(name)
        if name in members:
            raise ValueError(f"Duplicate evidence member: {name}")
        members[name] = data

    for filename in ["pre-code-contract.md", "reconstruction-notes.md", "build-evidence.py"]:
        add(filename, bounded(evidence / filename))
    for name in names:
        directory = evidence / name
        report = json.loads(bounded(directory / "report.json"))
        inventory = json.loads(bounded(directory / "source-inventory.json"))
        base = report["sourceBaseCommit"]
        if len(base) != 40 or any(c not in "0123456789abcdef" for c in base):
            raise ValueError("Invalid source base")
        tree = subprocess.check_output(["git", "-C", str(root), "ls-tree", "-rz", base])
        objects = {}
        for entry in tree.split(b"\0"):
            if entry:
                header, path = entry.split(b"\t", 1)
                mode, kind, oid = header.decode().split()
                if kind == "blob" and mode in {"100644", "100755"}:
                    objects[path.decode()] = oid
        for folder, directories, files in os.walk(directory, followlinks=False):
            directories[:] = sorted(item for item in directories if item != "checkout")
            for filename in sorted(files):
                path = Path(folder) / filename
                add(f"runs/{name}/{path.relative_to(directory).as_posix()}", bounded(path))
        overlays = []
        for row in inventory:
            filename = safe(row["file"])
            data = None
            for candidate in [directory / "checkout" / filename, root / filename]:
                if candidate.exists():
                    content = bounded(candidate)
                    if len(content) == row["bytes"] and sha(content) == row["sha256"]:
                        data = content
                        break
            oid = objects.get(filename)
            if data is None and oid:
                content = subprocess.check_output(["git", "-C", str(root), "cat-file", "blob", oid])
                if len(content) == row["bytes"] and sha(content) == row["sha256"]:
                    data = content
            if data is None:
                raise ValueError(f"Missing exact initial source preimage: {name}/{filename}")
            blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            if blob != oid:
                add(f"runs/{name}/source-overlay/{filename}", data)
                overlays.append({"file": filename, "bytes": len(data), "sha256": sha(data)})
        runs.append({"run": name, "sourceBaseCommit": base, "result": report["result"],
                     "passed": report["passed"], "failed": report["failed"],
                     "sourceInventorySha256": sha(bounded(directory / "source-inventory.json")),
                     "sourceOverlays": overlays})
    index = [{"file": name, "bytes": len(data), "sha256": sha(data)}
             for name, data in sorted(members.items())]
    add("archive-index.json", (json.dumps({"runs": runs, "members": index}, indent=2) + "\n").encode())
    if sum(map(len, members.values())) > 128 * 1024 * 1024:
        raise ValueError("Evidence exceeds the bounded archive budget")
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.USTAR_FORMAT) as archive:
            for name, data in sorted(members.items()):
                item = tarfile.TarInfo(name)
                item.size = len(data)
                item.mode = 0o644
                item.mtime = 0
                archive.addfile(item, io.BytesIO(data))
    archive_bytes = output.getvalue()
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        observed = {}
        for item in archive:
            if not item.isfile() or item.name in observed:
                raise ValueError("Invalid round-trip evidence member")
            observed[item.name] = archive.extractfile(item).read()
        if observed != members:
            raise ValueError("Evidence archive round-trip failed")
    target = evidence / "evidence-1.0.0.tar.gz"
    if target.exists() and bounded(target) != archive_bytes:
        raise ValueError("Refusing to overwrite a differing evidence archive")
    target.write_bytes(archive_bytes)
    receipt = {"schema": "finnor.capability-discovery-evidence/v1", "archive": target.name,
               "bytes": len(archive_bytes), "sha256": sha(archive_bytes),
               "members": len(members), "uncompressedBytes": sum(map(len, members.values())),
               "roundTrip": "PASS", "runs": runs,
               "qualification": "Source-contract CLI evidence only, not clean product install, authenticated owner flow, dedicated execution or qualification"}
    receipt_bytes = (json.dumps(receipt, indent=2) + "\n").encode()
    receipt_file = evidence / "evidence-receipt.json"
    if receipt_file.exists() and bounded(receipt_file) != receipt_bytes:
        raise ValueError("Refusing to overwrite a differing evidence receipt")
    receipt_file.write_bytes(receipt_bytes)
    print(json.dumps({key: value for key, value in receipt.items() if key != "runs"}))


if __name__ == "__main__":
    main()
