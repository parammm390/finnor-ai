"""W2 cold packet producer: seal exact source, Git objects, cache and toolchain.

Creates one source/cache packet, with separately pinned toolchain and baseline.
No install, no native process, no remote write. Source archives have sorted
members and fixed metadata. The packet also records the actual sealing time.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import gzip
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve()
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location("w2_cold_packet", HERE.with_name("cold_packet.py"))
packet_lib = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = packet_lib
spec.loader.exec_module(packet_lib)
job = packet_lib.job
RETAINED_MIGRATION_BASE = "517003a4396bc8101a90be4b425ee01de9446740"


def git(source, *args, data=None):
    result = subprocess.run(["git", "-C", str(source), *args], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if result.returncode:
        raise RuntimeError("SEAL_SOURCE_GIT_OPERATION_FAILED:" + args[0])
    return result.stdout


class HashingReader:
    def __init__(self, stream):
        self.stream, self.digest = stream, hashlib.sha256()

    def read(self, size=-1):
        block = self.stream.read(size)
        self.digest.update(block)
        return block


def source_rows(source):
    tracked = git(source, "ls-files", "-z").decode().split("\0")
    untracked = git(source, "ls-files", "--others", "--exclude-standard", "-z").decode().split("\0")
    private_names = {".job-owner.json", ".campaign-owner.json", ".owner.json", ".process-group.json",
                     "mounted-private-fixture.json", "driver.log"}
    public_untracked = [name for name in untracked if name and Path(name).name not in private_names
                        and not Path(name).name.startswith(".env")
                        and Path(name).name not in {".npmrc", ".pypirc", ".git-credentials"}]
    names = sorted({name for name in tracked + public_untracked if name})
    committed = set(filter(None, git(source, "--no-replace-objects", "ls-tree", "-r",
                                     "--name-only", "-z", "HEAD").decode().split("\0")))
    if not committed.issubset(names):
        raise ValueError("TRACKED_SOURCE_FILES_MUST_NOT_BE_DROPPED")
    rows = []
    for name in names:
        if name in packet_lib.PUBLIC_NPM_CONFIGURATIONS:
            expected = packet_lib.PUBLIC_NPM_CONFIGURATIONS[name]
            row = {"path": name, **{key: expected[key] for key in ("bytes", "sha256", "mode")},
                   "publicConfiguration": {key: expected[key] for key in ("class", "gitBlob")}}
            packet_lib.verify_public_configuration(source, name, row)
            rows.append(row)
            continue
        packet_lib.source_path(name)
        path = source / name
        if not path.is_file() or path.is_symlink():
            raise ValueError("ONLY_REGULAR_SOURCE_FILES_SUPPORTED:" + name)
        info = path.lstat()
        if info.st_size > 268435456:
            raise ValueError("SOURCE_FILE_TOO_LARGE_TO_SEAL:" + name)
        rows.append({"path": name, "bytes": info.st_size, "sha256": job.sha(path),
                     "mode": stat.S_IMODE(info.st_mode)})
    packet_lib.validate_source_rows(rows)
    return rows


def seal_archive(source, rows, target):
    with target.open("xb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for row in rows:
                info = tarfile.TarInfo(row["path"])
                info.size, info.mode, info.mtime = row["bytes"], row["mode"], 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                with (source / row["path"]).open("rb") as stream:
                    reader = HashingReader(stream)
                    archive.addfile(info, reader)
                if reader.digest.hexdigest() != row["sha256"]:
                    raise RuntimeError("SOURCE_CHANGED_WHILE_SEALING:" + row["path"])
    return {"path": target.name, "bytes": target.stat().st_size, "sha256": job.sha(target)}


def seal_git_objects(source, commit, retained_base, target):
    objects = {commit, retained_base,
               git(source, "rev-parse", commit + "^{tree}").decode().strip(),
               git(source, "rev-parse", retained_base + "^{tree}").decode().strip()}
    listing = git(source, "ls-tree", "-r", "-t", commit).decode()
    for line in listing.splitlines():
        objects.add(line.split(None, 2)[2].split("\t")[0])
    chain = "finnor-os/packages/db/migrations".split("/")
    for depth in range(1, len(chain) + 1):
        prefix = "/".join(chain[:depth])
        objects.add(git(source, "rev-parse", retained_base + ":" + prefix).decode().strip())
    retained = git(source, "ls-tree", "-r", "-t", retained_base, "--", "/".join(chain)).decode()
    for line in retained.splitlines():
        objects.add(line.split(None, 2)[2].split("\t")[0])
    with target.open("xb") as stream:
        child = subprocess.Popen(["git", "-C", str(source), "pack-objects", "-q", "--stdout"],
                                 stdin=subprocess.PIPE, stdout=stream, stderr=subprocess.PIPE)
        try:
            _, error = child.communicate(("\n".join(sorted(objects)) + "\n").encode(), timeout=300)
        except BaseException:
            child.kill()
            child.wait(timeout=3)
            raise
    if child.returncode or not target.stat().st_size:
        raise RuntimeError("SEALED_SOURCE_OBJECT_PACK_FAILED")
    return {"path": target.name, "bytes": target.stat().st_size, "sha256": job.sha(target),
            "objectCount": len(objects), "objects": sorted(objects)}


def seal_cache(cache_root, target_dir):
    cache_root = Path(cache_root).resolve(strict=True)
    content = cache_root / "_cacache" / "content-v2"
    if not content.is_dir():
        raise ValueError("DECLARED_CACACHE_CONTENT_ROOT_REQUIRED")
    target_dir.mkdir(mode=0o700)
    assets = []
    for directory, _directories, files in os.walk(content, followlinks=False):
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                raise ValueError("CACHE_ASSETS_MUST_BE_REGULAR_FILES")
            rel = path.relative_to(cache_root).as_posix()
            row = {"path": rel, "bytes": path.lstat().st_size}
            destination = target_dir / rel
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            digest = hashlib.sha256()
            with path.open("rb") as src, destination.open("xb") as dst:
                while True:
                    block = src.read(1024 * 1024)
                    if not block:
                        break
                    digest.update(block)
                    dst.write(block)
            destination.chmod(0o444)
            row["sha256"] = digest.hexdigest()
            assets.append(row)
    if not assets:
        raise ValueError("DECLARED_NPM_PACKAGE_ASSETS_REQUIRED")
    return {"root": target_dir.name, "assets": sorted(assets, key=lambda row: row["path"])}


def seal_runtime(node, python, npm_cli):
    node = Path(node).resolve(strict=True)
    python = Path(python).resolve(strict=True)
    npm_cli = Path(npm_cli).resolve(strict=True)
    distribution = npm_cli.parent.parent
    if distribution.name != "npm" or npm_cli.name != "npm-cli.js":
        raise ValueError("DECLARED_NPM_CLI_INSIDE_ITS_DISTRIBUTION_REQUIRED")
    return {"platform": sys.platform, "architecture": os.uname().machine,
            "node": packet_lib.pin(node) | {"path": str(node)},
            "python": packet_lib.pin(python) | {"path": str(python)},
            "npmCli": packet_lib.pin(npm_cli) | {"path": str(npm_cli),
                "distributionRoot": str(distribution), "assets": packet_lib.population(distribution)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(ROOT))
    parser.add_argument("--output", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--baseline-native", required=True, help="Retained installed native evidence directory")
    parser.add_argument("--baseline-installation", required=True, help="Retained independently built backend")
    parser.add_argument("--npm-cli", required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--origin", required=True)
    parser.add_argument("--forecast-bytes", required=True, type=int)
    parser.add_argument("--retained-base", default=RETAINED_MIGRATION_BASE)
    args = parser.parse_args()
    source = Path(args.source)
    if any(component.is_symlink() for component in reversed((source, *source.parents))):
        raise ValueError("PUBLIC_CONFIGURATION_SYMLINK_REFUSED")
    source = source.resolve(strict=True)
    output = Path(args.output)
    if not output.is_absolute() or ".." in output.parts:
        raise ValueError("NEW_ABSOLUTE_PACKET_OUTPUT_REQUIRED")
    output.mkdir(mode=0o700)
    commit = git(source, "rev-parse", "HEAD").decode().strip()
    identity = {"commit": commit, "tree": git(source, "rev-parse", "HEAD^{tree}").decode().strip(),
                "dirty": git(source, "status", "--porcelain=v1", "-uall").decode()}
    rows = source_rows(source)
    if not any(row["path"] == "package-lock.json" for row in rows) \
            or not any(row["path"] == "finnor-os/package-lock.json" for row in rows):
        raise ValueError("BOTH_ORIGINAL_LOCKS_REQUIRED_TO_SEAL")
    archive = seal_archive(source, rows, output / "source.tar.gz")
    objects = seal_git_objects(source, commit, args.retained_base, output / "source-objects.pack")
    cache = seal_cache(args.cache, output / "cache-assets")
    baseline_root = Path(args.baseline_native).resolve(strict=True)
    installation = Path(args.baseline_installation).resolve(strict=True)
    packet_lib.verify_installation(installation)
    baseline = {"installationRoot": str(installation)}
    originals = {"manifest": installation / "finnor-os/w2-development-installation.json",
                 "nativeReport": baseline_root / "report.json", "nativeFreeze": baseline_root / "freeze.json",
                 "nativePositive": baseline_root / "positive-original-owner-chain.json",
                 "nativeCleanup": baseline_root / "cleanup.json",
                 "nativeCustody": baseline_root / "installed-source-custody-byte-change-and-restoration.json"}
    (output / "baseline").mkdir(mode=0o700)
    for name, path in originals.items():
        row = packet_lib.pin(path)
        destination = output / "baseline" / (name + ".json")
        with path.open("rb") as src, destination.open("xb") as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        packet_lib.verify_file(destination, row)
        destination.chmod(0o444)
        baseline[name] = row | {"path": destination.relative_to(output).as_posix()}
    packet = {"schema": packet_lib.SCHEMA, "sealedAt": datetime.now(timezone.utc).isoformat(),
              "source": {"files": rows, "identity": identity, "gitCommits": sorted({commit, args.retained_base})},
              "sourceArchive": archive, "sourceGitObjects": objects,
              "runtime": seal_runtime(args.node, sys.executable, args.npm_cli),
              "packageCache": cache, "baseline": baseline,
              "forecastNetNewBytes": args.forecast_bytes,
              "frontendOrigin": job.canonical_origin(args.origin),
              "qualification": "CONTROLLED_ENGINEERING_NOT_HUMAN_PROTECTED_FIELD_COMPARATIVE_OR_ECONOMIC"}
    manifest = output / "cold-packet.json"
    with os.fdopen(os.open(manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444), "w") as stream:
        stream.write(json.dumps(packet, indent=2) + "\n")
    digest = job.sha(manifest)
    packet_lib.inspect_packet(manifest, digest)
    if source_rows(source) != rows or git(source, "rev-parse", "HEAD").decode().strip() != commit:
        raise RuntimeError("SOURCE_CHANGED_DURING_SEAL")
    print(json.dumps({"status": "SEALED_AND_SELF_VERIFIED", "packet": str(manifest), "sha256": digest,
                      "sourceFiles": len(rows), "cacheAssets": len(cache["assets"]),
                      "gitObjects": objects["objectCount"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
