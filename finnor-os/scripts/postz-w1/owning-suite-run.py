"""Installed-dependency owning P2 regression, never child-exit-only success."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

backend = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("destination", type=Path)
parser.add_argument("--mode", default="abc", choices=("abc", "internal-read-standing", "internal-pressure",
    "internal-revocation", "internal-sequential", "internal-drift"))
args = parser.parse_args()
destination = args.destination
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
           FINNOR_S5_PYTHON=str(python), FINNOR_TEST_PYTHON=str(python),
           FINNOR_P2_EVIDENCE_DIR=str(destination), P3_GOVERNORS="1", RATE_LIMIT_PER_MINUTE="100000")
groups = {
    "abc": (["A-owner-backed-adaptive-P1", "B-atomic-endpoint-admission", "C-recovery-currentness-outstanding"], []),
    "internal-read-standing": (["W1-internal-primary-research", "W1-internal-standing"], [
        ("internal-research", ["W003", "W012", "W013"], "PASS_LOCAL_PRIMARY_RESEARCH", "PASS_INDEPENDENT_PRIMARY_RESEARCH_ORACLE"),
        ("internal-standing", ["W004"], "PASS_LOCAL_STANDING_EVENT_LINEAGE", "PASS_INDEPENDENT_STANDING_EVENT_LINEAGE")]),
    "internal-pressure": (["W1-internal-pressure"], [
        ("internal-pressure", ["W006", "W015"], "PASS_LOCAL_OWNER_CONSERVATION_AND_QUEUE_PRESSURE", "PASS_INDEPENDENT_CONSERVATION_AND_MISSED_POPULATION")]),
    "internal-revocation": (["W1-internal-revocation"], [
        ("internal-revocation", ["W007"], "PASS_LOCAL_SIX_ACTUAL_BOUNDARY_RACES", "PASS_INDEPENDENT_SIX_BOUNDARY_LINEAGE_AND_LIABILITY")]),
    "internal-sequential": (["W1-internal-sequential"], [
        ("internal-sequential", ["W011"], "PASS_LOCAL_STRONG_SEQUENTIAL", "PASS_INDEPENDENT_NATIVE_SINGLE_PATH")]),
    "internal-drift": (["W1-internal-drift"], [
        ("internal-drift", ["W014"], "PASS_LOCAL_ACTUAL_PRICE_MODEL_LATENCY_RESELECTION", "PASS_INDEPENDENT_PRICE_MODEL_LATENCY_RESELECTION")]),
}
if args.mode != "abc":
    env["FINNOR_W1_NATIVE_STORY"] = args.mode
command = [str(node), "--import=" + str(backend / "scripts/postz-w1/read-network-guard.mjs"),
           "--import=tsx", "scripts/p2/run-e2e.mts"]
record = {"schema": "finnor.w1.owning-suite-bootstrap.v1", "status": "NOT_RUN",
          "command": command, "mode": args.mode, "limitSeconds": 1200, "emittedBuild": False,
          "qualification": "SOURCE_ENTRYPOINT_INSTALLED_DEPENDENCIES_NOT_EMITTED_OR_COLD"}
registered_migrations = sorted(path.name for path in (backend / "packages/db/migrations").glob("*.sql"))
child = None
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
source_paths = sorted({Path(__file__).resolve(), backend / "scripts/p2/run-e2e.mts",
    backend / "scripts/p5/native-worker-client.mts", backend / "scripts/p5/physical-worker.mts",
    *[path for path in (backend / "scripts/postz-w1").iterdir()
      if path.is_file() and path.suffix in (".mts", ".mjs", ".py")]})
record["sourcesBefore"] = {str(path): sha(path) for path in source_paths}


def interrupted(signum, _frame):
    raise InterruptedError("OWNED_P2_RUNNER_INTERRUPTED_" + str(signum))


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    with (destination / "runner.log").open("x") as log:
        child = subprocess.Popen(command, cwd=backend, env=env, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        record["childExitCode"] = child.wait(timeout=1200)
    owning = json.loads((destination / "results.json").read_text())
    required, artifacts = groups[args.mode]
    assert record["childExitCode"] == 0, "FAILED_CHILD_CANNOT_BE_ACCEPTED_FROM_PARTIAL_ARTIFACTS"
    assert owning["status"] == "PASS_LOCAL"
    assert owning["migrationCount"] == len(registered_migrations)
    assert owning["migrationNames"] == registered_migrations
    assert owning["observedMigrationNames"] == registered_migrations
    assert owning["shutdown"]["complete"] is True
    assert owning["shutdown"]["postgres"]["status"] == "PASS"
    assert owning["shutdown"]["postgres"]["clusterStopped"] is True
    assert owning["shutdown"]["postgres"]["directoryRemoved"] is True
    assert [row["id"] for row in owning["results"]] == required
    assert all(row["status"] == "PASS" for row in owning["results"])
    record["cases"] = []
    for relative, identities, status, oracle_status in artifacts:
        report_path = destination / relative / "results.json"
        oracle_path = destination / relative / "independent-oracle.json"
        report, oracle = (json.loads(path.read_text()) for path in (report_path, oracle_path))
        assert report["status"] == status and report["caseIds"] == identities
        assert report["cleanup"]["status"] == "PASS_OWNED_RESOURCES_CLOSED"
        assert oracle["status"] == oracle_status and oracle["caseIds"] == identities
        original_input = "oracle-input.json" if relative in (
            "internal-research", "internal-standing", "internal-sequential") else "owner-observations.json"
        assert oracle["inputSha256"] == sha(destination / relative / original_input)
        if relative == "internal-revocation":
            subcases = report["cases"]
            assert len(subcases) == 6 and all(row["status"] == "PASS" for row in subcases)
            assert {row["boundary"] for row in subcases} == {"SUBMIT", "CLAIM", "USE", "CHECK", "PUBLISH", "DISPATCH"}
        if relative == "internal-drift":
            subcases = report["cases"]
            assert len(subcases) == 3 and all(row["status"] == "PASS" for row in subcases)
            assert {row["facet"] for row in subcases} == {"PRICE", "MODEL", "LATENCY"}
        for identity in identities:
            record["cases"].append({"id": identity, "status": "PASS", "report": str(report_path),
                "reportSha256": sha(report_path), "independentOracle": str(oracle_path),
                "independentOracleSha256": sha(oracle_path)})
    record["sourcesAfter"] = {str(path): sha(path) for path in source_paths}
    assert record["sourcesAfter"] == record["sourcesBefore"], "OWNING_RUNNER_SOURCE_DRIFT"
    record.update(status="PASS_LOCAL_OWNING_SOURCE_SUITE" if args.mode == "abc" else
                  "PASS_LOCAL_INTERNAL_OWNING_GROUP", owningIds=required)
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
            record["ownedChildStopped"] = child.returncode is not None
        except Exception as error:
            record.update(status="FAIL", cleanupFailure=repr(error))
    (destination / "owning-suite-runner-receipt.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps(record))
raise SystemExit(0 if record["status"] in ("PASS_LOCAL_OWNING_SOURCE_SUITE", "PASS_LOCAL_INTERNAL_OWNING_GROUP") else 1)
