"""Retain a completed owned reconstruction's evidence, never its donor-free install."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tarfile

p = argparse.ArgumentParser()
p.add_argument("--original", type=Path, required=True)
p.add_argument("--output", type=Path, required=True)
a = p.parse_args()
os.umask(0o077)
if not a.original.is_absolute() or a.original.resolve(strict=True) != a.original \
        or not a.output.is_absolute() or a.output.exists():
    raise ValueError("EXACT_OWNED_ORIGINAL_AND_NEW_ABSOLUTE_OUTPUT_REQUIRED")
result = json.loads((a.original / "result.json").read_text())
if result.get("schema") != "finnor.y4.native-reconstruction.v1" \
        or result.get("status") != "PASS" or not result.get("fullProductCleanInstall"):
    raise ValueError("COMPLETED_FULL_RECONSTRUCTION_REQUIRED")
members = []
for name in ["result.json", "reconstruction-driver.py", "product-episode",
             "PRIVATE-NOT-FOR-HANDOFF"]:
    base = a.original / name
    members.append(base)
    if base.is_dir():
        members.extend(sorted(base.rglob("*")))
total = 0
before = {}
for path in members:
    info = path.lstat()
    if stat.S_ISREG(info.st_mode):
        total += info.st_size
        before[str(path.relative_to(a.original))] = hashlib.sha256(path.read_bytes()).hexdigest()
    elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
        raise ValueError("REGULAR_OWNED_EVIDENCE_ONLY")
if total > 256 * 1024 * 1024:
    raise ValueError("BOUNDED_RECONSTRUCTION_EVIDENCE_REQUIRED")
a.output.mkdir(mode=0o700)
private = a.output / "PRIVATE-NOT-FOR-HANDOFF"
private.mkdir(mode=0o700)
archive = private / "retained-product-evidence.tar.gz"
with tarfile.open(archive, "w:gz", dereference=False) as out:
    for path in members:
        out.add(path, arcname=str(path.relative_to(a.original)), recursive=False)
for name, digest in before.items():
    if hashlib.sha256((a.original / name).read_bytes()).hexdigest() != digest:
        raise ValueError("ORIGINAL_EXECUTION_EVIDENCE_CHANGED")
(private / "regular-byte-inventory.json").write_text(json.dumps(before, sort_keys=True) + "\n")
for name in ["result.json", "reconstruction-driver.py"]:
    (a.output / name).write_bytes((a.original / name).read_bytes())
receipt = {"schema": "finnor.y4.reconstruction-custody.v1", "status": "PASS",
           "original": str(a.original), "regularFiles": len(before),
           "regularBytes": total, "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
           "originalRegularBytesUnchanged": True, "linksFollowed": False,
           "privateArchivePublished": False, "completeInstallationCopied": False,
           "sourceAndRuntimePackagesSeparatelyRetained": True}
(a.output / "retention-custody.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
