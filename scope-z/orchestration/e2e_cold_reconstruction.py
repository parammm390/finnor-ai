#!/usr/bin/env python3
"""Real offline CLI reconstruction on a new independently copied source target."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import uuid


ROOT = Path(__file__).absolute().parents[2]
BASE = "7bfdd2d3ab611c90f1355637858824ff1ba67f98"
PACK_SHA = "4419731d2544d1c07fe275ec8071d5d783273942ca9947eda2ff6b4e2dffb9db"
ARCHIVE_SHA = "c6c5868a077346e61f50dea1d4fe77682a8c6e70a658a8e863752fb59cd52703"
HISTORY = "scope-z/prompts/reusable-blueprint.draft.md"
HISTORY_SHA = "2bfa64f0cb40f7891d647eea962443d2883417b82731b262066895d0781a213f"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def extract(archive, target, bootstrap=False):
    with tarfile.open(archive, "r:gz") as source:
        entries = source.getmembers()
        if bootstrap:
            assert len(entries) == 1 and entries[0].name == HISTORY
        for row in entries:
            path = PurePosixPath(row.name)
            assert row.isfile() and not path.is_absolute() and ".." not in path.parts
            assert str(path) == row.name and 0 <= row.size <= 32 * 1024 * 1024
            body = source.extractfile(row).read()
            if bootstrap:
                assert len(body) == 43440 and digest(body) == HISTORY_SHA
            dest = target / row.name
            assert not any(parent.is_symlink() for parent in dest.parents)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                assert dest.is_file() and not dest.is_symlink() and dest.read_bytes() == body
            else:
                with dest.open("xb") as out:
                    out.write(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bootstrap-archive", type=Path)
    args = parser.parse_args()
    archive = ROOT / "scope-z/orchestration/evidence/project-z-execution-pack-1.0.0.tar.gz"
    assert digest(archive.read_bytes()) == ARCHIVE_SHA
    if args.bootstrap_archive:
        assert args.bootstrap_archive.is_absolute()
    run = ROOT / "scope-z/orchestration/evidence" / ("cold-reconstruction-" + uuid.uuid4().hex)
    run.mkdir()
    target = run / "checkout"
    report = {
        "schemaVersion": "finnor.project-z.cold-context-e2e.v1",
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "evidenceClass": "offline-context-and-local-controller-only",
        "sourceBase": BASE,
        "executionPackSha256": PACK_SHA,
        "archiveSha256": ARCHIVE_SHA,
        "bootstrapArchive": None,
        "gitCloneMode": "--no-local --no-checkout",
        "dependenciesInstalled": False,
        "nodeModulesBorrowed": False,
        "remoteDeliveryProven": False,
        "productInstalledRuntimeProven": False,
        "steps": [],
        "result": "FAILED",
    }
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG") if key in os.environ}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1")

    def command(name, argv, cwd):
        result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True,
                                text=True, timeout=120)
        row = {"name": name, "argv": argv, "cwd": str(cwd),
               "exitCode": result.returncode, "stdout": result.stdout,
               "stderr": result.stderr}
        report["steps"].append(row)
        return result.returncode == 0

    try:
        assert command("independent-source-copy",
                       ["git", "clone", "--no-local", "--no-checkout", "--single-branch",
                        "--branch", "factory/project-z-contracts", str(ROOT), str(target)], ROOT)
        assert command("pinned-source-checkout",
                       ["git", "checkout", "--detach", BASE], target)
        assert not (target / "node_modules").exists()
        assert not (target / "finnor-os/node_modules").exists()
        objects = subprocess.run(["git", "rev-parse", "--git-path", "objects/info/alternates"],
                                 cwd=target, env=env, check=True, capture_output=True,
                                 text=True).stdout.strip()
        alternate = Path(objects)
        assert not (alternate if alternate.is_absolute() else target / alternate).exists()
        extract(archive, target)
        if args.bootstrap_archive:
            extract(args.bootstrap_archive, target, bootstrap=True)
            report["bootstrapArchive"] = {
                "path": str(args.bootstrap_archive),
                "sha256": digest(args.bootstrap_archive.read_bytes()),
                "preimage": HISTORY, "preimageSha256": HISTORY_SHA,
            }
        assert digest((target / "scope-z/locks/execution-pack.json").read_bytes()) == PACK_SHA
        checks = [
            ("actual-prompt-assembler-check",
             [sys.executable, str(target / "scope-z/prompts/assemble.py"), "check"]),
            ("actual-execution-builder-check",
             [sys.executable, str(target / "scope-z/orchestration/build_execution_pack.py"), "--check"]),
            ("actual-nonfixture-controller-verify",
             [sys.executable, str(target / "scope-z/orchestration/control.py"),
              "--root", str(target), "--state", str(target / "scope-z/orchestration/live-state"),
              "--execution-pack-digest", PACK_SHA, "verify"]),
        ]
        for name, argv in checks:
            if not command(name, argv, target):
                raise RuntimeError(name + " failed; target and original failure retained")
        report["result"] = "PASSED"
    except Exception as error:
        report["failure"] = f"{type(error).__name__}: {error}"
    report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    path = run / "report.json"
    with path.open("x") as out:
        json.dump(report, out, indent=2)
        out.write("\n")
    print(json.dumps({"report": str(path), "result": report["result"],
                      "bootstrapSupplied": args.bootstrap_archive is not None,
                      "steps": len(report["steps"])}))
    return 0 if report["result"] == "PASSED" else 1


if __name__ == "__main__":
    sys.exit(main())
