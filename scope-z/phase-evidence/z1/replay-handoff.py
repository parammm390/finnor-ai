"""Replay the packaged Z1 development kernel without a source checkout.

See handoff-packaging-contract.md. This is not installed FINNOR verification.
"""
import argparse
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time


def require(condition, code):
    if not condition:
        raise ValueError(code)


def stream_sha(stream):
    value = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(block)
    return value.hexdigest()


def sha(path):
    with path.open("rb") as stream:
        return stream_sha(stream)


def local(root, name):
    path = Path(name)
    require(not path.is_absolute() and ".." not in path.parts, "UNSAFE_ASSET_PATH")
    actual = (root / path).resolve()
    require(actual.is_relative_to(root.resolve()), "ASSET_ESCAPES_BUNDLE")
    return actual


def verify_assets(bundle, index):
    seen = set()
    for asset in index["assets"]:
        name = asset["path"]
        require(name not in seen, "DUPLICATE_ASSET")
        seen.add(name)
        path = local(bundle, name)
        require(path.is_file() and path.stat().st_size == asset["bytes"], "ASSET_LENGTH_MISMATCH")
        require(sha(path) == asset["sha256"], "ASSET_DIGEST_MISMATCH")
    required = {
        index["sourceArchive"]["path"], index["sourceInventory"],
        index["retainedEvidence"]["archive"], index["retainedEvidence"]["inventory"],
        index["referenceReport"],
    }
    require(required.issubset(seen), "UNINDEXED_REQUIRED_ASSET")
    source_archive = local(bundle, index["sourceArchive"]["path"])
    with gzip.open(source_archive, "rb") as stream:
        require(stream_sha(stream) == index["sourceArchive"]["tarSha256"], "SOURCE_TAR_MISMATCH")
    inventory = json.loads(local(bundle, index["retainedEvidence"]["inventory"]).read_text())
    expected = {entry["path"]: entry for entry in inventory["files"]}
    require(len(expected) == len(inventory["files"]), "DUPLICATE_EVIDENCE_INVENTORY")
    checked = set()
    archive = local(bundle, index["retainedEvidence"]["archive"])
    with tarfile.open(archive, "r|gz") as packed:
        for member in packed:
            require(member.isfile() and member.name in expected and member.name not in checked,
                    "UNEXPECTED_EVIDENCE_MEMBER")
            entry = expected[member.name]
            require(member.size == entry["bytes"], "EVIDENCE_LENGTH_MISMATCH")
            with packed.extractfile(member) as stream:
                require(stream_sha(stream) == entry["sha256"], "EVIDENCE_DIGEST_MISMATCH")
            checked.add(member.name)
    require(checked == set(expected), "MISSING_EVIDENCE_MEMBER")
    return {"assets": len(seen), "evidenceFiles": len(checked),
            "evidenceBytes": sum(entry["bytes"] for entry in expected.values())}


