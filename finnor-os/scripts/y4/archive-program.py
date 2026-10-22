"""Preserve checked public tapes while releasing only task sandbox scratch.

Never touches installed copies, dependency files, participant state or private
evidence. Every generated file must match its retained compilation manifest.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import stat
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--backend", required=True, type=Path)
parser.add_argument("--manifest", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
parser.add_argument("--release-generated-files", action="store_true")
args = parser.parse_args()
os.umask(0o077)
if not all(p.is_absolute() for p in (args.backend, args.manifest, args.output)):
    raise ValueError("ABSOLUTE_TASK_ASSET_PATHS_REQUIRED")
backend = args.backend.resolve(strict=True)
programs = (backend / "Programs").resolve(strict=True)
if backend.parent.name != "y4-tools" or not backend.name.startswith("native-runtime-") \
        or programs.parent != Path("/dev/shm") or not programs.name.startswith("finnor-y4-programs-"):
    raise ValueError("ONLY_EXPLICIT_Y4_DISPOSABLE_SANDBOX_ALLOWED")
raw = args.manifest.read_bytes()
manifest = json.loads(raw)
name = manifest["name"]
if not re.fullmatch(r"y4_[a-f0-9]{40}", name):
    raise ValueError("GENERATED_Y4_PROGRAM_ID_REQUIRED")
expected = dict(manifest["files"])
source = "Programs/Source/" + name + ".mpc"
if (backend / source).exists():
    expected[source] = manifest["sourceDigest"]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


paths = {}
for relative, fingerprint in expected.items():
    path = backend / relative
    parts = Path(relative).parts
    if len(parts) != 3 or parts[0] != "Programs" or parts[1] not in ("Bytecode", "Schedules", "Source") \
            or not parts[2].startswith(name) or not stat.S_ISREG(path.lstat().st_mode) \
            or not path.resolve(strict=True).is_relative_to(programs) or digest(path) != fingerprint:
        raise ValueError("EXACT_OWN_GENERATED_PUBLIC_FILE_REQUIRED")
    paths[relative] = path
total = sum(path.stat().st_size for path in paths.values())
with args.output.open("xb") as output:
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|") as archive:
            entry = tarfile.TarInfo("program.json")
            entry.size, entry.mode = len(raw), 0o444
            archive.addfile(entry, io.BytesIO(raw))
            for relative, path in sorted(paths.items()):
                entry = tarfile.TarInfo(relative)
                entry.size, entry.mode = path.stat().st_size, 0o444
                with path.open("rb") as original:
                    archive.addfile(entry, original)
observed = {}
with tarfile.open(args.output, "r:gz") as archive:
    for member in archive:
        if not member.isfile() or member.name in observed:
            raise ValueError("EXACT_REGULAR_ARCHIVE_MEMBERS_REQUIRED")
        with archive.extractfile(member) as stream:
            observed[member.name] = hashlib.file_digest(stream, "sha256").hexdigest()
if observed != {**expected, "program.json": hashlib.sha256(raw).hexdigest()}:
    raise ValueError("PUBLIC_ARCHIVE_RECONSTRUCTION_DID_NOT_MATCH")
if args.release_generated_files:
    # Validate the entire set again before releasing any invocation-owned file.
    if any(digest(path) != expected[relative] for relative, path in paths.items()):
        raise ValueError("SANDBOX_CHANGED_BEFORE_SCRATCH_RELEASE")
    for path in paths.values():
        path.unlink()
receipt = {
    "schema": "finnor.y4.public-program-archive.v1", "manifest": str(args.manifest),
    "archive": str(args.output), "archiveSha256": digest(args.output),
    "files": len(paths), "uncompressedBytes": total, "archiveBytes": args.output.stat().st_size,
    "individuallyReconstructedHashesMatch": True,
    "taskGeneratedSandboxReleased": args.release_generated_files,
    "installedCopiesAndParticipantStateTouched": False,
}
with Path(str(args.output) + ".json").open("x") as output:
    json.dump(receipt, output, indent=2)
    output.write("\n")
print(json.dumps(receipt))
