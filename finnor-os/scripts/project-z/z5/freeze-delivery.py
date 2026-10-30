#!/usr/bin/env python3
"""Package an exact committed tree, not a hidden Git/module-dependent overlay."""
import gzip
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
destination = pathlib.Path(sys.argv[1])
if not destination.is_absolute() or not destination.resolve().is_relative_to(ROOT / "scope-z/phase-evidence/z5/reconstruction"):
    raise RuntimeError("FRESH_OWNED_RECONSTRUCTION_DESTINATION_REQUIRED")
if destination.exists():
    raise RuntimeError("RECONSTRUCTION_DELIVERY_MUST_BE_FRESH")
git = lambda *args: subprocess.check_output(["git", "-C", str(ROOT), *args])
if pathlib.Path(git("rev-parse", "--show-toplevel").decode().strip()).resolve() != ROOT:
    raise RuntimeError("PARENT_GIT_FORBIDDEN")
if git("diff", "--name-only", "HEAD").strip():
    raise RuntimeError("EXACT_COMMITTED_SOURCE_REQUIRED")
owned_source = (
    "finnor-os/packages/epistemic-runtime/src/project-z/z5-institution-linker/",
    "finnor-os/packages/orchestration/src/project-z/z5-institution-linker/",
    "finnor-os/packages/private-equity/src/project-z/z5-institution-linker/",
    "finnor-os/scripts/project-z/z5/",
)
if any(p.decode().startswith(owned_source) for p in git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0") if p):
    raise RuntimeError("UNCOMMITTED_OWNED_IMPLEMENTATION_CANNOT_BE_OMITTED")
head, tree = git("rev-parse", "HEAD", "HEAD^{tree}").decode().strip().splitlines()
entries = []
for line in git("ls-tree", "-rz", "HEAD").split(b"\0"):
    if not line:
        continue
    metadata, raw_path = line.split(b"\t", 1)
    mode, kind, oid = metadata.decode().split()
    relative = raw_path.decode("utf8")
    file = ROOT / relative
    if mode not in ("100644", "100755") or kind != "blob" or not file.resolve().is_relative_to(ROOT):
        raise RuntimeError("EXACT_REGULAR_SOURCE_MEMBERSHIP_REQUIRED:" + relative)
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError("SOURCE_SYMLINK_OR_SPECIAL_FILE_REFUSED:" + relative)
    sha, blob = hashlib.sha256(), hashlib.sha1(b"blob " + str(info.st_size).encode() + b"\0")
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
            blob.update(chunk)
    if blob.hexdigest() != oid:
        raise RuntimeError("WORKTREE_DOES_NOT_MATCH_COMMITTED_BLOB:" + relative)
    entries.append({"path": relative, "sha256": sha.hexdigest(), "bytes": info.st_size, "mode": mode, "gitBlob": oid})
total = sum(e["bytes"] for e in entries)
if total > 512 * 1024 * 1024 or shutil.disk_usage(ROOT).free < 2 * total + 128 * 1024 * 1024:
    raise RuntimeError("INSUFFICIENT_SAFE_SOURCE_ARCHIVE_HEADROOM")
destination.mkdir(parents=True, mode=0o700)
archive = destination / "source.tar.gz"
with archive.open("xb") as raw:
    os.chmod(archive, 0o600)
    with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for entry in entries:
                info = tarfile.TarInfo(entry["path"])
                info.size, info.mtime, info.uid, info.gid = entry["bytes"], 0, 0, 0
                info.mode, info.uname, info.gname = (0o755 if entry["mode"] == "100755" else 0o644), "", ""
                with (ROOT / entry["path"]).open("rb") as source:
                    tar.addfile(info, source)
sha_file = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
integration = ROOT / "scope-z/phase-evidence/z5/integration/request-07/manifest.json"
request = json.loads(integration.read_text())
manifest = {
    "schema": "finnor.z5.exact-source-reconstruction.v1", "sourceHead": head, "sourceTree": tree,
    "files": entries, "fileCount": len(entries), "uncompressedBytes": total,
    "containsGitObjects": False, "containsNodeModules": False, "hiddenSourceFallbackAllowed": False,
    "patchSha256": request["patchSha256"], "integrationApplied": False,
    "integrationManifest": str(integration.relative_to(ROOT)),
    "productLock": request["productLock"], "node": "22.23.4", "npm": "11.19.1",
    "python": "3.12.3", "sourceOnly": True, "installedBuildId": None,
}
manifest_file = destination / "source-manifest.json"
manifest_file.write_text(json.dumps(manifest, indent=2) + "\n")
os.chmod(manifest_file, 0o600)
driver = destination / "reconstruct.mjs"
shutil.copyfile(ROOT / "finnor-os/scripts/project-z/z5/reconstruct.mjs", driver)
os.chmod(driver, 0o600)
receipt = {
    "schema": "finnor.z5.reconstruction-delivery.v1", "sourceHead": head, "sourceTree": tree,
    "archive": archive.name, "archiveSha256": sha_file(archive), "archiveBytes": archive.stat().st_size,
    "manifest": manifest_file.name, "manifestSha256": sha_file(manifest_file),
    "reconstructor": driver.name, "reconstructorSha256": sha_file(driver),
    "patchSha256": request["patchSha256"], "integrationApplied": False,
    "fileCount": len(entries), "uncompressedBytes": total,
    "qualification": "EXACT_COMMITTED_SOURCE_PACKAGE_NOT_INSTALLED_OR_NATIVE_QUALIFICATION",
}
receipt_file = destination / "receipt.json"
receipt_file.write_text(json.dumps(receipt, indent=2) + "\n")
os.chmod(receipt_file, 0o600)
print(json.dumps({**receipt, "receiptSha256": sha_file(receipt_file), "destination": str(destination)}))
