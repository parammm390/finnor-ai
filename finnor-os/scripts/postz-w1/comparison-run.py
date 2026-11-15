"""Finite actual native ablation with complete process-group ownership."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

backend = Path(__file__).resolve().parents[2]
destination = Path(sys.argv[1])
assert destination.is_absolute() and not destination.exists()
destination.mkdir(parents=True)
node = Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True)
python = Path(os.environ["FINNOR_TEST_PYTHON"]).absolute()
python.resolve(strict=True)
env = {key: value for key, value in os.environ.items() if key in ("HOME", "PATH", "TMPDIR")}
env.update(NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1",
           FINNOR_TEST_MANAGED_EXTENSIONS="omit", FINNOR_M1_PROFILE="DISPOSABLE_NATIVE",
           FINNOR_M1_STORE=str(destination / "producer-store"), FINNOR_S3_MODEL_STORE=str(destination / "models"),
           FINNOR_S4_POLICY_STORE=str(destination / "policies"), FINNOR_S3_PYTHON=str(python),
           FINNOR_S5_PYTHON=str(python), FINNOR_TEST_PYTHON=str(python), FINNOR_W1_NATIVE_STORY="comparison",
           FINNOR_P2_EVIDENCE_DIR=str(destination), FINNOR_P2_CASE_FILTER="W1-native-on-off",
           P3_GOVERNORS="1", RATE_LIMIT_PER_MINUTE="100000")
command = [str(node), "--import=" + str(backend / "scripts/postz-w1/read-network-guard.mjs"),
           "--import=tsx", "scripts/p2/run-e2e.mts"]
record = {"schema": "finnor.w1.comparison-bootstrap.v1", "status": "NOT_RUN", "command": command,
          "limitSeconds": 1200, "originalBusinessEpisodeSeconds": 300}
child = None


def interrupted(signum, _frame):
    raise InterruptedError("COMPARISON_BOOTSTRAP_INTERRUPTED_" + str(signum))


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    with (destination / "runner.log").open("x") as log:
        child = subprocess.Popen(command, cwd=backend, env=env, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        record["childExitCode"] = child.wait(timeout=1200)
    owning = json.loads((destination / "results.json").read_text())
    oracle = json.loads((destination / "on-off/independent-oracle.json").read_text())
    assert record["childExitCode"] == 0
    migrations = sorted(path.name for path in (backend / "packages/db/migrations").glob("*.sql"))
    assert owning["status"] == "PASS_LOCAL" and owning["migrationCount"] == len(migrations)
    assert owning["migrationNames"] == owning["observedMigrationNames"] == migrations
    assert owning["shutdown"]["complete"] is True
    assert owning["shutdown"]["postgres"]["status"] == "PASS"
    assert owning["shutdown"]["postgres"]["clusterStopped"] is True
    assert owning["shutdown"]["postgres"]["directoryRemoved"] is True
    assert len(owning["results"]) == 1 and owning["results"][0]["id"] == "W1-native-on-off"
    assert owning["results"][0]["status"] == oracle["status"] == "PASS"
    record.update(status="PASS_LOCAL_NATIVE_DIAGNOSTIC", independentOracle="PASS",
                  empiricalGainQualified=False, economicGainQualified=False)
except Exception as error:
    record.update(status="FAIL", failure=str(error), failureType=type(error).__name__)
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
            record["terminalChildExitCode"] = child.returncode
        except Exception as error:
            record.update(status="FAIL", cleanupFailure=repr(error))
    (destination / "comparison-runner-receipt.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps(record))
raise SystemExit(0 if record["status"] == "PASS_LOCAL_NATIVE_DIAGNOSTIC" else 1)
