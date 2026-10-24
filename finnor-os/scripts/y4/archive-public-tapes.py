"""User-authorized lossless custody of completed Y4 public compiler tapes."""
import argparse
import gzip
import hashlib
import json
import os
import re
import signal
import stat
import tarfile
from pathlib import Path


def file_sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def active_y4():
    active = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal() or int(entry.name) == os.getpid():
            continue
        try:
            args = (entry / "cmdline").read_bytes().split(b"\0")
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if not any(a.rsplit(b"/", 1)[-1] in
                   (b"compile.py", b"mascot-party.x", b"participant.py", b"public_driver.py") for a in args):
            continue
        try:
            cwd = os.readlink(entry / "cwd").encode()
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            active.append(int(entry.name))
            continue
        if any(a.startswith((b"/home/factory-user/y4-", b"/dev/shm/finnor-y4-"))
               for a in [cwd, *args]):
            active.append(int(entry.name))
    return active


def metadata(path):
    item = path.lstat()
    if not stat.S_ISREG(item.st_mode) or item.st_uid != os.getuid() or item.st_nlink != 1:
        raise ValueError("EXACT_OWNED_REGULAR_PUBLIC_TAPE_REQUIRED")
    return {"bytes": item.st_size, "mode": stat.S_IMODE(item.st_mode),
            "device": item.st_dev, "inode": item.st_ino, "mtimeNs": item.st_mtime_ns,
            "sha256": file_sha(path)}


def dump(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def interrupted(_signal, _frame):
    raise RuntimeError("PUBLIC_TAPE_ARCHIVE_INTERRUPTED")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    for path in (args.archive, args.evidence):
        if not path.is_absolute() or path.exists() or path.resolve(strict=False) != path \
                or not (path.is_relative_to(Path("/home/factory-user/y4-delivery"))
                        or str(path).startswith("/dev/shm/finnor-y4-public-tape-")):
            raise ValueError("NEW_CONTAINED_TASK_CUSTODY_OUTPUT_REQUIRED")
    report = {"schema": "finnor.y4.public-tape-custody.v1", "status": "FAIL",
              "driverSha256": file_sha(Path(__file__)),
              "sourceDirectory": str(args.source), "archive": str(args.archive),
              "authorization": "EXPLICIT_USER_APPROVAL_VERIFIED_PUBLIC_TAPE_ARCHIVAL",
              "privateStateReadOrChanged": False, "installationsChanged": False,
              "originalFailureReportsChanged": False, "oldComputationsResumed": False,
              "sourceStorageTemporary": str(args.source).startswith("/dev/shm/"),
              "archiveStorageTemporary": str(args.archive).startswith("/dev/shm/"),
              "files": 0, "rawCopiesRemoved": [], "allArchivedBytesIndependentlyVerified": False}
    args.evidence.mkdir(mode=0o700)
    try:
        if not re.fullmatch(r"(?:/dev/shm/finnor-y4-programs-|/home/factory-user/y4-tools/native-programs-)\d{3}/Bytecode", str(args.source)) \
                or args.source.resolve(strict=True) != args.source or not args.source.is_dir() \
                or args.source.stat().st_uid != os.getuid() or active_y4():
            raise ValueError("STOPPED_OWNED_Y4_PUBLIC_TAPE_DIRECTORY_REQUIRED")
        paths = sorted(args.source.iterdir())
        if not paths or any(not re.fullmatch(r"y4_[a-f0-9]{40}-[A-Za-z0-9_(),-]+\.bc", p.name) for p in paths):
            raise ValueError("ONLY_REGISTERED_Y4_PUBLIC_BYTECODE_TAPES_ALLOWED")
        frozen = {p.name: metadata(p) for p in paths}
        report["files"] = len(frozen)
        with args.archive.open("xb") as stream:
            with gzip.GzipFile(filename="", fileobj=stream, mode="wb", mtime=0, compresslevel=1) as zipped:
                with tarfile.open(fileobj=zipped, mode="w|") as tar:
                    for path in paths:
                        record = frozen[path.name]
                        info = tarfile.TarInfo(path.name)
                        info.size, info.mode, info.mtime = record["bytes"], record["mode"], 0
                        with path.open("rb") as body:
                            tar.addfile(info, body)
            stream.flush()
            os.fsync(stream.fileno())
        observed = set()
        with tarfile.open(args.archive, "r:gz") as archive:
            for member in archive:
                if not member.isfile() or member.name not in frozen or member.name in observed:
                    raise ValueError("EXACT_UNIQUE_PUBLIC_TAPE_ARCHIVE_REQUIRED")
                record = frozen[member.name]
                with archive.extractfile(member) as body:
                    fingerprint = hashlib.file_digest(body, "sha256").hexdigest()
                if member.size != record["bytes"] or member.mode != record["mode"] or fingerprint != record["sha256"]:
                    raise ValueError("LOSSLESS_PUBLIC_TAPE_CUSTODY_NOT_VERIFIED")
                observed.add(member.name)
        if observed != set(frozen) or any(metadata(p) != frozen[p.name] for p in paths) or active_y4():
            raise ValueError("PUBLIC_TAPES_CHANGED_OR_STILL_IN_USE")
        report.update(allArchivedBytesIndependentlyVerified=True, archiveSha256=file_sha(args.archive),
                      archiveBytes=args.archive.stat().st_size,
                      originalLogicalBytes=sum(r["bytes"] for r in frozen.values()))
        # Persist full verified recovery information before removing any copy.
        with (args.evidence / "verified-inventory.json").open("xb") as inventory:
            inventory.write(dump({"archiveSha256": report["archiveSha256"], "files": frozen}))
            inventory.flush()
            os.fsync(inventory.fileno())
        for directory in (args.archive.parent, args.evidence):
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        for path in paths:
            if metadata(path) != frozen[path.name]:
                raise ValueError("PUBLIC_TAPE_CHANGED_BEFORE_RAW_COPY_REMOVAL")
            path.unlink()
            report["rawCopiesRemoved"].append(path.name)
        report["status"] = "PASS"
    finally:
        (args.evidence / "result.json").write_bytes(dump(report))
    print(json.dumps({k: report[k] for k in ("status", "files", "archiveBytes", "allArchivedBytesIndependentlyVerified",
                                           "archiveStorageTemporary")}))


if __name__ == "__main__":
    main()
