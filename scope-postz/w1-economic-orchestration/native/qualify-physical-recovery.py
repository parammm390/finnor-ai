"""Qualify retained physical receipts, never a masked bootstrap exit alone."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("registration", type=Path)
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    registration = arguments.registration
    if not registration.is_absolute() or not registration.is_file():
        raise RuntimeError("ABSOLUTE_EXISTING_REGISTRATION_REQUIRED")
    value = json.loads(registration.read_bytes())
    if value["schema"] != "finnor.w1.physical-recovery-registration.v1" or value["state"] != "NOT_RUN":
        raise RuntimeError("FROZEN_NOT_RUN_REGISTRATION_REQUIRED")
    control = value.get("scenario") == "CONTROL_W1_PRE_ADMISSION"
    for entry in value["sourceFiles"]:
        if hashlib.sha256((root / entry["path"]).read_bytes()).hexdigest() != entry["sha256"]:
            raise RuntimeError("REGISTERED_SOURCE_CHANGED")
    evidence = Path(value["evidence"])
    log = Path(value["wrapperLog"])
    if not evidence.is_absolute() or evidence.exists() or log.exists():
        raise RuntimeError("EXCLUSIVE_ABSOLUTE_EVIDENCE_REQUIRED")
    started = time.monotonic()
    receipt = {
        "schema": "finnor.w1.parent-physical-process-gate.v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "phase": value["phase"], "status": "FAIL", "exitCode": 2,
        "registrationSha256": hashlib.sha256(registration.read_bytes()).hexdigest(),
        "rawBootstrapExitCode": None, "timedOut": False,
        "billingUSD": None, "humanSeconds": None, "completeDescendantUsage": None,
        "abruptWrapperFaultInjection": "NOT_RUN",
    }
    child = None
    def interrupted(signum, _frame):
        raise InterruptedError("PHYSICAL_RECOVERY_PARENT_INTERRUPTED_" + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        with log.open("xb") as output:
            child = subprocess.Popen(value["command"], cwd=root / "finnor-os",
                                     stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            receipt["rawBootstrapExitCode"] = child.wait(timeout=420)
    except Exception as error:
        receipt.update(timedOut=isinstance(error, subprocess.TimeoutExpired),
                       launchFailure=repr(error))
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if child is not None:
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
                receipt["rawBootstrapExitCode"] = child.returncode
            except Exception as error:
                receipt["parentCleanupFailure"] = repr(error)
    try:
        bootstrap = json.loads((evidence / "bootstrap.json").read_bytes())
        result = json.loads((evidence / "execution/result.json").read_bytes())
        oracle = json.loads((evidence / "execution/independent-recovery-oracle.json").read_bytes())
        receipt.update(bootstrapStatus=bootstrap["status"], innerExitCode=bootstrap["innerProcess"]["code"],
                       innerStatus=result["status"], expectedFailureMatch=result["expectedFailureMatch"])
        receipt["registeredSourcesUnchanged"] = all(
            hashlib.sha256((root / entry["path"]).read_bytes()).hexdigest() == entry["sha256"]
            for entry in value["sourceFiles"])
        complete = (not receipt["timedOut"] and not receipt.get("launchFailure") and not receipt.get("parentCleanupFailure")
                    and receipt["rawBootstrapExitCode"] == (1 if value["phase"] == "broken" else 0)
                    and receipt["registeredSourcesUnchanged"] and bootstrap["sourceUnchanged"]
                    and bootstrap["innerChildStopped"] and bootstrap["clusterStopped"]
                    and not bootstrap.get("cleanupFailure")
                    and result["terminalSourceFreezeMatches"] and result["baselineUnchanged"]
                    and bootstrap["wallMsThroughCleanup"] <= 390000
                    and result["totalWallMs"] <= 300000)
        broken = (value["phase"] == "broken" and bootstrap["status"] == "EXPECTED_FIRST_FAILURE_RETAINED"
                  and receipt["innerExitCode"] == 1 and result["status"] == "FAIL"
                  and result["expectedFailureMatch"] is True and oracle["expectedFailureMatch"] is True
                  and (oracle["predicate"] == "CONTROL_PRE_ADMISSION_DUPLICATE_DIGEST_ROLLBACK" if control else
                       oracle["tracks"]["A"]["predicate"] == "PLAN_QUALIFIED_PRE_ADMISSION_STUCK"
                       and oracle["tracks"]["B"]["status"] == "PASS"))
        repaired = (value["phase"] == "repaired" and bootstrap["status"] == "PASS_LOCAL_REPAIRED_RECOVERY"
                    and receipt["innerExitCode"] == 0 and result["status"] == oracle["status"] == "PASS"
                    and (oracle["predicate"] == "PASS_CONTROL_PRE_ADMISSION_MINIMUM_FALLBACK" if control else
                         all(oracle["tracks"][track]["status"] == "PASS" for track in ("A", "B"))))
        if complete and (broken or repaired):
            receipt.update(status="EXPECTED_FIRST_FAILURE_RETAINED" if broken else "PASS_LOCAL",
                           exitCode=1 if broken else 0)
    except (OSError, ValueError, KeyError, TypeError):
        receipt["failure"] = "MISSING_OR_INCOMPLETE_OR_UNEXPECTED_PHYSICAL_RECEIPT"
    receipt["wallSeconds"] = time.monotonic() - started
    receipt["logSha256"] = hashlib.sha256(log.read_bytes()).hexdigest()
    path = Path(str(evidence) + ".parent-gate.json")
    with path.open("x") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print(json.dumps(receipt))
    return receipt["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
