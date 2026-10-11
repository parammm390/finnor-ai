"""Seal the supported installed delivery, including dependencies and licences.

The archive preserves exact absolute layout because accepted module/owner pins
bind that layout. Restore only into absent paths, then run package-runtime.py and
the registered conformance with the delivered Node. No installer or root access.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument("--manifest", required=True)
parser.add_argument("--fallback-python", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
manifest = pathlib.Path(args.manifest).resolve(strict=True)
identity = json.loads(manifest.read_text())
output = pathlib.Path(args.output).resolve()
if output.exists():
    raise SystemExit("Refusing to overwrite a sealed runtime")
roots = {pathlib.Path(identity["userHome"]).resolve(),
         pathlib.Path(identity["racket"]["path"]).parent.parent.resolve(),
         pathlib.Path(identity["python"]["path"]).parent.parent.resolve(),
         pathlib.Path(identity["node"]["path"]).resolve().parent.parent}
fallback = pathlib.Path(args.fallback_python).absolute()
for executable in [identity["python"]["path"], str(fallback)]:
    base = subprocess.check_output([executable, "-I", "-B", "-c",
                                    "import sys;print(sys.base_prefix)"], text=True).strip()
    roots.add(pathlib.Path(base).resolve(strict=True))
roots.add(fallback.parent.parent.resolve(strict=True))
for pin in identity["inventory"]:
    path = pathlib.Path(pin["path"])
    if path.stat().st_size != pin["bytes"] or hashlib.sha256(path.read_bytes()).hexdigest() != pin["sha256"]:
        raise SystemExit("Sealed inventory changed: " + str(path))
    if "/rosette/" in str(path):
        roots.add(pathlib.Path(str(path).split("/rosette/")[0]) / "rosette")
roots = sorted(roots, key=str)
output.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(output, "w:gz", compresslevel=1) as archive:
    for root in roots:
        if not any(root != other and root.is_relative_to(other) for other in roots):
            archive.add(root, arcname=str(root).lstrip("/"),
                        filter=lambda entry: None if entry.name.endswith(".DS_Store") else entry)
    archive.add(manifest, arcname="finnor-runtime-manifest.json")
digest = hashlib.sha256()
with output.open("rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
receipt = {"schema":"finnor.r8.supported-runtime-archive.v1","sha256":digest.hexdigest(),
           "bytes":output.stat().st_size,"roots":[str(root) for root in roots],
           "manifestSha256":hashlib.sha256(manifest.read_bytes()).hexdigest(),
           "qualification":"SUPPORTED_MACOS_ARM64_INSTALLED_BYTES_NOT_LINUX_OR_PROTECTED",
           "restoreRule":"Verify archive hash; restore only absent exact paths; never overwrite user files."}
output.with_suffix(output.suffix + ".json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
