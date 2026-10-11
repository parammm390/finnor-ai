#!/usr/bin/env python3
"""Finite R6 runner. Uses existing read-only dependencies; never installs.

Every invocation owns a NEW evidence directory. Failed output is retained.
Generated runtime/typecheck configs live only in that ignored directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deps", required=True, type=Path)
    parser.add_argument("--node", default="/Users/paramdave/.local/bin/node", type=Path)
    parser.add_argument("--case", choices=["runtime", "core", "typecheck"], default="core")
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    osroot = repo / "finnor-os"
    evidence = args.evidence.resolve()
    permitted = repo / "scope-r/r6-verified-capital-compiler/evidence-private"
    if permitted not in evidence.parents:
        raise SystemExit("Evidence must be inside the owned ignored evidence-private directory")
    if evidence.exists():
        raise SystemExit("Refusing to overwrite an earlier evidence attempt")
    evidence.mkdir(parents=True)
    dependencies = args.deps.resolve()
    lock = json.loads((osroot / "package-lock.json").read_text())
    inventory = []
    for name, module in (
        ("decimal.js", "decimal.mjs"), ("tsx", "dist/cli.mjs"),
        ("typescript", "bin/tsc"), ("esbuild", "lib/main.js"),
    ):
        package_file = dependencies / name / "package.json"
        package = json.loads(package_file.read_text())
        pinned = lock["packages"]["node_modules/" + name]
        if package["version"] != pinned["version"]:
            raise SystemExit("Actual dependency differs from pinned lock: " + name)
        inventory.append({
            "name": name, "version": package["version"], "license": package.get("license"),
            "packagePath": str(package_file), "packageSha256": digest(package_file),
            "modulePath": str(dependencies / name / module),
            "moduleSha256": digest(dependencies / name / module),
            "lockIntegrity": pinned.get("integrity"),
        })
    base = json.loads((osroot / "tsconfig.base.json").read_text())
    paths = base["compilerOptions"]["paths"].copy()
    paths["*"] = [str(dependencies / "*")]
    paths["decimal.js"] = [str(dependencies / "decimal.js/decimal.mjs")]
    runtime_config = {
        "extends": str(osroot / "tsconfig.base.json"),
        "compilerOptions": {"baseUrl": str(osroot), "paths": paths},
    }
    runtime_path = evidence / "runtime.tsconfig.json"
    runtime_path.write_text(json.dumps(runtime_config, indent=2) + "\n")
    type_paths = paths.copy()
    type_paths["decimal.js"] = [str(dependencies / "decimal.js/decimal.d.ts")]
    type_config = {
        "extends": str(osroot / "tsconfig.base.json"),
        "compilerOptions": {
            "baseUrl": str(osroot), "paths": type_paths, "noEmit": True,
            "typeRoots": [str(dependencies / "@types")], "types": ["node"],
        },
        "include": [
            str(osroot / "packages/epistemic-runtime/src/verified-capital-compiler/**/*.ts"),
            str(osroot / "packages/shared-types/src/decision-proof.ts"),
            str(osroot / "packages/private-equity/src/r6/**/*.ts"),
            str(osroot / "scripts/r6/*.mts"),
        ],
        "exclude": [str(dependencies)],
    }
    type_path = evidence / "typecheck.tsconfig.json"
    type_path.write_text(json.dumps(type_config, indent=2) + "\n")
    env = os.environ.copy()
    env.update({
        "R6_DEPS_ROOT": str(dependencies), "R6_REPOSITORY_ROOT": str(repo),
        "NODE_PATH": str(dependencies), "PYTHONDONTWRITEBYTECODE": "1",
        "TSX_DISABLE_CACHE": "1",
    })
    if args.case == "typecheck":
        command = [str(args.node), str(dependencies / "typescript/bin/tsc"),
                   "--project", str(type_path), "--noEmit"]
    else:
        command = [
            str(args.node), str(dependencies / "tsx/dist/cli.mjs"),
            "--tsconfig", str(runtime_path), str(osroot / "scripts/r6/run-e2e.mts"),
            "--case", args.case, "--evidence", str(evidence),
        ]
    start = time.monotonic()
    timed_out = False
    try:
        result = subprocess.run(command, cwd=osroot, env=env, capture_output=True,
                                text=True, timeout=1800)
        stdout, stderr, code = result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired as error:
        timed_out = True
        stdout = error.stdout or ""
        stderr = error.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        code = 124
    (evidence / "stdout.log").write_text(stdout)
    (evidence / "stderr.log").write_text(stderr)
    git = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                         check=True, capture_output=True, text=True).stdout.strip()
    receipt = {
        "schema": "finnor.r6.local-command.v1", "command": command, "cwd": str(osroot),
        "case": args.case, "exitCode": code, "timedOut": timed_out,
        "elapsedMs": round((time.monotonic() - start) * 1000), "head": git,
        "dependencyLockSha256": digest(osroot / "package-lock.json"),
        "dependencies": inventory, "nodePath": str(args.node), "nodeSha256": digest(args.node),
        "stdoutSha256": digest(evidence / "stdout.log"),
        "stderrSha256": digest(evidence / "stderr.log"),
        "usd": None, "aggregateSimultaneousPeakBytes": None,
        "evidenceDirectory": str(evidence),
    }
    (evidence / "command.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"case": args.case, "exitCode": code,
                      "evidence": str(evidence), "elapsedMs": receipt["elapsedMs"]}))
    return code


if __name__ == "__main__":
    sys.exit(main())
