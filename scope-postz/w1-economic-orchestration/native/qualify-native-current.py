"""Finite parent around the unchanged native driver and original-row oracle."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

# One parent bound carried by the enforcement deadline, the receipt field, and
# the post-hoc timeout guard below; all three must agree.
PARENT_LIMIT_SECONDS = 330


def main():
    root = Path(__file__).resolve().parents[3]
    registration = Path(sys.argv[1])
    r = json.loads(registration.read_text())
    evidence = Path(r["command"][-1])
    parent = Path(str(evidence) + ".parent-gate.json")
    if not registration.is_absolute() or not evidence.is_absolute() or evidence.exists() or parent.exists():
        raise RuntimeError("NEW_ABSOLUTE_NATIVE_EPOCH_REQUIRED")
    began = time.monotonic()
    deadline = began + PARENT_LIMIT_SECONDS
    child = None
    result = {"schema": "finnor.w1.current-native-parent.v1",
        "at": datetime.now(timezone.utc).isoformat(), "status": "NOT_RUN",
        "registrationSha256": hashlib.sha256(registration.read_bytes()).hexdigest(),
        "parentLimitSeconds": PARENT_LIMIT_SECONDS, "businessEpochSeconds": 300,
        "billingUSD": None, "humanSeconds": None, "completeDescendantUsage": None,
        "CODE_COMPLETE": False, "E2E_DEV_VERIFIED": False,
        "protectedAdmission": False, "economicGainQualified": False}

    def sources():
        bad = []
        for entry in r["sourceFiles"]:
            path = root / entry["path"]
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
                bad.append(entry["path"])
        return bad

    def interrupted(_signum, _frame):
        raise InterruptedError("OWNED_NATIVE_PARENT_INTERRUPTED")

    def stop_owned_group():
        if child is None:
            return
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=25)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=5)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        assert not sources(), "SOURCE_DRIFT_BEFORE_NATIVE_EXECUTION"
        oracle = root / "finnor-os/scripts/postz-w1/native-oracle.py"
        assert hashlib.sha256(oracle.read_bytes()).hexdigest() == r["nativeOracleSha256"]
        env = dict(os.environ, **r["environment"])
        with Path(str(evidence) + ".parent-process.log").open("xb") as out:
            child = subprocess.Popen(r["command"], cwd=root, env=env,
                stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
            result["childExitCode"] = child.wait(timeout=min(310, deadline - time.monotonic()))
        stop_owned_group()
        assert result["childExitCode"] == 0, "NATIVE_DRIVER_NONZERO"
        report = json.loads((evidence / "results.json").read_text())
        receipt = json.loads((evidence / "w1-runner-receipt.json").read_text())
        story = json.loads((evidence / "w1-scored-native/native-story.json").read_text())
        p7 = json.loads((evidence / "w1-scored-native/p7-currentness.json").read_text())
        migrations = sorted(path.name for path in (root / "finnor-os/packages/db/migrations").glob("*.sql"))
        assert migrations == r["migrationNames"], "EXACT_FROZEN_MIGRATION_SOURCE_POPULATION_REQUIRED"
        assert report["status"] == "PASS_LOCAL" and report["migrationCount"] == len(migrations)
        assert report["migrationNames"] == report["observedMigrationNames"] == migrations
        assert report["shutdown"]["complete"] is True
        assert report["shutdown"]["postgres"]["status"] == "PASS"
        assert report["shutdown"]["postgres"]["directoryRemoved"] is True
        assert report["shutdown"]["postgres"]["clusterStopped"] is True
        assert len(report["results"]) == 1 and report["results"][0]["status"] == "PASS"
        assert report["results"][0]["id"] == "W1-native-owner-proof"
        assert receipt["exitCode"] == 0 and receipt["independentOracleStatus"] == "PASS"
        assert story["status"] == p7["status"] == "PASS_CONTROLLED_NATIVE"
        assert story["scoredAuth"] == "ACTUAL_SIGNED_BEARER_AUTH_DEV_BYPASS_0"
        assert story["sourceAndAcceptanceUnchanged"] is True
        assert story["before"]["id"] == story["after"]["id"] == story["originalEpisode"]
        assert story["perProgrammeObserverSeconds"] == 120
        observations = evidence / "w1-scored-native/observations.json"
        recheck = evidence / "w1-scored-native/parent-independent-oracle.json"
        assert not recheck.exists()
        with (evidence / "w1-scored-native/parent-independent-oracle.log").open("xb") as out:
            check = subprocess.run([r["environment"]["FINNOR_TEST_PYTHON"],
                str(oracle), str(observations), "--output", str(recheck)],
                cwd=root, env=env, stdout=out, stderr=subprocess.STDOUT,
                timeout=min(10, deadline - time.monotonic()), check=False)
        assert check.returncode == 0 and json.loads(recheck.read_text())["status"] == "PASS"
        assert not sources(), "SOURCE_DRIFT_AFTER_NATIVE_EXECUTION"
        assert time.monotonic() < deadline, "COMPLETE_NATIVE_PARENT_BOUND"
        artifacts = {}
        for name in ("pre-run-freeze.json", "results.json", "w1-runner-receipt.json",
                "w1-scored-native/native-story.json", "w1-scored-native/p7-currentness.json",
                "w1-scored-native/observations.json", "w1-scored-native/parent-independent-oracle.json",
                "w1-scored-native/terminal-owner-cuts.json"):
            artifacts[name] = hashlib.sha256((evidence / name).read_bytes()).hexdigest()
        result.update(status="PASS_CONTROLLED_NATIVE_CURRENT_REGISTERED_CUT",
            frozenSources=len(r["sourceFiles"]), allFrozenBytesStillCurrent=True,
            independentRecheckExitCode=check.returncode,
            unchangedOracleSha256=r["nativeOracleSha256"], artifacts=artifacts,
            originalNetEquity="43", originalLeverage="7/2",
            p7Coverage="ACTUAL_TERMINAL_RESOURCE_SLICE_NOT_FULL_W007",
            engineeringReviewConcurrency=r["engineeringReviewConcurrency"])
    except Exception as error:
        result.update(status="FAIL" if child else "NOT_RUN", failure=str(error),
            failureType=type(error).__name__)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            stop_owned_group()
        except Exception as error:
            result.update(status="FAIL", cleanupFailure=str(error), cleanupFailureType=type(error).__name__)
        elapsed = time.monotonic() - began
        if elapsed >= PARENT_LIMIT_SECONDS:
            result.update(status="FAIL" if child else "NOT_RUN",
                failure="COMPLETE_NATIVE_PARENT_BOUND", failureType="TimeoutError")
        result.update(completedAt=datetime.now(timezone.utc).isoformat(),
            wallSeconds=elapsed, measurementCut="AFTER_ARTIFACT_HASHES_AND_FINAL_OWNED_GROUP_CLEANUP")
        with parent.open("x") as out:
            json.dump(result, out, indent=2)
            out.write("\n")
    print(json.dumps(result))
    return 0 if result["status"] == "PASS_CONTROLLED_NATIVE_CURRENT_REGISTERED_CUT" else 1


if __name__ == "__main__":
    sys.exit(main())
