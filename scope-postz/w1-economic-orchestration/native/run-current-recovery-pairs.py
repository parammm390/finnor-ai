"""Exact current-cut recovery pairs; only each registered old repair is toggled.

This is disposable verification, not a revert or a new product implementation.
The parent holds the heavy slot for the entire finite paired epoch. Every
original target is read, hash-checked and restored in finally, even on failure.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
SCOPE = ROOT / "scope-postz/w1-economic-orchestration"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    plan = json.loads(Path(sys.argv[1]).read_text())
    destination = Path(sys.argv[2])
    assert destination.is_absolute() and not destination.exists()
    destination.mkdir()
    start = time.monotonic()
    results = []
    record = {"schema": "finnor.w1.current-recovery-pairs.v1", "status": "NOT_RUN",
              "startedAt": datetime.now(timezone.utc).isoformat(), "results": results,
              "originalDeadlinesExtended": False, "oldEvidenceReusedAsCurrentPass": False}
    node = plan["runtimes"]["node"]["path"]
    python = plan["runtimes"]["python"]["path"]
    loader = str(ROOT / "finnor-os/node_modules/tsx/dist/loader.mjs")
    environment = dict(os.environ, FINNOR_TEST_NODE=node, FINNOR_TEST_PYTHON=python)
    def interrupted(_signal, _frame):
        raise InterruptedError("OWNED_PAIRED_EPOCH_INTERRUPTED")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        for pair in plan["recoveryPairs"]:
            target = ROOT / pair["target"]
            original = target.read_bytes()
            assert sha(original) == pair["repairedSha256"], "EXACT_REGISTERED_REPAIRED_SOURCE_REQUIRED"
            broken_path = ROOT / pair["brokenSource"]
            assert broken_path.resolve(strict=True).is_relative_to(ROOT) and not broken_path.is_symlink()
            broken = broken_path.read_bytes()
            assert sha(broken) == pair["brokenSha256"], "EXACT_REGISTERED_BROKEN_SOURCE_REQUIRED"
            assert sha((ROOT / pair["contract"]).read_bytes()) == pair["contractSha256"], "EXACT_ORIGINAL_RECOVERY_CONTRACT_REQUIRED"
            try:
                baseline = None
                for phase in ("broken", "repaired"):
                    target.write_bytes(broken if phase == "broken" else original)
                    evidence = destination / (pair["id"] + "-" + phase)
                    command = [node, "--import=" + str(ROOT / "finnor-os/scripts/postz-w1/read-network-guard.mjs"),
                               "--import=" + loader, str(ROOT / "finnor-os/scripts/postz-w1/recovery-bootstrap.mts"),
                               "--phase", phase, "--evidence", str(evidence), "--python", python,
                               "--tsx", loader, "--contract", str(ROOT / pair["contract"])]
                    if pair["id"] == "control":
                        command += ["--scenario", "control"]
                    if baseline:
                        command += ["--baseline", str(baseline)]
                    actual_sources = []
                    for entry in plan["sourceFiles"]:
                        raw = (ROOT / entry["path"]).read_bytes()
                        expected = pair["brokenSha256"] if phase == "broken" and entry["path"] == pair["target"] else entry["sha256"]
                        assert sha(raw) == expected, "UNREGISTERED_SOURCE_CHANGE_DURING_PAIR:" + entry["path"]
                        actual_sources.append(dict(entry, sha256=sha(raw), bytes=len(raw)))
                    registration = destination / (pair["id"] + "-" + phase + ".registration.json")
                    registration.write_text(json.dumps({
                        "schema": "finnor.w1.physical-recovery-registration.v1", "state": "NOT_RUN",
                        "phase": phase, "scenario": "CONTROL_W1_PRE_ADMISSION" if pair["id"] == "control" else "ORIGINAL_EXECUTE_AND_UNKNOWN",
                        "command": command, "sourceCommit": plan["sourceCommit"], "sourceFiles": actual_sources,
                        "evidence": str(evidence), "wrapperLog": str(evidence) + ".wrapper.log",
                    }, indent=2) + "\n")
                    parent = [python, str(SCOPE / "native/qualify-physical-recovery.py"), str(registration)]
                    with (destination / (pair["id"] + "-" + phase + ".outer.log")).open("x") as log:
                        child = subprocess.Popen(parent, cwd=ROOT, env=environment,
                                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                        try:
                            code = child.wait(timeout=450)
                        finally:
                            previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
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
                            for sig, handler in previous.items():
                                signal.signal(sig, handler)
                    gate = json.loads(Path(str(evidence) + ".parent-gate.json").read_text())
                    expected_status = "EXPECTED_FIRST_FAILURE_RETAINED" if phase == "broken" else "PASS_LOCAL"
                    row = {"id": pair["id"], "phase": phase, "childExitCode": code,
                           "expectedStatus": expected_status, "actualGate": gate, "evidence": str(evidence)}
                    results.append(row)
                    assert gate["status"] == expected_status, "OWNING_RECOVERY_GATE_DID_NOT_MATCH_REGISTERED_PHASE"
                    assert code == (1 if phase == "broken" else 0), "PARENT_EXIT_MUST_MATCH_OWNING_ARTIFACT"
                    if phase == "broken":
                        baseline = evidence / "execution/observations.json"
            finally:
                previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
                target.write_bytes(original)
                assert sha(target.read_bytes()) == pair["repairedSha256"], "REPAIRED_SOURCE_RESTORE_REQUIRED"
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
        record["status"] = "PASS_LOCAL_CURRENT_PAIRED_RECOVERY"
    except Exception as error:
        record.update(status="FAIL", failure=str(error), failureType=type(error).__name__)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        record["allRegisteredSourcesRestored"] = all(sha((ROOT / entry["path"]).read_bytes()) == entry["sha256"]
                                                     for entry in plan["sourceFiles"])
        if not record["allRegisteredSourcesRestored"]:
            record["status"] = "FAIL"
        record["durationSeconds"] = time.monotonic() - start
        record["completedAt"] = datetime.now(timezone.utc).isoformat()
        (destination / "results.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record))
    return 0 if record["status"] == "PASS_LOCAL_CURRENT_PAIRED_RECOVERY" else 1


if __name__ == "__main__":
    sys.exit(main())
