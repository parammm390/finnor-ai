"""Freeze only exact original source bytes before dependency installation/build."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument("--installation", type=Path, required=True)
args = parser.parse_args()
installation = args.installation.resolve()
if "/scope-z/phase-evidence/z0/" not in str(installation):
    raise SystemExit("Z0_OWNED_SOURCE_ARCHIVE_REQUIRED")
manifest = json.loads((installation / "source-snapshot.json").read_text())
root = installation / "runtime"
if manifest["runtime"] != str(root):
    raise SystemExit("Z0_SOURCE_ARCHIVE_ROOT_MISMATCH")
archive = installation / "converged-source.tar.gz"
with archive.open("xb") as raw:
    with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as tar:
            for item in manifest["files"]:
                path = Path(item["path"])
                if path.is_absolute() or ".." in path.parts:
                    raise SystemExit("Z0_ARCHIVE_SOURCE_PATH_INVALID")
                body = (root / path).read_bytes()
                if hashlib.sha256(body).hexdigest() != item["sha256"]:
                    raise SystemExit("Z0_ARCHIVE_SOURCE_CHANGED:" + str(path))
                info = tarfile.TarInfo(str(path))
                info.size = len(body)
                info.mode = item["mode"]
                info.mtime = 0
                tar.addfile(info, io.BytesIO(body))
receipt = {
    "schema": "finnor.project-z.z0.frozen-source-archive.v1",
    "archive": archive.name,
    "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "bytes": archive.stat().st_size,
    "sourcePopulationSha256": manifest["sourcePopulationSha256"],
    "files": len(manifest["files"]),
    "dependencyTreesIncluded": False,
    "gitObjectsRequired": False,
    "native": "NOT_RUN",
}
with (installation / "source-archive.json").open("x") as target:
    json.dump(receipt, target, indent=2)
    target.write("\n")
print(json.dumps(receipt))
