"""Reproducible source overlay and OCI packaging of an actual stopped Linux build."""
import argparse
import copy
import gzip
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile
from datetime import datetime, timezone

repo = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["source", "oci"])
parser.add_argument("output")
parser.add_argument("--rootfs")
parser.add_argument("--supplier-archive")
parser.add_argument("--compressed-rootfs", action="store_true")
parser.add_argument("--tag-suffix", default="installed-source-final")
args = parser.parse_args()
out = pathlib.Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
sha = lambda data: hashlib.sha256(data).hexdigest()


def write_member(archive, name, data, mode=0o644):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.uid = info.gid = 0
    archive.addfile(info, io.BytesIO(data))


if args.mode == "source":
    areas = ["finnor-os", "package-lock.json", "infra/deployment/production.contract.json",
             "scripts/release/production-mutation-guard.mjs", "scripts/release/release-policy.mjs",
             "scripts/release/worktree-state.mjs", "src/components/centropy/canvas",
             "scope-r/r3-incentive-rule-synthesis/verification-plan.json"]
    names = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", *areas],
                                    cwd=repo, text=True).splitlines()
    records = []
    with tarfile.open(out / "current-source.tar", "w") as archive:
        for name in sorted(set(names)):
            path = repo / name
            if not path.is_file() or "node_modules" in path.parts:
                continue
            data = path.read_bytes()
            records.append({"path": name, "sha256": sha(data), "bytes": len(data)})
            write_member(archive, "app/" + name, data, path.stat().st_mode & 0o777)
    (out / "source-cut.json").write_text(json.dumps({"schema": "finnor.r3.installed-source-cut.v1",
        "files": records, "digest": sha(json.dumps(records, sort_keys=True, separators=(",", ":")).encode()),
        "privateEvidenceIncluded": False, "hostDependenciesIncluded": False}, indent=2) + "\n")
    print(json.dumps({"sourceFiles": len(records), "tar": str(out / "current-source.tar")}))
    raise SystemExit(0)

assert args.rootfs and args.supplier_archive
rootfs = pathlib.Path(args.rootfs).resolve()
supplier = pathlib.Path(args.supplier_archive).resolve()
with tarfile.open(supplier) as archive:
    index = json.load(archive.extractfile("index.json"))
    descriptor = index["manifests"][0]
    body = json.load(archive.extractfile("blobs/sha256/" + descriptor["digest"].split(":")[1]))
    while "manifests" in body:
        descriptor = body["manifests"][0]
        body = json.load(archive.extractfile("blobs/sha256/" + descriptor["digest"].split(":")[1]))
    config_data = archive.extractfile("blobs/sha256/" + body["config"]["digest"].split(":")[1]).read()
    assert sha(config_data) == body["config"]["digest"].split(":")[1]
    supplier_config = json.loads(config_data)
with tarfile.open(rootfs, "r:gz" if args.compressed_rootfs else "r:") as archive:
    for entry in archive:
        p = pathlib.PurePosixPath(entry.name)
        if p.is_absolute() or ".." in p.parts:
            raise SystemExit("R3_EXPORTED_ROOTFS_PATH_INVALID: " + entry.name)
raw_digest = hashlib.sha256()
compressed = rootfs if args.compressed_rootfs else out / "rootfs.tar.gz"
if args.compressed_rootfs:
    with gzip.open(rootfs, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            raw_digest.update(chunk)
else:
    with rootfs.open("rb") as source, compressed.open("wb") as destination:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=3, fileobj=destination, mtime=0) as encoder:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                raw_digest.update(chunk)
                encoder.write(chunk)
blob_digest = hashlib.sha256()
with compressed.open("rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        blob_digest.update(chunk)
layer_sha = blob_digest.hexdigest()
layer = {"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": "sha256:" + layer_sha,
         "size": compressed.stat().st_size}
manifests = []
blobs = {}
created = datetime.now(timezone.utc).isoformat()
for role in ["api", "worker"]:
    config = copy.deepcopy(supplier_config)
    config["created"] = created
    config["rootfs"] = {"type": "layers", "diff_ids": ["sha256:" + raw_digest.hexdigest()]}
    config["history"] = [{"created": created,
        "created_by": "Current immutable source copied into pinned supplier; actual Linux Next build; stopped filesystem export",
        "comment": "Ordinary engineering only; original failed builds retained; no protected admission"}]
    cfg = config["config"]
    cfg["User"] = "node"
    cfg["WorkingDir"] = "/app/finnor-os"
    cfg["Env"] = [s for s in cfg["Env"] if not s.startswith("PORT=")]
    cfg["Env"].append("PORT=" + ("3100" if role == "api" else "8090"))
    cfg["ExposedPorts"] = {("3100" if role == "api" else "8090") + "/tcp": {}}
    cfg["Cmd"] = (["node", "--import=tsx", "node_modules/next/dist/bin/next", "start", "apps/api",
                   "--hostname", "0.0.0.0", "--port", "3100"] if role == "api"
                  else ["node_modules/.bin/tsx", "apps/worker/src/index.ts"])
    cfg.pop("Healthcheck", None)
    if role == "worker":
        cfg["Healthcheck"] = {"Test": ["CMD", "node", "-e",
            "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
            "Interval": 30000000000, "Timeout": 5000000000, "StartPeriod": 30000000000, "Retries": 3}
    config_bytes = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    config_sha = sha(config_bytes)
    blobs[config_sha] = config_bytes
    manifest = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
                           "digest": "sha256:" + config_sha, "size": len(config_bytes)}, "layers": [layer]}
    manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    manifest_sha = sha(manifest_bytes)
    blobs[manifest_sha] = manifest_bytes
    tag = "finnor-r3-" + role + ":" + args.tag_suffix
    manifests.append({"mediaType": manifest["mediaType"], "digest": "sha256:" + manifest_sha,
                      "size": len(manifest_bytes), "platform": {"os": "linux", "architecture": "amd64"},
                      "annotations": {"org.opencontainers.image.ref.name": tag,
                                      "io.containerd.image.name": tag}})
index = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": manifests}
with tarfile.open(out / "r3-current-api-worker.oci.tar", "w") as archive:
    write_member(archive, "oci-layout", b'{"imageLayoutVersion":"1.0.0"}')
    write_member(archive, "index.json", json.dumps(index, sort_keys=True, separators=(",", ":")).encode())
    for digest, data in blobs.items():
        write_member(archive, "blobs/sha256/" + digest, data)
    info = tarfile.TarInfo("blobs/sha256/" + layer_sha)
    info.size = compressed.stat().st_size
    info.mode = 0o644
    with compressed.open("rb") as source:
        archive.addfile(info, source)
(out / "image-manifest.json").write_text(json.dumps({"schema": "finnor.r3.installed-source-image.v1",
    "createdAt": created, "supplierArchive": str(supplier), "rootfs": str(rootfs),
    "rootfsDiffId": "sha256:" + raw_digest.hexdigest(), "layer": layer, "images": manifests,
    "sourceCut": "source-cut.json", "protectedAdmission": False,
    "qualification": "EXPORTED_ACTUAL_LINUX_COMPILATION_REQUIRES_FINAL_NONROOT_OWNER_EXECUTION"}, indent=2) + "\n")
print(json.dumps({"archive": str(out / "r3-current-api-worker.oci.tar"), "images": manifests}))
