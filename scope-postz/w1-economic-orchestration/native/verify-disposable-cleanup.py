"""E2E actual embedded PG, not a stubbed cleanup or a unit test."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from disposable_cleanup import cleanup_namespace

root = Path(__file__).resolve().parents[3]
destination = Path(sys.argv[1])
assert destination.is_absolute() and not destination.exists()
destination.mkdir(parents=True)
node = Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True)
parent = Path(os.environ["TMPDIR"]).resolve(strict=True)
subject = root / "finnor-os/scripts/postz-w1/disposable-postgres-case.mts"
sources = [subject, subject.with_name("disposable-postgres.mjs"), Path(__file__), Path(__file__).with_name("disposable_cleanup.py")]
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
pins = {str(path): sha(path) for path in sources}
report = {"schema": "finnor.w1.disposable-postgres-e2e.v1", "status": "FAIL",
    "startedAt": datetime.now(timezone.utc).isoformat(), "sourcesBefore": pins, "cases": [],
    "qualification": "REAL_FRESH_EMBEDDED_POSTGRES_CLEANUP_ONLY_NOT_W1_FAMILY_COMPLETION",
    "businessPredicatesChanged": False, "billingUSD": None}
cancelled = False


def interrupted(signum, _frame):
    global cancelled
    cancelled = True
    raise InterruptedError("CLEANUP_E2E_INTERRUPTED_" + str(signum))


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    for mode in ("success", "initialise-failure", "setup-failure", "signal", "timeout", "forced-exit", "hard-kill"):
        output = destination / mode
        output.mkdir()
        temporary = Path(tempfile.mkdtemp(prefix="finnor-w1-run-", dir=parent)).resolve(strict=True)
        stat = temporary.stat()
        row = {"mode": mode, "status": "FAIL", "temporaryNamespace": str(temporary)}
        report["cases"].append(row)
        child = None
        try:
            with (output / "subject.log").open("x") as log:
                child = subprocess.Popen([str(node), "--import=tsx", str(subject), mode, str(output)],
                    cwd=root / "finnor-os", env=dict(os.environ, TMPDIR=str(temporary)),
                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                if mode in ("signal", "timeout", "hard-kill"):
                    deadline = time.monotonic() + 30
                    ready = output / "ready.json"
                    while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    assert ready.exists(), "REAL_PG_READY_CUT_REQUIRED"
                    row["ready"] = json.loads(ready.read_text())
                    if mode == "timeout":
                        try:
                            child.wait(timeout=0.1)
                        except subprocess.TimeoutExpired:
                            row["actualWaitTimedOut"] = True
                            child.send_signal(signal.SIGTERM)
                        else:
                            raise AssertionError("ACTUAL_TIMEOUT_REQUIRED")
                    else:
                        child.send_signal(signal.SIGKILL if mode == "hard-kill" else signal.SIGTERM)
                row["childExitCode"] = child.wait(timeout=30)
            assert row["childExitCode"] == {"success": 0, "initialise-failure": 17,
                "setup-failure": 17, "signal": 143, "timeout": 143, "forced-exit": 124, "hard-kill": -9}[mode]
            cleanup = json.loads((output / "postgres-cleanup.json").read_text())
            row["ownerCleanup"] = cleanup
            if mode == "hard-kill":
                assert cleanup["status"] == "NOT_CLEANED" and Path(cleanup["directory"]).is_dir()
            else:
                assert cleanup["status"] == "PASS" and cleanup["clusterStopped"] and cleanup["directoryRemoved"]
                assert not Path(cleanup["directory"]).exists()
            row["status"] = "PASS"
        except Exception as error:
            row.update(failure=str(error), failureType=type(error).__name__)
            if cancelled:
                raise
        finally:
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            try:
                row["namespaceCleanup"] = cleanup_namespace(temporary, parent=parent,
                    identity=(stat.st_dev, stat.st_ino))
                if mode == "hard-kill":
                    assert row["ready"]["postgresPid"] in row["namespaceCleanup"]["stoppedPids"]
            except Exception as error:
                row.update(status="FAIL", cleanupFailure=str(error))
            if child is not None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
    report["sourcesAfter"] = {str(path): sha(path) for path in sources}
    assert pins == report["sourcesAfter"], "CLEANUP_SOURCE_DRIFT"
    assert len(report["cases"]) == 7 and all(row["status"] == "PASS" for row in report["cases"])
    report["status"] = "PASS_REAL_POSTGRES_LIFECYCLE_AND_HARD_KILLED_OWNER_CLEANUP"
except Exception as error:
    report.update(failure=str(error), failureType=type(error).__name__)
finally:
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    (destination / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "cases": [
        {"mode": row["mode"], "status": row["status"], "failure": row.get("failure"),
         "cleanupFailure": row.get("cleanupFailure")} for row in report["cases"]]}))
raise SystemExit(0 if report["status"].startswith("PASS_") else 1)
