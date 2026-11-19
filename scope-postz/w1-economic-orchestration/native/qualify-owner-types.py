"""Finite existing-owner type closure with independently retained source hashes."""
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import time

CONFIGURATIONS = ["scope-postz/w1-economic-orchestration/native-integrated-tsconfig.json",
    "scope-postz/w1-economic-orchestration/read-tsconfig.json",
    "finnor-os/tsconfig.json", "finnor-os/tsconfig.base.json"]
# One complete-typecheck bound carried by the subprocess budget, the receipt
# field, and the compilerClosureQualified gate; all three must agree.
COMPLETE_LIMIT_SECONDS = 120


def source_snapshot(root):
    retired = "finnor-os/packages/private-equity/src/economic-reads/contracts.ts"
    candidates = subprocess.check_output(["git", "-C", str(root), "ls-files",
        "--cached", "--others", "--exclude-standard", "--", "finnor-os/packages",
        "finnor-os/apps", "finnor-os/scripts"], text=True).splitlines()
    paths = sorted(set(p for p in candidates if p != retired
        and Path(p).suffix in {".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".py", ".sql", ".json"}
        and not any(part in {"node_modules", ".next", "dist", "__pycache__"} for part in Path(p).parts)))
    return [{"path": p, "sha256": hashlib.sha256((root / p).read_bytes()).hexdigest()}
        for p in paths]


def compiler_paths(log):
    paths = set()
    for line in log.read_text().splitlines():
        path = Path(line.strip())
        if path.is_absolute() and path.is_file():
            paths.add(str(path))
    if not paths:
        raise RuntimeError("ACTUAL_COMPILER_FILE_LIST_REQUIRED")
    return sorted(paths)


def resolution_manifests(paths):
    """Package manifests consulted during module/type resolution of the closure.

    --listFiles omits manifests (they are not source files), and ancestor metadata
    covers only manifests above compiler-listed files. A bare import resolved via
    node_modules/@types/<name> also consults node_modules/<name>/package.json (its
    types/exports fields) before the @types fallback, so record that manifest too:
    editing it redirects future compiles and must invalidate custody (H12).
    """
    manifests = set()
    for value in paths:
        parts = Path(value).parts
        if "node_modules" not in parts:
            continue
        anchor = len(parts) - 1 - parts[::-1].index("node_modules")
        rest = parts[anchor + 1:]
        if not rest:
            continue
        if rest[0].startswith("@") and len(rest) > 1:
            package_dir = Path(*parts[:anchor + 1], rest[0], rest[1])
        else:
            package_dir = Path(*parts[:anchor + 1], rest[0])
        manifests.add(package_dir / "package.json")
        if rest[0] == "@types" and len(rest) > 1:
            if "__" in rest[1]:
                scope, bare = rest[1].split("__", 1)
                manifests.add(Path(*parts[:anchor + 1], "@" + scope, bare) / "package.json")
            else:
                manifests.add(Path(*parts[:anchor + 1], rest[1]) / "package.json")
    return manifests

def compiler_snapshot(root, paths):
    compiler = root / "finnor-os/node_modules/typescript"
    required = {Path(p) for p in paths} | {root / p for p in CONFIGURATIONS}
    required.update({root / "package-lock.json", root / "finnor-os/package-lock.json",
        Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True), compiler / "bin/tsc",
        compiler / "package.json", Path(__file__).resolve()})
    required.update(path for path in (compiler / "lib").rglob("*")
        if path.is_file() and path.suffix in {".js", ".json"})
    # Package metadata affects module/type resolution. Record absent ancestor
    # manifests too, so adding one invalidates subsequent custody validation,
    # and record consulted-but-unlisted resolution manifests for every imported
    # package (including the runtime manifest behind an @types fallback, H12).
    metadata = {parent / "package.json" for value in paths for parent in Path(value).parents}
    metadata |= resolution_manifests(paths)
    result = []
    for path in sorted(required | metadata):
        if not path.is_file():
            if path in required:
                raise RuntimeError("COMPILER_INPUT_DISAPPEARED: " + str(path))
            result.append({"path": str(path), "missing": True})
        else:
            result.append({"path": str(path), "resolvedPath": str(path.resolve()),
                "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("number", type=int)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    scope = root / "scope-postz/w1-economic-orchestration"
    prefix = scope / f"evidence/native-integrated-typecheck-{args.number:04d}"
    log, receipt = Path(str(prefix) + ".log"), Path(str(prefix) + ".json")
    listing = Path(str(prefix) + ".list-files.log")
    if any(path.exists() for path in (log, receipt, listing)):
        raise RuntimeError("NEW_TYPECHECK_ATTEMPT_REQUIRED")
    retired = "finnor-os/packages/private-equity/src/economic-reads/contracts.ts"
    if (root / retired).exists():
        raise RuntimeError("RETIRED_FORWARDER_REAPPEARED")

    started_at = datetime.now(timezone.utc).isoformat()
    start = time.monotonic()
    configurations = CONFIGURATIONS
    configuration_files = [{"path": p, "sha256": hashlib.sha256((root / p).read_bytes()).hexdigest()}
        for p in configurations]
    before = source_snapshot(root)
    command = [str(Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True)),
        str(root / "finnor-os/node_modules/typescript/bin/tsc"), "--noEmit", "--listFiles", "--pretty", "false",
        "--project", str(root / configurations[0])]
    discovery = [command[0], command[1], "--listFilesOnly", "--pretty", "false",
        "--project", str(root / configurations[0])]
    environment = {key: value for key, value in os.environ.items()
        if key in {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "NODE_OPTIONS"}}
    def interrupted(_signal, _frame):
        raise InterruptedError("OWNED_TYPECHECK_INTERRUPTED")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    def run(arguments, destination):
        remaining = COMPLETE_LIMIT_SECONDS - (time.monotonic() - start) - 10
        if remaining <= 0:
            raise TimeoutError("COMPLETE_TYPECHECK_BOUND_EXHAUSTED")
        child = None
        try:
            with destination.open("xb") as output:
                child = subprocess.Popen(arguments, cwd=root / "finnor-os", stdout=output,
                    stderr=subprocess.STDOUT, env=environment, start_new_session=True)
                return child.wait(timeout=remaining)
        finally:
            if child is not None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=5)

    code, discovery_code, timed_out, failure = None, None, False, None
    before_paths, after_paths, compiler_before, compiler_after = [], [], [], []
    try:
        discovery_code = run(discovery, listing)
        if discovery_code != 0:
            raise RuntimeError("COMPILER_CLOSURE_DISCOVERY_FAILED")
        before_paths = compiler_paths(listing)
        compiler_before = compiler_snapshot(root, before_paths)
        code = run(command, log)
        after_paths = compiler_paths(log)
        compiler_after = compiler_snapshot(root, after_paths)
    except Exception as error:
        failure = str(error)
        timed_out = isinstance(error, (subprocess.TimeoutExpired, TimeoutError))
    if not log.exists():
        log.write_text("TYPECHECK_NOT_STARTED: " + str(failure) + "\n")
    after = source_snapshot(root)
    configuration_changed = any(hashlib.sha256((root / p["path"]).read_bytes()).hexdigest()
        != p["sha256"] for p in configuration_files)
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    compiler_changed = not before_paths or before_paths != after_paths or compiler_before != compiler_after
    elapsed = time.monotonic() - start
    result = {"schema": "finnor.w1.strict-owner-check.v1", "startedAt": started_at,
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "wallSeconds": elapsed, "command": command, "completeLimitSeconds": COMPLETE_LIMIT_SECONDS,
        "exitCode": code, "timedOut": timed_out, "failure": failure,
        "config": configurations[0], "configSha256": configuration_files[0]["sha256"],
        "configurationFiles": configuration_files, "log": str(log.relative_to(root)),
        "logSha256": hashlib.sha256(log.read_bytes()).hexdigest(),
        "sourceChangedDuringCheck": before != after or configuration_changed or compiler_changed,
        "compilerClosureQualified": code == discovery_code == 0 and not compiler_changed
            and not configuration_changed and before == after and elapsed < COMPLETE_LIMIT_SECONDS and failure is None,
        "compilerClosure": {"discoveryCommand": discovery, "discoveryExitCode": discovery_code,
            "listing": str(listing.relative_to(root)),
            "listingSha256": hashlib.sha256(listing.read_bytes()).hexdigest() if listing.exists() else None,
            "sourcePaths": before_paths, "actualCheckedSourcePaths": after_paths,
            "files": compiler_before, "unchangedAfterCompiler": not compiler_changed,
            "scope": "Actual pre-discovery and compiler-listed files, compiler/runtime bytes, configurations, lockfiles and ancestor package metadata"},
        "sourceFiles": before, "childUserSeconds": usage.ru_utime,
        "childSystemSeconds": usage.ru_stime, "childMaxRss": usage.ru_maxrss,
        "childMaxRssUnit": "bytes" if sys.platform == "darwin" else "KiB",
        "completeDescendantUsage": None, "billingUSD": None, "humanSeconds": None}
    with receipt.open("x") as output:
        json.dump(result, output, indent=2)
        output.write("\n")
    print(json.dumps({k: result[k] for k in ("exitCode", "timedOut",
        "sourceChangedDuringCheck", "wallSeconds", "childMaxRss")}))
    return 0 if result["compilerClosureQualified"] else 1


if __name__ == "__main__":
    sys.exit(main())
