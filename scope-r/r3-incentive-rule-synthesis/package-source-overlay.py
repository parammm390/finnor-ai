"""Append a verified current-source/compiled-API layer to the pinned supplier OCI."""
import argparse
import copy
import ctypes
import gzip
import hashlib
import io
import json
import os
import pathlib
import tarfile
from datetime import datetime, timezone

repo = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--work-dir", type=pathlib.Path,
                    default=repo / ".r3-scratch/installed-supplier-reuse")
args = parser.parse_args()
assert args.work_dir.is_absolute(), "R3_ABSOLUTE_PACKAGING_DIRECTORY_REQUIRED"
work = args.work_dir.resolve()
supplier = repo / ".r3-scratch/predecessor-api-amd64.oci.tar"
destination = work / "r3-final-source-overlay.oci.tar"
assert not destination.exists()
assert (work / "final-next/BUILD_ID").is_file()
digest = lambda value: hashlib.sha256(value).hexdigest()


def add_bytes(archive, name, data, mode=0o644):
    item = tarfile.TarInfo(name)
    item.uid = item.gid = 0
    item.mode = mode
    item.size = len(data)
    archive.addfile(item, io.BytesIO(data))


raw_layer = work / "final-overlay.tar"
with tarfile.open(raw_layer, "w") as output:
    with tarfile.open(work / "current-source.tar") as source:
        for item in source:
            output.addfile(item, source.extractfile(item) if item.isfile() else None)
    with tarfile.open(work / "native-callee-graft.tar.gz") as source:
        for item in source:
            output.addfile(item, source.extractfile(item) if item.isfile() else None)
    bytecode = work / "upstream-bytecode.tar.gz"
    bytecode_files = []
    if bytecode.exists():
        with tarfile.open(bytecode) as source:
            for item in source:
                path = pathlib.PurePosixPath(item.name)
                assert item.isfile() and not path.is_absolute() and ".." not in path.parts
                assert str(path).startswith("opt/r3-upstream-runtime/") and path.suffix == ".pyc"
                data = source.extractfile(item).read()
                bytecode_files.append({"path": "/" + item.name, "bytes": len(data), "sha256": digest(data)})
                add_bytes(output, item.name, data, 0o444)
    add_bytes(output, "opt/finnor-s6-linux-native/manifest.json", (work / "native-callee-manifest.json").read_bytes(), 0o444)
    add_bytes(output, "app/r3-installed-source-cut.json", (work / "source-cut.json").read_bytes(), 0o444)
    # The actual new build must replace the whole older .next tree.
    add_bytes(output, "app/finnor-os/apps/api/.next/.wh..wh..opq", b"", 0o000)
    for path in sorted((work / "final-next").rglob("*")):
        name = "app/finnor-os/apps/api/.next/" + str(path.relative_to(work / "final-next"))
        if path.is_file():
            add_bytes(output, name, path.read_bytes(), path.stat().st_mode & 0o777)
        elif path.is_dir():
            item = tarfile.TarInfo(name)
            item.type = tarfile.DIRTYPE
            item.mode = 0o755
            output.addfile(item)
raw_hash = hashlib.sha256()
compressed = work / "final-overlay.tar.gz"
with raw_layer.open("rb") as source, compressed.open("wb") as target:
    with gzip.GzipFile(filename="", mode="wb", fileobj=target, compresslevel=3, mtime=0) as encoder:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            raw_hash.update(part)
            encoder.write(part)
raw_layer.unlink()
layer_hash = hashlib.sha256(compressed.read_bytes()).hexdigest()
with tarfile.open(supplier) as archive:
    entry = archive.getmember("index.json")
    index = json.load(archive.extractfile(entry))
    descriptor = index["manifests"][0]
    manifest = json.load(archive.extractfile("blobs/sha256/" + descriptor["digest"].split(":")[1]))
    while "manifests" in manifest:
        descriptor = manifest["manifests"][0]
        manifest = json.load(archive.extractfile("blobs/sha256/" + descriptor["digest"].split(":")[1]))
    config = json.load(archive.extractfile("blobs/sha256/" + manifest["config"]["digest"].split(":")[1]))
    prefix_end = entry.offset
