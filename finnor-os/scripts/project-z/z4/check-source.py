"""Run one existing graph check under the shared heavy lock, retaining exits."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--check", required=True, choices=["backend", "scripts", "panel"])
    args = parser.parse_args()
    if not all(p.is_absolute() for p in [args.repository, args.node, args.evidence]):
        raise ValueError("Z4_ABSOLUTE_PATHS_REQUIRED")
    args.evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    project = {"backend": "tsconfig.json",
               "scripts": "scripts/project-z/z4/tsconfig.scripts.json",
               "panel": "scripts/project-z/z4/tsconfig.frontend.json"}[args.check]
    compiler = args.repository / "finnor-os/node_modules/typescript/bin/tsc"
    command = [str(args.node), str(compiler), "--project", project,
               "--noEmit", "--incremental", "false"]
    report = {"schema": "finnor.z4.graph-check.v1", "check": args.check,
              "command": command, "nativeOwner": "NOT_RUN", "status": "RUNNING"}
    start = time.monotonic()
    with Path("/home/factory-user/repos/finnor-z-shared-heavy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        report["lockWaitMs"] = round((time.monotonic() - start) * 1000)
        files = sorted(p for root in [
            "finnor-os/packages/epistemic-runtime/src/project-z/z4-execution-proof",
            "finnor-os/packages/private-equity/src/project-z/z4-execution-proof",
            "finnor-os/packages/orchestration/src/project-z/z4-execution-proof",
            "finnor-os/scripts/project-z/z4"
        ] for p in (args.repository / root).rglob("*")
            if p.is_file() and p.suffix in [".ts", ".tsx", ".mts", ".json"])
        inventory = lambda: [{"path": str(p.relative_to(args.repository)),
                              "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
        report["source"] = inventory()
        report["sourceDigest"] = hashlib.sha256(
            json.dumps(report["source"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with (args.evidence / "process.log").open("xb") as log:
            run_start = time.monotonic()
            result = subprocess.run(command, cwd=args.repository / "finnor-os",
                                    env={**os.environ, "NODE_OPTIONS": "--max-old-space-size=4096"},
                                    stdout=log, stderr=subprocess.STDOUT, timeout=1800)
        report.update(exit=result.returncode, processWallMs=round((time.monotonic() - run_start) * 1000),
                      sourceUnchanged=report["source"] == inventory())
    report["status"] = "PASSED_SOURCE_GRAPH_ONLY" if report["exit"] == 0 and report["sourceUnchanged"] else "FAILED"
    report["logSha256"] = hashlib.sha256((args.evidence / "process.log").read_bytes()).hexdigest()
    (args.evidence / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ["check", "status", "exit", "sourceDigest"]}), flush=True)
    return 0 if report["status"] == "PASSED_SOURCE_GRAPH_ONLY" else 1


if __name__ == "__main__":
    raise SystemExit(main())