def replay(bundle, index, evidence, report):
    require(platform.system() == "Linux" and platform.machine() == "x86_64",
            "DECLARED_LINUX_X64_TARGET_REQUIRED")
    reference = json.loads(local(bundle, index["referenceReport"]).read_text())
    expected_toolchain = reference["toolchain"]
    node, npm = shutil.which("node"), shutil.which("npm")
    require(node is not None and npm is not None, "NODE22_AND_NPM_REQUIRED")
    require(sha(Path(node).resolve()) == expected_toolchain["nodeSha256"], "NODE_BINARY_CHANGED")
    require(sha(Path(sys.executable).resolve()) == expected_toolchain["pythonSha256"],
            "PYTHON_BINARY_CHANGED")
    temporary = Path(tempfile.mkdtemp(prefix="finnor-z1-packaged-"))
    report["temporaryTarget"] = str(temporary / "source")
    try:
        target = temporary / "source"
        target.mkdir()
        with tarfile.open(local(bundle, index["sourceArchive"]["path"])) as packed:
            packed.extractall(target, filter="data")
        require(not (target / ".git").exists() and not (target / "finnor-os/node_modules").exists(),
                "SOURCE_TARGET_NOT_FRESH")
        inventory = json.loads(local(bundle, index["sourceInventory"]).read_text())
        for entry in inventory["files"]:
            path = local(target, entry["path"])
            require(path.stat().st_size == entry["bytes"] and sha(path) == entry["sha256"],
                    "PACKAGED_PHASE_SOURCE_MISMATCH")
        require(sha(target / "finnor-os/package-lock.json") == reference["dependencyLockSha256"],
                "BACKEND_LOCK_CHANGED")
        home, cache = temporary / "home", temporary / "cache"
        home.mkdir()
        user_config, global_config = temporary / "user.npmrc", temporary / "global.npmrc"
        user_config.touch()
        global_config.touch()
        env = {
            "PATH": os.environ["PATH"], "HOME": str(home), "LANG": "C.UTF-8",
            "NODE_OPTIONS": "--max-old-space-size=1536", "PYTHONDONTWRITEBYTECODE": "1",
            "TSX_DISABLE_CACHE": "1", "FINNOR_Z1_SOURCE_COMMIT": index["sourceHead"],
            "FINNOR_Z1_SOURCE_TREE": index["sourceTree"], "npm_config_cache": str(cache),
            "npm_config_userconfig": str(user_config), "npm_config_globalconfig": str(global_config),
        }
        node_version = subprocess.check_output([node, "--version"], env=env, text=True).strip()
        npm_version = subprocess.check_output([npm, "--version"], env=env, text=True).strip()
        require(node_version == expected_toolchain["node"] and node_version.startswith("v22."),
                "NODE_VERSION_CHANGED")
        require(npm_version == expected_toolchain["npm"], "NPM_VERSION_CHANGED")
        report["environmentNames"] = sorted(env)
        report["toolchain"] = {
            "node": node_version, "nodeSha256": sha(Path(node).resolve()),
            "npm": npm_version, "python": sys.version.split()[0],
            "pythonSha256": sha(Path(sys.executable).resolve()),
        }
        report["sourceFilesChecked"] = len(inventory["files"])
        report["sourceCheckoutOverlay"] = False
        report["borrowedNodeModules"] = False

        def run(name, args, timeout):
            log = evidence / (name + ".log")
            start = time.monotonic()
            with log.open("xb") as output:
                child = subprocess.Popen(args, cwd=target / "finnor-os", env=env,
                                         stdout=output, stderr=subprocess.STDOUT,
                                         start_new_session=True)
                timed_out = False
                try:
                    code = child.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    code = child.wait(timeout=10)
            report["steps"].append({
                "name": name, "command": args, "pid": child.pid,
                "exitCode": code, "timedOut": timed_out,
                "wallMs": round((time.monotonic() - start) * 1000),
                "log": log.name, "logSha256": sha(log),
            })
            return code == 0 and not timed_out

        require(run("packaged-npm-ci", [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], 600),
                "PACKAGED_INSTALL_FAILED")
        installed = target / "finnor-os/node_modules"
        for package in ("tsx", "typescript", "zod"):
            require((installed / package).resolve().is_relative_to(target), "BORROWED_PACKAGE")
        assets = []
        for entry in reference["installedDependencyAssets"]:
            path = local(installed, entry["path"])
            actual = sha(path)
            require(actual == entry["sha256"], "INSTALLED_DEPENDENCY_ASSET_CHANGED")
            assets.append({"path": entry["path"], "sha256": actual})
        report["installedDependencyAssets"] = assets
        runner = target / "finnor-os/scripts/project-z/z1"
        kernel = target / "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work"
        processes = target / "finnor-os/packages/private-equity/src/project-z/z1-shared-work/processes.ts"
        checked = run("packaged-kernel-types", [
            node, str(installed / "typescript/bin/tsc"), "--noEmit", "--strict", "--noUncheckedIndexedAccess",
            "--skipLibCheck", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
            "--types", "node", str(kernel / "engine.ts"), str(kernel / "producer-child.ts"), str(processes),
        ], 120)
        checked = run("packaged-isolated-translation", [
            node, str(runner / "check-syntax.mjs"), str(evidence / "isolated-translation.json"),
        ], 120) and checked
        for name, script in (
            ("packaged-original-semantics", "verify.mjs"),
            ("packaged-process-edges", "edge-cases.mjs"),
            ("packaged-local-physical-recovery", "physical-recovery.mjs"),
        ):
            checked = run(name, [
                node, "--import", str(installed / "tsx/dist/loader.mjs"),
                str(runner / script), str(evidence / name),
            ], 240) and checked
        require(checked, "PACKAGED_DEVELOPMENT_CHECK_FAILED")
        original = json.loads((evidence / "packaged-original-semantics/report.json").read_text())
        edges = json.loads((evidence / "packaged-process-edges/report.json").read_text())
        recovery = json.loads((evidence / "packaged-local-physical-recovery/report.json").read_text())
        translation = json.loads((evidence / "isolated-translation.json").read_text())
        require(original["passed"] == 256 and original["failed"] == 0 and
                edges["passed"] == 31 and edges["failed"] == 0 and
                recovery["status"] == "PASSED" and len(recovery["results"]) == 3 and
                translation["status"] == "PASSED" and len(translation["records"]) == 7,
                "PACKAGED_COVERAGE_MISMATCH")
        report["coverage"] = {"originalSemantics": {"passed": 256, "failed": 0},
                              "processEdges": {"passed": 31, "failed": 0},
                              "localFileRecovery": 3, "isolatedTranslationFiles": 7}
        report["runtimeIdentity"] = edges["runtime"]["digest"]
    finally:
        shutil.rmtree(temporary)
        report["temporaryTargetRemoved"] = not temporary.exists()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path, help="New absolute evidence directory")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--heavy-lock", type=Path,
                        default=Path("/home/factory-user/repos/finnor-z-shared-heavy.lock"))
    args = parser.parse_args()
    require(args.evidence.is_absolute() and args.heavy_lock.is_absolute(), "ABSOLUTE_PATHS_REQUIRED")
    args.evidence.mkdir(mode=0o700)
    bundle = Path(__file__).resolve().parent
    report = {
        "schema": "finnor.z1.packaged-development-replay.v1", "status": "IN_PROGRESS",
        "scope": "Packaged installed development kernel only; not native FINNOR application verification",
        "steps": [], "nativeOwnerFlow": "NOT_RUN", "nativeMountedWork": "NOT_RUN",
        "installedApplicationReconstruction": "NOT_RUN", "protectedAdmission": "NOT_RUN",
        "fullNativeAdapterTypes": "NOT_RUN; earlier capped closure OOM is retained",
        "heavyLock": str(args.heavy_lock), "heavyLockMethod": "fcntl.flock LOCK_EX",
    }
    start = time.monotonic()
    try:
        with args.heavy_lock.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            index_path = bundle / "artifact-index.json"
            index = json.loads(index_path.read_text())
            require(index["schema"] == "finnor.z1.handoff-artifacts.v1", "ARTIFACT_INDEX_SCHEMA")
            report["artifactIndexSha256"] = sha(index_path)
            report["sourceHead"], report["sourceTree"] = index["sourceHead"], index["sourceTree"]
            report["integrity"] = verify_assets(bundle, index)
            if not args.verify_only:
                replay(bundle, index, args.evidence, report)
            report["status"] = "PASSED"
            report["verifyOnly"] = args.verify_only
    except Exception as error:
        report["status"] = "FAILED"
        report["failure"] = {"type": type(error).__name__, "code": str(error)}
    finally:
        report["wallMsIncludingLockWait"] = round((time.monotonic() - start) * 1000)
        with (args.evidence / "report.json").open("x") as output:
            json.dump(report, output, indent=2)
            output.write("\n")
    print(json.dumps({"status": report["status"], "scope": report["scope"], "evidence": str(args.evidence)}))
    return 0 if report["status"] == "PASSED" else 1


if __name__ == "__main__":
    sys.exit(main())
