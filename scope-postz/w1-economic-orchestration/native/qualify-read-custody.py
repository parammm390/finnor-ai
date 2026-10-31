"""Run the owning read driver and mandatory verifier in one fixed 1200s epoch."""
from __future__ import annotations

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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    evidence = args.evidence
    if not evidence.is_absolute() or evidence.exists():
        raise RuntimeError("NEW_ABSOLUTE_EVIDENCE_DIRECTORY_REQUIRED")
    root = Path(__file__).resolve().parents[3]
    owner = root / "finnor-os"
    node = Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True)
    loader = owner / "node_modules/tsx/dist/loader.mjs"
    guard = owner / "scripts/postz-w1/read-network-guard.mjs"
    driver = owner / "scripts/postz-w1/run-economic-reads-native.mts"
    verifier = owner / "scripts/postz-w1/verify-read-artifact.mts"
    receipt = Path(str(evidence) + ".qualification.json")
    if receipt.exists():
        raise RuntimeError("QUALIFICATION_RECEIPT_ALREADY_EXISTS")
    started = time.monotonic()
    deadline = started + 1200
    stages: list[dict] = []
    environment = dict(os.environ, FINNOR_W1_READ_EVIDENCE_DIR=str(evidence))
    cancelled = False
    def interrupted(signum, _frame):
        nonlocal cancelled
        cancelled = True
        raise InterruptedError("READ_CUSTODY_INTERRUPTED_" + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)

    def run_stage(name: str, command: list[str]) -> None:
        log = Path(str(evidence) + f".{name}.log")
        stage = {"name": name, "command": command, "status": "NOT_RUN",
                 "log": str(log), "exitCode": None}
        stages.append(stage)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            stage["reason"] = "COMBINED_1200_SECOND_DEADLINE_EXHAUSTED"
            return
        at = time.monotonic()
        with log.open("xb") as output:
            child = subprocess.Popen(command, cwd=owner, env=environment,
                                     stdout=output, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            try:
                stage["exitCode"] = child.wait(timeout=remaining)
                stage["status"] = "PASS" if child.returncode == 0 else "FAIL"
            except Exception as error:
                stage.update(status="TIMEOUT" if isinstance(error, subprocess.TimeoutExpired) else "FAIL",
                             failure=repr(error))
            finally:
                previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
                try:
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
                    stage["exitCode"] = child.returncode
                except Exception as error:
                    stage.update(status="FAIL", cleanupFailure=repr(error))
                stage["durationSeconds"] = time.monotonic() - at
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
        stage["logSha256"] = hashlib.sha256(log.read_bytes()).hexdigest()

    try:
        run_stage("driver", [str(node), f"--import={guard}",
                            f"--import={loader}", str(driver)])
        if not cancelled:
            run_stage("verifier", [str(node), f"--import={loader}", str(verifier),
                                  str(evidence)])
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        report_path = evidence / "results.json"
        try:
            report = json.loads(report_path.read_text()) if report_path.exists() else {}
        except (OSError, ValueError) as error:
            report = {"status": "INVALID_OR_INTERRUPTED_ARTIFACT", "artifactFailure": repr(error)}
        usage = resource.getrusage(resource.RUSAGE_CHILDREN)
        success = (len(stages) == 2
                   and all(stage["status"] == "PASS" for stage in stages)
                   and report.get("status") == "PASS_LOCAL"
                   and report.get("shutdown", {}).get("complete") is True
                   and report.get("shutdown", {}).get("postgres", {}).get("status") == "PASS"
                   and time.monotonic() <= deadline)
        result = {
            "schema": "finnor.w1.read-custody-qualification.v1",
            "status": "PASS_LOCAL" if success else "FAIL",
            "evidence": str(evidence), "combinedLimitSeconds": 1200,
            "elapsedSeconds": time.monotonic() - started, "stages": stages,
            "reportStatus": report.get("status", "NOT_AVAILABLE"),
            "reportSha256": hashlib.sha256(report_path.read_bytes()).hexdigest()
            if report_path.exists() else None,
            "shutdown": report.get("shutdown", {"complete": False}),
            "predicateCounts": {
                state: sum(row.get("status") == state
                           for row in report.get("results", []))
                for state in ("PASS", "FAIL", "NOT_RUN")
            },
            "childUserSeconds": usage.ru_utime,
            "childSystemSeconds": usage.ru_stime,
            "childMaxRss": usage.ru_maxrss,
            "maxRssQualification": "OS child maximum, not simultaneous descendant aggregate",
            "billingUSD": None, "humanSeconds": None, "missingCostIsZero": False,
            "qualification": "Disposable local owning custody only, not phase completion",
        }
        with receipt.open("x") as output:
            output.write(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
