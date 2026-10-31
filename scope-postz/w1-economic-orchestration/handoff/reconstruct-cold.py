"""Independent local reconstruction from a verified sealed source namespace.

Arguments: PACKET MANIFEST EXPECTED_MANIFEST_SHA NEW_ABSOLUTE_DIRECTORY
           NODE BARE_PYTHON UV NPM_CLI_JS
No application/dependency path is read from the donor checkout.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from disposable_cleanup import cleanup_namespace
from campaign_runtime import runtime_asset_population

assert len(sys.argv) == 9, "PACKET MANIFEST SHA NEW_DIRECTORY NODE BARE_PYTHON UV NPM_CLI_JS_REQUIRED"
packet, manifest_path = (Path(value).resolve(strict=True) for value in sys.argv[1:3])
expected_manifest_sha = sys.argv[3]
requested_output = Path(sys.argv[4])
assert requested_output.is_absolute() and not requested_output.exists()
output = requested_output.parent.resolve(strict=True) / requested_output.name
node, base_python, uv, npm = (Path(value).resolve(strict=True) for value in sys.argv[5:9])
trusted_manifest_bytes = manifest_path.read_bytes()
assert hashlib.sha256(trusted_manifest_bytes).hexdigest() == expected_manifest_sha, "TRUSTED_SEAL_MANIFEST_DIGEST_REQUIRED"
trusted_manifest = json.loads(trusted_manifest_bytes)
assert trusted_manifest["schema"] == "finnor.w1.sealed-cold-input.v1" and trusted_manifest["status"] == "SEALED_AND_VERIFIED"
reconstruction_limits = trusted_manifest["reconstructionLimits"]
global_disk_floor = reconstruction_limits["globalDiskFloorBytes"]
additional_disk_limit = reconstruction_limits["coldAdditionalFilesystemBytes"]
assert isinstance(global_disk_floor, int) and global_disk_floor >= 3 * 1024 ** 3
assert isinstance(additional_disk_limit, int) and additional_disk_limit > 0
assert shutil.disk_usage(output.parent).free >= global_disk_floor + additional_disk_limit, "FROZEN_COLD_CAPACITY_UNAVAILABLE"
output.mkdir(mode=0o700)
started = time.monotonic()
free_before = shutil.disk_usage(output).free
record = {"schema": "finnor.w1.cold-emitted-owning.v1", "status": "NOT_RUN",
    "startedAt": datetime.now(timezone.utc).isoformat(), "output": str(output), "stages": [],
    "globalFreeFloorBytes": global_disk_floor, "maximumAdditionalFilesystemBytes": additional_disk_limit,
    "packageCacheReuse": True, "donorNodeModulesOrVenvOrCompiledRuntimeReuse": False,
    "baseRuntimeExecutableReuse": True, "baseRuntimeDistributionReuse": True, "baseRuntimeFullDistributionAttestation": "NOT_ESTABLISHED",
    "businessDeadlinesExtended": False, "billingUSD": None,
    "qualification": "LOCAL_COLD_EMITTED_FULL_OWNING_NOT_DOMAIN_ADMISSION_PRODUCTION_FIELD_OR_ECONOMIC_GAIN"}


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def capacity():
    free = shutil.disk_usage(output).free
    assert free >= record["globalFreeFloorBytes"], "GLOBAL_FREE_FLOOR"
    assert free_before - free <= record["maximumAdditionalFilesystemBytes"], "COLD_ADDITIONAL_DISK_LIMIT"
    return free


def stop(child):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=5)


def interrupted(signum, _frame):
    raise RuntimeError("COLD_RECONSTRUCTION_INTERRUPTED_" + str(signum))


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
home = output / "home"
home.mkdir()
temporary_parent = Path(os.environ.get("TMPDIR", "/tmp")).resolve(strict=True)
assert temporary_parent == Path("/tmp").resolve() or (
    temporary_parent.is_relative_to(Path("/tmp").resolve()) and temporary_parent.name.startswith("finnor-w1-run-"))
temporary = Path(tempfile.mkdtemp(prefix="finnor-w1-run-", dir=temporary_parent)).resolve(strict=True)
temporary_stat = temporary.stat()
temporary_identity = (temporary_stat.st_dev, temporary_stat.st_ino)
record["temporaryNamespace"] = str(temporary)
for name in ("user.npmrc", "global.npmrc"):
    (home / name).touch(exist_ok=False)
environment = {"HOME": str(home), "TMPDIR": str(temporary),
    "PATH": str(node.parent) + ":/usr/bin:/bin:/usr/sbin:/sbin",
    "CI": "1", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1", "PUPPETEER_SKIP_DOWNLOAD": "1",
    "PYTHONDONTWRITEBYTECODE": "1", "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
    "NPM_CONFIG_USERCONFIG": str(home / "user.npmrc"),
    "NPM_CONFIG_GLOBALCONFIG": str(home / "global.npmrc")}
cache_home = Path.home()


def run(name, command, cwd, limit):
    row = {"id": name, "command": [str(value) for value in command], "cwd": str(cwd),
           "limitSeconds": limit, "status": "NOT_RUN", "freeBytesBefore": capacity()}
    record["stages"].append(row)
    child = None
    at = time.monotonic()
    log_path = output / (name + ".log")
    try:
        with log_path.open("x") as log:
            child = subprocess.Popen(row["command"], cwd=cwd, env=environment,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            while True:
                remaining = limit - (time.monotonic() - at)
                assert remaining > 0, "REGISTERED_COLD_STAGE_TIMEOUT"
                try:
                    row["childExitCode"] = child.wait(timeout=min(2, remaining))
                    break
                except subprocess.TimeoutExpired:
                    capacity()
        assert row["childExitCode"] == 0, "COLD_STAGE_NONZERO:" + name
        row["status"] = "PASS"
    except Exception as error:
        row.update(status="FAIL", failure=str(error), failureType=type(error).__name__)
        raise
    finally:
        previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
        cleanup_error = None
        if child is not None:
            try:
                stop(child)
                row["terminalChildExitCode"] = child.returncode
            except Exception as error:
                cleanup_error = error
                row.update(status="FAIL", cleanupFailure=repr(error))
        row.update(elapsedSeconds=time.monotonic() - at, logSha256=sha(log_path),
                   freeBytesAfter=shutil.disk_usage(output).free)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if cleanup_error:
            raise cleanup_error



try:
    assert sha(manifest_path) == expected_manifest_sha, "TRUSTED_SEAL_MANIFEST_DIGEST_REQUIRED"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["schema"] == "finnor.w1.sealed-cold-input.v1" and manifest["status"] == "SEALED_AND_VERIFIED"
    assert sha(packet) == manifest["packetSha256"], "SEALED_PACKET_DIGEST"
    expected = {pin["path"]: pin for pin in manifest["members"]}
    assert len(expected) == len(manifest["members"]), "UNIQUE_SEALED_MEMBERS_REQUIRED"
    self_name = "source/scope-postz/w1-economic-orchestration/handoff/reconstruct-cold.py"
    assert sha(Path(__file__)) == expected[self_name]["sha256"], "SEALED_RECONSTRUCTOR_BYTES_REQUIRED"
    source = output / "source"
    source.mkdir()
    observed = set()
    with tarfile.open(packet, "r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            assert not path.is_absolute() and ".." not in path.parts
            assert member.name in expected and member.name not in observed, "EXACT_ARCHIVE_NAMESPACE_REQUIRED"
            observed.add(member.name)
            pin = expected[member.name]
            if pin["kind"] == "link":
                assert member.issym() and member.linkname == pin["target"] and not member.name.startswith("source/")
            else:
                assert member.isfile() and member.size == pin["bytes"]
                with archive.extractfile(member) as body:
                    digest = hashlib.sha256()
                    target = None
                    if member.name.startswith("source/"):
                        relative = Path(*path.parts[1:])
                        assert not set(relative.parts) & {"node_modules", ".git", ".venv"}
                        assert not any(part == ".env" or part.startswith(".env.") for part in relative.parts)
                        destination = source / relative
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        target = destination.open("xb")
                    try:
                        while chunk := body.read(1024 * 1024):
                            digest.update(chunk)
                            if target is not None:
                                target.write(chunk)
                    finally:
                        if target is not None:
                            target.close()
                    assert digest.hexdigest() == pin["sha256"], "SEALED_MEMBER_DIGEST"
                    if member.name.startswith("source/"):
                        destination.chmod(pin["mode"] & 0o755)
            capacity()
    assert observed == set(expected), "ALL_SEALED_MEMBERS_VERIFIED"
    record["sealedInput"] = {"packetSha256": manifest["packetSha256"], "manifestSha256": expected_manifest_sha,
        "verifiedMembers": len(observed), "sourceCommit": manifest["sourceCommit"],
        "sourceMemberCount": sum(name.startswith("source/") for name in observed)}
    plan_path = source / manifest["frozenPlanPath"]
    assert sha(plan_path) == manifest["frozenPlanSha256"]
    plan = json.loads(plan_path.read_text())
    assert global_disk_floor == plan["limits"]["globalDiskFloorBytes"]
    assert additional_disk_limit == plan["limits"]["coldAdditionalFilesystemBytes"]
    for pin in plan["sourceFiles"]:
        assert sha(source / pin["path"]) == pin["sha256"], "ORIGINAL_FROZEN_SOURCE_REQUIRED"
    for path, expected_hash in plan["locks"].items():
        assert sha(source / path) == expected_hash, "TWO_ORIGINAL_LOCKS_REQUIRED"
    assert sha(node) == plan["runtimes"]["node"]["sha256"], "PINNED_NODE_REQUIRED"
    assert sha(base_python) == plan["runtimes"]["python"]["sha256"], "PINNED_BASE_PYTHON_REQUIRED"
    for name, path in (("uv", uv), ("npmCli", npm)):
        assert sha(path) == plan["runtimes"][name]["sha256"], "PINNED_COLD_BOOTSTRAP_TOOL_REQUIRED:" + name
    npm_distribution = plan["runtimes"]["npmCli"]
    assert runtime_asset_population(Path(npm_distribution["distributionRoot"])) == npm_distribution["assets"], "FULL_PINNED_NPM_DISTRIBUTION_REQUIRED"
    package_caches = {name: Path(path) for name, path in plan["handoff"]["packageCaches"].items()}
    assert set(package_caches) == {"npm", "uv"} and all(path.is_absolute() for path in package_caches.values())
    environment["UV_CACHE_DIR"] = str(package_caches["uv"])
    record["packageCaches"] = {name: str(path) for name, path in package_caches.items()}
    record["tools"] = {name: {"path": str(path), "sha256": sha(path)}
                       for name, path in [("node", node), ("basePython", base_python), ("uv", uv), ("npmCli", npm)]}
    for name, folder in [("npm-frontend", source), ("npm-backend", source / "finnor-os")]:
        assert not (folder / "node_modules").exists(), "FRESH_NPM_DESTINATION_REQUIRED"
        run(name, [node, npm, "ci", "--no-audit", "--no-fund", "--prefer-offline",
                   "--cache", package_caches["npm"]], folder, 1200)
    run("python-environment", [uv, "venv", "--python", base_python, output / "python"], output, 180)
    python = output / "python/bin/python"
    run("python-dependencies", [uv, "pip", "install", "--require-hashes", "--python", python, "--requirement",
        source / "finnor-os/scripts/postz-w1/requirements-native.txt"], output, 360)
    runtime_attester = source / "scope-postz/w1-economic-orchestration/handoff/attest-scientific-runtime.py"
    scientific_lock = source / "finnor-os/scripts/r3/upstream-requirements.lock"
    runtime_before = output / "scientific-runtime-before.json"
    run("python-identity", [python, "-I", "-B", runtime_attester, "--python", python,
        "--lock", scientific_lock, "--output", runtime_before], output, 120)
    attestation = json.loads(runtime_before.read_text())
    assert attestation["status"] == "PASS"
    identity = {key: attestation["identity"][key] for key in ("prefix", "basePrefix", "version")}
    identity.update({name: attestation["observedDistributions"][name] for name in ("numpy", "scipy", "statsmodels", "arch", "pandas")})
    identity.update(numpyFile=attestation["identity"]["modules"]["numpy"], scipyFile=attestation["identity"]["modules"]["scipy"])
    base_population_sha = hashlib.sha256(json.dumps(attestation["baseAssets"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert base_population_sha == plan["runtimes"]["python"]["baseAssetPopulationSha256"], "FROZEN_BASE_DISTRIBUTION_POPULATION_REQUIRED"
    record["baseRuntimeFullDistributionAttestation"] = attestation["completeBaseDistributionAttestation"]
    record["baseRuntimePopulationSha256"] = base_population_sha
    record["scientificRuntimeBeforeSha256"] = sha(runtime_before)
    record["scientificLockSha256"] = sha(scientific_lock)
    assert identity["prefix"] == str(output / "python") and identity["basePrefix"] != identity["prefix"]
    numerical_pins = source / "finnor-os/scripts/r3/upstream-requirements.in"
    for line in numerical_pins.read_text().splitlines():
        if line and not line.startswith("#"):
            name, version = line.split("==")
            assert identity[name] == version, "ORIGINAL_NUMERICAL_DEPENDENCY_REQUIRED:" + name
    record["numericalRequirementsSha256"] = sha(numerical_pins)
    assert all(Path(identity[key]).resolve().is_relative_to(output / "python") for key in ("numpyFile", "scipyFile"))
    record["freshPython"] = identity
    python_assets = attestation["environmentAssets"]
    python_assets_path = output / "fresh-python-assets.json"
    python_assets_path.write_text(json.dumps(python_assets, indent=2) + "\n")
    record["freshPythonAssetsSha256"] = sha(python_assets_path)
    record["freshPythonAssetCount"] = len(python_assets)
    run("emit-installed", [node, source / "scope-postz/w1-economic-orchestration/handoff/emit-installed.mjs",
        "--output", output / "emitted", "--plan", plan_path], source, 600)
    run("emitted-owning", [python, source / "scope-postz/w1-economic-orchestration/handoff/run-installed-owning.py",
        output / "emitted", output / "owning-evidence", python], source, 1800)
    owning_path = output / "owning-evidence/installed-owning-receipt.json"
    owning = json.loads(owning_path.read_text())
    assert owning["status"] == "PASS_LOCAL_EMITTED_OWNING" and all(row["status"] == "PASS" for row in owning["results"])
    runtime_after = output / "scientific-runtime-after.json"
    run("python-final-integrity", [python, "-I", "-B", runtime_attester, "--python", python,
        "--lock", scientific_lock, "--output", runtime_after, "--expected", runtime_before], output, 120)
    assert json.loads(runtime_after.read_text())["status"] == "PASS"
    record["scientificRuntimeAfterSha256"] = sha(runtime_after)
    for pin in plan["sourceFiles"]:
        assert sha(source / pin["path"]) == pin["sha256"], "FROZEN_COLD_SOURCE_DRIFT_AFTER_OWNING"
    for name, expected_hash in plan["locks"].items():
        assert sha(source / name) == expected_hash, "FROZEN_COLD_LOCK_DRIFT_AFTER_OWNING"
    assert runtime_asset_population(Path(npm_distribution["distributionRoot"])) == npm_distribution["assets"], "PINNED_NPM_DISTRIBUTION_DRIFT_AFTER_COLD"
    record["owningReceiptSha256"] = sha(owning_path)
    record["status"] = "PASS_LOCAL_COLD_EMITTED_OWNING"
except Exception as error:
    record.update(status="FAIL", failure=str(error), failureType=type(error).__name__)
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        record["disposableCleanup"] = cleanup_namespace(temporary, parent=temporary_parent, identity=temporary_identity)
    except Exception as error:
        record.update(status="FAIL", disposableCleanup={"status": "FAIL", "failure": repr(error)})
    record.update(finishedAt=datetime.now(timezone.utc).isoformat(), elapsedSeconds=time.monotonic() - started,
        freeBytesBefore=free_before, freeBytesAfter=shutil.disk_usage(output).free, reconstructorSha256=sha(Path(__file__)))
    destination = output / "cold-reconstruction-receipt.json"
    with destination.open("x") as stream:
        stream.write(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"status": record["status"], "failure": record.get("failure"),
        "elapsedSeconds": record["elapsedSeconds"], "stages": [
            {"id": row["id"], "status": row["status"]} for row in record["stages"]]}))
raise SystemExit(0 if record["status"] == "PASS_LOCAL_COLD_EMITTED_OWNING" else 1)