library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
library.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
library.clonefile.restype = ctypes.c_int
assert library.clonefile(os.fsencode(supplier), os.fsencode(destination), 0) == 0
with destination.open("r+b") as target:
    target.truncate(prefix_end)
    target.seek(prefix_end)
    # Append-mode tar readers require an explicit archive terminator while
    # locating the append position; the old index was the final member.
    target.write(b"\0" * 1024)
created = datetime.now(timezone.utc).isoformat()
images = []
with tarfile.open(destination, "a") as archive:
    item = tarfile.TarInfo("blobs/sha256/" + layer_hash)
    item.size = compressed.stat().st_size
    item.mode = 0o644
    with compressed.open("rb") as source:
        archive.addfile(item, source)
    for role in ["api", "worker"]:
        body = copy.deepcopy(config)
        body["created"] = created
        body["rootfs"]["diff_ids"].append("sha256:" + raw_hash.hexdigest())
        body.setdefault("history", []).append({"created": created,
            "created_by": "Verified current source/native callee plus actual completed Linux Next build overlay",
            "comment": "Pinned supplier dependencies unchanged; no protected admission"})
        cfg = body["config"]
        cfg["User"] = "node"
        cfg["WorkingDir"] = "/app/finnor-os"
        cfg["Env"] = [v for v in cfg["Env"] if not v.startswith("PORT=")] + ["PORT=" + ("3100" if role == "api" else "8090")]
        cfg["Cmd"] = (["node", "--import=tsx", "node_modules/next/dist/bin/next", "start", "apps/api", "--hostname", "0.0.0.0", "--port", "3100"]
                      if role == "api" else ["node_modules/.bin/tsx", "apps/worker/src/index.ts"])
        cfg["ExposedPorts"] = {("3100" if role == "api" else "8090") + "/tcp": {}}
        if role == "worker":
            cfg["Healthcheck"] = {"Test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                                  "Interval": 30000000000, "Timeout": 5000000000, "StartPeriod": 30000000000, "Retries": 3}
        data = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        config_sha = digest(data)
        add_bytes(archive, "blobs/sha256/" + config_sha, data)
        image = copy.deepcopy(manifest)
        image["config"] = {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": "sha256:" + config_sha, "size": len(data)}
        image["layers"].append({"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": "sha256:" + layer_hash, "size": compressed.stat().st_size})
        image_bytes = json.dumps(image, sort_keys=True, separators=(",", ":")).encode()
        image_sha = digest(image_bytes)
        add_bytes(archive, "blobs/sha256/" + image_sha, image_bytes)
        tag = "finnor-r3-" + role + ":installed-source-final"
        images.append({"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": "sha256:" + image_sha,
                       "size": len(image_bytes), "platform": {"os": "linux", "architecture": "amd64"},
                       "annotations": {"org.opencontainers.image.ref.name": tag, "io.containerd.image.name": tag}})
    add_bytes(archive, "index.json", json.dumps({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": images}).encode())
with tarfile.open(destination) as archive:
    names = archive.getnames()
    assert len(names) == len(set(names)), "Duplicate OCI archive members"
    for member in archive:
        if member.name.startswith("blobs/sha256/"):
            h = hashlib.sha256()
            source = archive.extractfile(member)
            for data in iter(lambda: source.read(1024 * 1024), b""):
                h.update(data)
            assert h.hexdigest() == member.name.split("/")[-1]
receipt = {"schema": "finnor.r3.installed-source-overlay-image.v1", "createdAt": created, "images": images,
           "archive": str(destination), "supplierArchiveUnmodified": True, "sourceCut": "source-cut.json",
           "overlayDiffId": "sha256:" + raw_hash.hexdigest(), "allBlobDigestsVerified": True,
           "actualLinuxBuildExit": 0, "productSourceMounts": False, "protectedAdmission": False,
           "qualification": "BUILT_ARTIFACT_REQUIRES_FINAL_INSTALLED_OWNER_EXECUTION"}
if bytecode_files:
    receipt["upstreamBytecode"] = {"archiveSha256": digest(bytecode.read_bytes()), "files": bytecode_files,
        "sourceAndLockedVersionsChanged": False, "compiledByExactInstalledCPython": True,
        "runtimeWritable": False, "rootOwned": True, "originalOwnerTimeoutMs": 20000}
(work / "final-image-manifest.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"images": images, "archive": str(destination), "allBlobDigestsVerified": True,
                  "upstreamBytecodeFiles": len(bytecode_files)}))
