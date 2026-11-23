"""Run both original owning suites against a measured emitted installation."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.parse import unquote, urlparse

assert len(sys.argv) == 4, "INSTALLATION NEW_ABSOLUTE_EVIDENCE PYTHON_REQUIRED"
installation = Path(sys.argv[1]).resolve(strict=True)
output = Path(sys.argv[2])
python = Path(sys.argv[3]).absolute()
python.resolve(strict=True)
assert output.is_absolute() and not output.exists()
output.mkdir(parents=True)
manifest_path = installation / "build-manifest.json"
manifest = json.loads(manifest_path.read_text())
runtime = Path(manifest["runtime"]).resolve(strict=True)
assert runtime == installation / "runtime"
assert manifest["schema"] == "finnor.w1.emitted-owning-runtime.v1"
node = Path(manifest["node"]["path"]).resolve(strict=True)
started = time.monotonic()
record = {"schema": "finnor.w1.installed-owning-gate.v1", "status": "NOT_RUN",
    "startedAt": datetime.now(timezone.utc).isoformat(), "installation": str(installation),
    "emittedBuild": True, "freshDependencyInstallClaimed": False, "results": [],
    "businessDeadlinesExtended": False, "costUSD": None, "completeDescendantUsage": None,
    "qualification": "LOCAL_EMITTED_FULL_P2_AND_W1_NATIVE_NOT_PROTECTED_OR_FIELD"}


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked(path):
    actual = runtime / path
    assert actual.resolve(strict=True).is_relative_to(runtime), "INSTALLED_PATH_ESCAPE"
    return actual


def integrity():
    assert sha(node) == manifest["node"]["sha256"], "NODE_CHANGED"
    assert sha(installation / "source-inputs.json") == manifest["sourceInputsSha256"]
    assert sha(installation / "dependency-assets.json") == manifest["dependencyAssetsSha256"]
    assert sha(installation / "emitter-transformations.json") == manifest["transformationsSha256"]
    sources = json.loads((installation / "source-inputs.json").read_text())["files"]
    dependencies = json.loads((installation / "dependency-assets.json").read_text())
    for pin in [*sources, *dependencies, *manifest["emittedFiles"], *manifest["locks"]]:
        path = checked(pin["path"])
        if pin.get("kind") == "link":
            assert path.is_symlink() and os.readlink(path) == pin["target"], "DEPENDENCY_LINK_CHANGED"
        else:
            assert path.is_file() and not path.is_symlink(), "REGULAR_PINNED_ASSET_REQUIRED"
            assert sha(path) == pin["sha256"], "PINNED_ASSET_CHANGED:" + pin["path"]
    for pin in manifest["emittedFiles"]:
        assert not checked(pin["path"]).stat().st_mode & 0o222, "READ_ONLY_EMITTED_ASSET_REQUIRED"
    return {"sourceAssets": len(sources), "dependencyAssets": len(dependencies),
            "emittedAssets": len(manifest["emittedFiles"]), "manifestSha256": sha(manifest_path)}


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


cancelled = False


def interrupted(signum, _frame):
    global cancelled
    cancelled = True
    raise InterruptedError("INSTALLED_GATE_INTERRUPTED_" + str(signum))


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    record["integrityBefore"] = integrity()
    source_migrations = sorted(path.name for path in checked("finnor-os/packages/db/migrations").glob("*.sql"))
    source_inputs = json.loads((installation / "source-inputs.json").read_text())["files"]
    frozen_migrations = sorted(Path(pin["path"]).name for pin in source_inputs
        if pin["path"].startswith("finnor-os/packages/db/migrations/") and pin["path"].endswith(".sql"))
    assert source_migrations and source_migrations == frozen_migrations, "COMPLETE_INSTALLED_MIGRATION_SOURCE_POPULATION_REQUIRED"
    record["registeredMigrationNames"] = source_migrations
    required = {
        "p2": ["A-owner-backed-adaptive-P1", "B-atomic-endpoint-admission", "C-recovery-currentness-outstanding"],
        "native": ["W1-native-owner-proof"],
    }
    for name in ("p2", "native"):
        destination = output / name
        destination.mkdir()
        environment = {key: value for key, value in os.environ.items() if key in ("HOME", "PATH", "TMPDIR")}
        environment.update(NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1",
            FINNOR_TEST_MANAGED_EXTENSIONS="omit", FINNOR_M1_PROFILE="DISPOSABLE_NATIVE",
            FINNOR_M1_STORE=str(destination / "producer-store"), FINNOR_S3_MODEL_STORE=str(destination / "models"),
            FINNOR_S4_POLICY_STORE=str(destination / "policies"), FINNOR_S3_PYTHON=str(python),
            FINNOR_S5_PYTHON=str(python), FINNOR_TEST_PYTHON=str(python),
            FINNOR_P2_EVIDENCE_DIR=str(destination), P3_GOVERNORS="1", RATE_LIMIT_PER_MINUTE="100000",
            NODE_OPTIONS="--max-old-space-size=2048")
        if name == "native":
            environment.update(FINNOR_W1_NATIVE_STORY="1", FINNOR_P2_CASE_FILTER="W1-native")
        command = [str(node), "--import=" + str(runtime / "finnor-os/scripts/postz-w1/read-network-guard.mjs"),
                   str(runtime / manifest["entrypoints"]["owningSuite"])]
        row = {"id": name, "status": "NOT_RUN", "command": command, "requiredIds": required[name],
               "limitSeconds": 1200 if name == "p2" else 300}
        record["results"].append(row)
        child = None
        try:
            with (destination / "installed-launch.log").open("x") as log:
                child = subprocess.Popen(command, cwd=runtime / "finnor-os", env=environment,
                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                row["childExitCode"] = child.wait(timeout=row["limitSeconds"])
            report_path = destination / "results.json"
            owning = json.loads(report_path.read_text())
            assert row["childExitCode"] == 0, "ACTUAL_OWNING_CHILD_EXIT_MUST_BE_ZERO"
            assert owning["status"] == "PASS_LOCAL" and owning["migrationCount"] == len(source_migrations)
            assert owning["migrationNames"] == source_migrations
            assert owning["observedMigrationNames"] == source_migrations
            assert owning["shutdown"]["complete"] is True
            assert owning["shutdown"]["postgres"]["status"] == "PASS"
            assert owning["shutdown"]["postgres"]["clusterStopped"] is True
            assert owning["shutdown"]["postgres"]["directoryRemoved"] is True
            assert [case["id"] for case in owning["results"]] == required[name], "COMPLETE_ORIGINAL_IDS_REQUIRED"
            assert all(case["status"] == "PASS" for case in owning["results"])
            if name == "native":
                native = json.loads((destination / "w1-scored-native/native-story.json").read_text())
                independent = json.loads((destination / "w1-scored-native/independent-oracle.json").read_text())
                assert native["status"] == "PASS_CONTROLLED_NATIVE" and independent["status"] == "PASS"
                row["nativeOracleSha256"] = sha(destination / "w1-scored-native/independent-oracle.json")
            observations = []
            for path in destination.glob("physical-worker-*.jsonl"):
                for line in path.read_text().splitlines():
                    value = json.loads(line)
                    if value.get("emittedEntrypoint"):
                        target = Path(unquote(urlparse(value["emittedEntrypoint"]).path))
                        assert target == runtime / manifest["entrypoints"]["physicalWorker"]
                        assert value["sha256"] == sha(target), "ACTUAL_PHYSICAL_ENTRYPOINT_DIGEST_REQUIRED"
                        observations.append(value)
            assert observations, "ACTUAL_EMITTED_PHYSICAL_CONSUMER_REQUIRED"
            row.update(status="PASS", owningReportSha256=sha(report_path), emittedPhysicalEntries=observations)
        except Exception as error:
            row.update(status="FAIL", failure=str(error), failureType=type(error).__name__)
            if cancelled:
                raise
        finally:
            previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
            if child is not None:
                try:
                    stop(child)
                    row["terminalChildExitCode"] = child.returncode
                    if row["status"] == "PASS" and child.returncode != 0:
                        row.update(status="FAIL", failure="NONZERO_OWNING_SHUTDOWN")
                except Exception as error:
                    row.update(status="FAIL", cleanupFailure=repr(error))
            row["finishedAt"] = datetime.now(timezone.utc).isoformat()
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    record["integrityAfter"] = integrity()
    assert len(record["results"]) == 2 and all(row["status"] == "PASS" for row in record["results"])
    record["status"] = "PASS_LOCAL_EMITTED_OWNING"
except Exception as error:
    record.update(status="FAIL", failure=str(error), failureType=type(error).__name__)
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    record.update(finishedAt=datetime.now(timezone.utc).isoformat(), elapsedSeconds=time.monotonic() - started,
                  launcherSha256=sha(Path(__file__)))
    (output / "installed-owning-receipt.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"status": record["status"], "failure": record.get("failure"),
        "stages": [{"id": row["id"], "status": row["status"]} for row in record["results"]],
        "elapsedSeconds": record["elapsedSeconds"]}))
raise SystemExit(0 if record["status"] == "PASS_LOCAL_EMITTED_OWNING" else 1)
