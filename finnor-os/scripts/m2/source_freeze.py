"""Independent complete Git-source byte/mode observation before and after E2E.

Dependencies have their separate installed-file manifests. Generated Next build
output is observed by the browser runner, and is not implementation source.
"""
import gzip
import hashlib
import json
import os
import pathlib
import stat
import subprocess
from datetime import datetime, timezone

EXCLUDED = ("node_modules/", "finnor-os/node_modules/", ".next/", "finnor-os/apps/api/.next/", "finnor-os/apps/console/.next/")


def _git(repo, *args):
    return subprocess.check_output(["git", *args], cwd=repo)


def observe(repo):
    paths = sorted(set(_git(repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z").split(b"\0")) - {b""})
    entries = []
    for raw in paths:
        relative = os.fsdecode(raw)
        if relative.startswith(EXCLUDED) or relative.endswith((".tsbuildinfo", ".pyc")) or "/__pycache__/" in relative:
            continue
        path = repo / relative
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            entries.append({"path": relative, "kind": "MISSING"})
            continue
        if stat.S_ISLNK(metadata.st_mode):
            target = os.readlink(path)
            entries.append({"path": relative, "kind": "SYMLINK", "mode": stat.S_IMODE(metadata.st_mode),
                            "target": target, "sha256": hashlib.sha256(os.fsencode(target)).hexdigest()})
        elif stat.S_ISREG(metadata.st_mode):
            entries.append({"path": relative, "kind": "FILE", "mode": stat.S_IMODE(metadata.st_mode),
                            "bytes": metadata.st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        else:
            raise RuntimeError("Non-regular implementation source: " + relative)
    content = json.dumps(entries, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    return {"schema": "finnor.m2.complete-source-freeze.v1", "observedAt": datetime.now(timezone.utc).isoformat(),
            "repo": str(repo), "commit": _git(repo, "rev-parse", "HEAD").decode().strip(),
            "tree": _git(repo, "rev-parse", "HEAD^{tree}").decode().strip(), "entries": entries,
            "sourceDigest": hashlib.sha256(content).hexdigest(), "fileCount": len(entries),
            "excludedGeneratedOutputPrefixes": EXCLUDED,
            "runtimeQualification": "Installed dependencies and actual executables are bound by separate immutable runtime manifests; no protected image attestation"}


def freeze(repo, output):
    observation = observe(pathlib.Path(repo))
    (pathlib.Path(output) / "complete-source-pre.json.gz").write_bytes(gzip.compress(json.dumps(observation, indent=2).encode(), mtime=0))
    return observation


def verify(repo, output, before):
    after = observe(pathlib.Path(repo))
    old = {entry["path"]: entry for entry in before["entries"]}
    new = {entry["path"]: entry for entry in after["entries"]}
    changes = [path for path in sorted(old.keys() | new.keys()) if old.get(path) != new.get(path)]
    passed = not changes and before["commit"] == after["commit"] and before["tree"] == after["tree"]
    (pathlib.Path(output) / "complete-source-post.json.gz").write_bytes(gzip.compress(json.dumps(after, indent=2).encode(), mtime=0))
    receipt = {"schema": "finnor.m2.source-stability.v1", "status": "PASS" if passed else "FAIL",
               "beforeDigest": before["sourceDigest"], "afterDigest": after["sourceDigest"],
               "beforeCommit": before["commit"], "afterCommit": after["commit"],
               "beforeTree": before["tree"], "afterTree": after["tree"], "changedPaths": changes,
               "fileCount": after["fileCount"]}
    (pathlib.Path(output) / "complete-source-stability.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt
