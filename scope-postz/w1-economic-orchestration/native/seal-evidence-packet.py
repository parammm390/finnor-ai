"""Lossless, fully checked transport of task-owned original evidence bytes."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

SCOPE = Path(__file__).resolve().parents[1]
PACKETS = SCOPE / "evidence/sealed-packets"
MAX_TOTAL = 2 * 1024**3
MAX_FILE = 256 * 1024**2
MAX_SIDECAR = 10 * 1024**2
PATTERNS = [
    ("private-key", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("jwt", re.compile(rb"\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b")),
    ("provider-key", re.compile(rb"\b(?:sk-proj-|sk_live_|AKIA)[A-Za-z0-9_-]{12,}\b")),
]


def fail(message):
    raise RuntimeError(message)


def owned(name):
    p = PurePosixPath(name)
    if (not name or p.is_absolute() or str(p) != name or ".." in p.parts
            or len(p.parts) < 2 or p.parts[0] not in {"evidence", "integration-proposals"}
            or p.parts[:2] == ("evidence", "sealed-packets")
            or any(ord(c) < 32 for c in name) or ".git" in p.parts):
        fail("NONCANONICAL_OWNED_EVIDENCE_PATH")
    target = SCOPE
    for part in p.parts:
        target = target / part
        if target.is_symlink():
            fail("EVIDENCE_SYMLINK_REFUSED")
    return target


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as src:
        for chunk in iter(lambda: src.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot(directory):
    source = owned(directory)
    if not source.is_dir():
        fail("EXISTING_OWNED_EVIDENCE_DIRECTORY_REQUIRED")
    files = []
    total = 0
    for path in sorted(source.rglob("*")):
        name = path.relative_to(SCOPE).as_posix()
        owned(name)
        if path.is_dir():
            continue
        if not path.is_file():
            fail("REGULAR_EVIDENCE_FILES_ONLY")
        size = path.stat().st_size
        total += size
        if size > MAX_FILE or total > MAX_TOTAL:
            fail("BOUNDED_EVIDENCE_PACKET_CAPACITY")
        data = path.read_bytes()
        if len(data) != size:
            fail("ORIGINAL_EVIDENCE_CHANGED_DURING_SNAPSHOT")
        for rule, pattern in PATTERNS:
            if pattern.search(data):
                fail("ORIGINAL_SECRET_PATTERN_REFUSED:" + rule + ":" + name)
        files.append({"path": name, "bytes": size,
            "sha256": hashlib.sha256(data).hexdigest(), "mode": path.stat().st_mode & 0o777})
    if not files:
        fail("NONEMPTY_EVIDENCE_PACKET_REQUIRED")
    return files


def verify(archive, manifest):
    if archive.stat().st_size > MAX_TOTAL + 16 * 1024**2:
        fail("COMPRESSED_PACKET_CAPACITY_BOUND")
    if digest_file(archive) != manifest["archiveSha256"]:
        fail("COMPRESSED_PACKET_DIGEST_MISMATCH")
    if archive.stat().st_size != manifest["archiveBytes"]:
        fail("COMPRESSED_PACKET_SIZE_MISMATCH")
    files = manifest["files"]
    if (manifest["schema"] != "finnor.w1.lossless-original-evidence-packet.v1"
            or manifest["fileCount"] != len(files)
            or manifest["originalBytes"] != sum(f["bytes"] for f in files)
            or [f["path"] for f in files] != sorted(f["path"] for f in files)):
        fail("PACKET_SIDECAR_CENSUS_MISMATCH")
    expected = {}
    prefix = manifest["sourceDirectory"] + "/"
    owned(manifest["sourceDirectory"])
    for item in files:
        owned(item["path"])
        if (not item["path"].startswith(prefix) or item["path"] in expected
                or type(item["bytes"]) is not int or not 0 <= item["bytes"] <= MAX_FILE
                or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])
                or type(item["mode"]) is not int or not 0 <= item["mode"] <= 0o777):
            fail("INVALID_PACKET_MEMBER_MANIFEST")
        expected[item["path"]] = item
    if not expected or sum(f["bytes"] for f in files) > MAX_TOTAL:
        fail("INVALID_PACKET_TOTAL_BOUND")
    observed = set()
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            if not member.isfile() or member.name not in expected or member.name in observed:
                fail("UNEXPECTED_OR_REPEATED_ARCHIVE_MEMBER")
            item = expected[member.name]
            if member.size != item["bytes"] or member.mode != item["mode"]:
                fail("ARCHIVE_MEMBER_METADATA_MISMATCH")
            stream = tar.extractfile(member)
            if stream is None:
                fail("MISSING_ARCHIVE_MEMBER_STREAM")
            digest, size = hashlib.sha256(), 0
            with stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
                    size += len(chunk)
                    if size > item["bytes"]:
                        fail("ARCHIVE_MEMBER_SIZE_OVERFLOW")
            if size != item["bytes"] or digest.hexdigest() != item["sha256"]:
                fail("ARCHIVE_MEMBER_ORIGINAL_BYTE_MISMATCH")
            observed.add(member.name)
    if observed != set(expected):
        fail("ARCHIVE_MEMBERSHIP_MISMATCH")
    return expected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["pack", "verify", "extract"])
    parser.add_argument("tag")
    parser.add_argument("directory", nargs="?")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,120}", args.tag):
        fail("BOUNDED_PACKET_TAG_REQUIRED")
    archive = PACKETS / (args.tag + ".tar.gz")
    sidecar = PACKETS / (args.tag + ".manifest.json")
    for path in (SCOPE / "evidence", PACKETS, archive, sidecar):
        if path.is_symlink():
            fail("PACKET_PATH_SYMLINK_REFUSED")
    if args.operation == "pack":
        if not args.directory or archive.exists() or sidecar.exists():
            fail("NEW_PACKET_AND_ORIGINAL_DIRECTORY_REQUIRED")
        files = snapshot(args.directory)
        PACKETS.mkdir(parents=True, exist_ok=True)
        if PACKETS.is_symlink():
            fail("PACKET_DIRECTORY_SYMLINK_REFUSED")
        with archive.open("xb") as destination:
            with gzip.GzipFile(fileobj=destination, mode="wb", filename="", mtime=0,
                    compresslevel=1) as compressed:
                with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as tar:
                    for item in files:
                        info = tarfile.TarInfo(item["path"])
                        info.size, info.mode, info.mtime = item["bytes"], item["mode"], 0
                        info.uid, info.gid, info.uname, info.gname = 0, 0, "", ""
                        with owned(item["path"]).open("rb") as source:
                            tar.addfile(info, source)
        manifest = {"schema": "finnor.w1.lossless-original-evidence-packet.v1",
            "at": datetime.now(timezone.utc).isoformat(), "tag": args.tag,
            "sourceDirectory": args.directory, "files": files,
            "fileCount": len(files), "originalBytes": sum(f["bytes"] for f in files),
            "archiveSha256": digest_file(archive), "archiveBytes": archive.stat().st_size,
            "secretPatternRules": [p[0] for p in PATTERNS], "secretPatternMatches": 0,
            "secretScanQualification": "Bounded pattern scan, not exhaustive secret or security attestation",
            "allOriginalFilesAndArchivedMembersVerified": True,
            "originalWorkingFilesDeleted": False,
            "restoreCommand": ["python3", "scope-postz/w1-economic-orchestration/native/seal-evidence-packet.py",
                "extract", args.tag], "restoreCwd": "RECONSTRUCTED_CHECKOUT_ROOT",
            "meaning": "Transport only; original bytes, failure status and oracle predicates unchanged"}
        serialized = (json.dumps(manifest, indent=2) + "\n").encode("utf8")
        if len(serialized) > MAX_SIDECAR:
            fail("PACKET_SIDECAR_CAPACITY_BOUND")
        verify(archive, manifest)
        if snapshot(args.directory) != files:
            fail("ORIGINAL_MEMBERSHIP_OR_BYTES_CHANGED_BEFORE_SEAL")
        with sidecar.open("xb") as out:
            out.write(serialized)
    else:
        if args.directory:
            fail("VERIFY_OR_EXTRACT_ACCEPTS_ONLY_PACKET_TAG")
        if not archive.is_file() or not sidecar.is_file() or sidecar.stat().st_size > MAX_SIDECAR:
            fail("BOUNDED_REGULAR_PACKET_AND_SIDECAR_REQUIRED")
        manifest = json.loads(sidecar.read_text())
        if manifest["tag"] != args.tag:
            fail("PACKET_TAG_MISMATCH")
        expected = verify(archive, manifest)
        if args.operation == "extract":
            # No member is written until the complete packet has verified.
            with tarfile.open(archive, "r|gz") as tar:
                for member in tar:
                    item = expected[member.name]
                    target = owned(member.name)
                    if target.exists():
                        if (not target.is_file() or target.stat().st_size != item["bytes"]
                                or digest_file(target) != item["sha256"]):
                            fail("DIFFERING_EXISTING_EVIDENCE_WILL_NOT_BE_OVERWRITTEN")
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    owned(member.name)
                    stream = tar.extractfile(member)
                    if stream is None:
                        fail("MISSING_VERIFIED_EXTRACTION_STREAM")
                    with stream, target.open("xb") as out:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            out.write(chunk)
                    target.chmod(item["mode"])
                    if digest_file(target) != item["sha256"]:
                        fail("MATERIALIZED_ORIGINAL_DIGEST_MISMATCH")
            if snapshot(manifest["sourceDirectory"]) != manifest["files"]:
                fail("MATERIALIZED_ORIGINAL_MEMBERSHIP_MISMATCH")
    print(json.dumps({"status": "VERIFIED_LOSSLESS_ORIGINALS",
        "operation": args.operation, "packet": str(archive), "manifest": str(sidecar),
        "files": manifest["fileCount"], "originalBytes": manifest["originalBytes"],
        "archiveBytes": manifest["archiveBytes"], "archiveSha256": manifest["archiveSha256"],
        "businessPredicateChanges": 0}))


if __name__ == "__main__":
    main()
