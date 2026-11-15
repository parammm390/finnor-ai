"""Finite W1 bootstrap through the acknowledged original P2 fixture hook. Not run by generation."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

backend = Path(__file__).resolve().parents[2]
assert len(sys.argv) in (2, 3) and (len(sys.argv) == 2 or sys.argv[2] == "--mounted"), "New absolute disposable evidence directory and optional --mounted required"
mounted = len(sys.argv) == 3
destination = Path(sys.argv[1]).resolve()
destination.mkdir(parents=True, exist_ok=False)
node = Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True)
python = Path(os.environ["FINNOR_TEST_PYTHON"]).absolute()
python.resolve(strict=True)
env = {key: value for key, value in os.environ.items() if key in ("HOME", "PATH", "TMPDIR")}
env.update(NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1", FINNOR_TEST_MANAGED_EXTENSIONS="omit",
           FINNOR_M1_PROFILE="DISPOSABLE_NATIVE", FINNOR_M1_STORE=str(destination / "producer-store"),
           FINNOR_S3_MODEL_STORE=str(destination / "models"), FINNOR_S4_POLICY_STORE=str(destination / "policies"),
           FINNOR_S3_PYTHON=str(python), FINNOR_S5_PYTHON=str(python), FINNOR_TEST_PYTHON=str(python),
           FINNOR_W1_NATIVE_STORY="mounted" if mounted else "1", FINNOR_P2_EVIDENCE_DIR=str(destination), FINNOR_P2_CASE_FILTER="W1-native",
           P3_GOVERNORS="1", RATE_LIMIT_PER_MINUTE="100000")
command = [str(node), "--import=" + str(backend / "scripts/postz-w1/read-network-guard.mjs"),
           "--import=tsx", "scripts/p2/run-e2e.mts"]
receipt = {"schema": "finnor.w1.native-bootstrap-runner.v1", "command": command, "cwd": str(backend),
           "limitSeconds": 300, "environmentNames": sorted(env), "campaignExecuted": True, "mountedRequired": mounted,
           "setupAuth": "disposable header bypass during setup", "scoredAuthRequired": "signed bearer; bypass disabled",
           "scripts": [{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                       for path in (Path(__file__).resolve(), backend / "scripts/p2/run-e2e.mts",
                                    backend / "scripts/postz-w1/native-stories.mts", backend / "scripts/postz-w1/native-observe.mts",
                                    backend / "scripts/postz-w1/native-oracle.py",
                                    *((backend / "scripts/postz-w1/mounted-story.mts",
                                       backend / "scripts/p2/browser-fixture.mts") if mounted else ()))]}
receipt.update(status="FAIL", owningArtifactsPass=False, independentOracleStatus="NOT_RUN", exitCode=1)
registered_migrations = sorted(path.name for path in (backend / "packages/db/migrations").glob("*.sql"))
child = None


def interrupted(signum, _frame):
    raise InterruptedError("NATIVE_BOOTSTRAP_INTERRUPTED_" + str(signum))


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    with (destination / "runner.log").open("x") as log:
        child = subprocess.Popen(command, cwd=backend, env=env, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        receipt["childExitCode"] = child.wait(timeout=300)
    assert receipt["childExitCode"] == 0, "FAILED_CHILD_CANNOT_BE_ACCEPTED_FROM_PARTIAL_ARTIFACTS"
    owning = json.loads((destination / "results.json").read_text())
    assert owning["status"] == "PASS_LOCAL"
    assert owning["migrationCount"] == len(registered_migrations)
    assert owning["migrationNames"] == registered_migrations
    assert owning["observedMigrationNames"] == registered_migrations
    expected = "W1-native-mounted-owner-proof" if mounted else "W1-native-owner-proof"
    assert [row["id"] for row in owning["results"]] == [expected]
    assert all(row["status"] == "PASS" for row in owning["results"])
    assert owning["shutdown"]["complete"] is True
    assert owning["shutdown"]["postgres"]["status"] == "PASS"
    assert owning["shutdown"]["postgres"]["clusterStopped"] is True
    assert owning["shutdown"]["postgres"]["directoryRemoved"] is True
    story = destination / "w1-scored-native/native-story.json"
    oracle = destination / "w1-scored-native/independent-oracle.json"
    receipt["nativeStoryPresent"] = story.exists()
    assert json.loads(story.read_text())["status"] == "PASS_CONTROLLED_NATIVE"
    receipt["independentOracleStatus"] = json.loads(oracle.read_text())["status"]
    assert receipt["independentOracleStatus"] == "PASS"
    if mounted:
        path = destination / "browser/run/results.json"
        receipt["mountedStatus"] = json.loads(path.read_text())["status"]
        assert receipt["mountedStatus"] == "PASS_LOCAL"
    receipt.update(status="PASS_LOCAL_NATIVE_BOOTSTRAP", owningArtifactsPass=True, exitCode=0,
                   shutdown=owning["shutdown"])
except Exception as error:
    receipt.update(status="FAIL", failure=str(error), failureType=type(error).__name__, exitCode=1)
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    if child:
        try:
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
            receipt["terminalChildExitCode"] = child.returncode
        except Exception as error:
            receipt.update(status="FAIL", cleanupFailure=repr(error), exitCode=1, owningArtifactsPass=False)
    (destination / "w1-runner-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
raise SystemExit(receipt["exitCode"])
