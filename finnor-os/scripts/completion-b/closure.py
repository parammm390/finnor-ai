"""Byte-level local run closure, not installation or protected runtime qualification."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time

repo = Path(__file__).resolve().parents[3]
cache_directories = {"__pycache__", ".npm-cache", ".m4-preflight-postgres", ".cache"}
vitest_results = re.compile(r"^\.vite/vitest/[a-f0-9]{40}/results\.json$")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def identity(path):
    info = path.lstat()
    name = str(path.relative_to(repo)) if path.is_relative_to(repo) else str(path)
    if stat.S_ISLNK(info.st_mode):
        row = {"path": name, "target": os.readlink(path), "resolved": str(path.resolve(strict=True))}
        if path.is_file():
            row.update(sha256=digest(path), bytes=path.stat().st_size)
        return row
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError("Nonregular closure input: " + name)
    return {"path": name, "sha256": digest(path), "bytes": info.st_size, "mode": stat.S_IMODE(info.st_mode)}


def snapshot(path_environment):
    began = time.monotonic()
    tracked = subprocess.run(
        ["git", "-C", str(repo), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        check=True, stdout=subprocess.PIPE).stdout.decode().split("\0")
    source_names = sorted({name for name in tracked if name and (
        name.startswith(("finnor-os/packages/", "finnor-os/apps/", "finnor-os/scripts/", "src/",
                         "scripts/", "e2e/", "scope-pm/completion-b/migrations/"))
        or "/" not in name or name in (
            "finnor-os/package.json", "finnor-os/package-lock.json", "finnor-os/tsconfig.json",
            "finnor-os/tsconfig.base.json", "scope-pm/completion-b/failure-model.md",
            "scope-pm/completion-b/requirements.json"))
        and not any(part in cache_directories or part == "node_modules" for part in Path(name).parts)
        and not name.endswith(".tsbuildinfo")})
    sources = [identity(repo / name) for name in source_names if (repo / name).is_file() or (repo / name).is_symlink()]
    runtime, runtime_metadata = [], []
    for root in ("node_modules", "finnor-os/node_modules", ".runtime"):
        for directory, directories, files in os.walk(repo / root, followlinks=False):
            directories[:] = sorted(name for name in directories if name not in cache_directories)
            for name in list(directories):
                path = Path(directory) / name
                if path.is_symlink():
                    runtime.append(identity(path))
                    directories.remove(name)
            for name in sorted(files):
                if name.endswith((".pyc", ".tsbuildinfo")):
                    continue
                path = Path(directory) / name
                if vitest_results.fullmatch(path.relative_to(repo / root).as_posix()):
                    runtime_metadata.append(identity(path))
                else:
                    runtime.append(identity(path))
    node = shutil.which("node", path=path_environment)
    if not node:
        raise RuntimeError("Actual Node executable is unavailable")
    executables = [identity(Path(node)), identity(repo / ".runtime/m4-numerics-312/bin/python")]
    runtime.sort(key=lambda row: row["path"])
    body = {"schema": "finnor.completion-b.local-run-closure.v1",
            "baseCommit": subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip(),
            "sources": sources, "runtime": runtime, "executables": executables,
            "excludedRegenerableRuntime": sorted(cache_directories) + [
                "*.pyc", "*.tsbuildinfo", "node_modules/.vite/vitest/<40-hex>/results.json"],
            "qualification": "LOCAL_BYTES_AND_DEPENDENCY_LINKS_NOT_CLEAN_INSTALL_ISOLATION_OR_ADMISSION"}
    body["closureDigest"] = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    body["regenerableRuntimeMetadata"] = sorted(runtime_metadata, key=lambda row: row["path"])
    body["captureWallMs"] = (time.monotonic() - began) * 1000
    return body


def save(path, body):
    with path.open("x") as stream:
        json.dump(body, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")


def compare(before, after):
    changed = {}
    for group in ("sources", "runtime", "executables"):
        old = {row["path"]: row for row in before[group]}
        new = {row["path"]: row for row in after[group]}
        changed[group] = [name for name in sorted(old.keys() | new.keys()) if old.get(name) != new.get(name)]
    old_metadata = {row["path"]: row for row in before.get("regenerableRuntimeMetadata", [])}
    new_metadata = {row["path"]: row for row in after.get("regenerableRuntimeMetadata", [])}
    return {"status": "PASS" if before["baseCommit"] == after["baseCommit"] and not any(changed.values()) else "FAIL",
            "beforeDigest": before["closureDigest"], "afterDigest": after["closureDigest"],
            "baseCommitUnchanged": before["baseCommit"] == after["baseCommit"], "changedPaths": changed,
            "sourceFiles": len(before["sources"]), "runtimeFiles": len(before["runtime"]),
            "captureWallMs": before["captureWallMs"] + after["captureWallMs"],
            "changedRegenerableRuntimeMetadata": [
                name for name in sorted(old_metadata.keys() | new_metadata.keys())
                if old_metadata.get(name) != new_metadata.get(name)],
            "costUSD": None, "qualification": before["qualification"]}
