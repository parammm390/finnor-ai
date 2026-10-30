"""Portable public CI replay. No native, protected or business admission."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    args = parser.parse_args()
    if not args.repo.is_absolute() or not args.evidence_dir.is_absolute():
        parser.error("absolute checkout and new evidence paths required")
    repo, out = args.repo.resolve(), args.evidence_dir.resolve()
    out.mkdir(mode=0o700)
    scripts = repo/"finnor-os/scripts/project-z/z2"
    deadline = time.monotonic()+570
    active = None
    steps = []
    report = {"schema": "finnor.project-z.z2.portable-ci.v1", "status": "FAIL",
              "passed": 0, "failed": 1, "cases": [], "wholePhaseAccepted": False,
              "protectedAdmission": False, "business100x": "NOT_ESTABLISHED"}

    def stop():
        if active is not None:
            try:
                os.killpg(active.pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            try:
                active.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(active.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            active.wait()

    def interrupted(number, frame):
        stop()
        raise SystemExit(128+number)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)

    def run(label, arguments, maximum):
        nonlocal active
        command = [sys.executable, "-I", "-B", *map(str, arguments)]
        row = {"label": label, "command": command, "exitCode": None,
               "startedAt": time.time(), "timedOut": False}
        steps.append(row)
        with (out/(label+".stdout")).open("x") as stdout, (out/(label+".stderr")).open("x") as stderr:
            active = subprocess.Popen(command, cwd=repo, stdout=stdout, stderr=stderr,
                                      start_new_session=True)
            try:
                row["exitCode"] = active.wait(timeout=max(0.01, min(maximum, deadline-time.monotonic())))
            except subprocess.TimeoutExpired:
                row["timedOut"] = True
                stop()
                row["exitCode"] = active.returncode
                raise
            finally:
                row["finishedAt"] = time.time()
                if active.poll() is not None:
                    active = None
        assert row["exitCode"] == 0, label.upper()+"_PROCESS_FAILED"

    try:
        registration = out/"registration"
        run("freeze", [scripts/"fresh-structural-fixtures.py", "--repo", repo, "--out", registration,
                      "--failure-map", repo/"docs/centropy/project-z-delivery-failure-modes.md"], 120)
        frozen = json.loads((registration/"registration.json").read_text())
        assert frozen["status"] == "FROZEN" and frozen["familyCount"] == 32
        assert len(frozen["cases"]) == 256 and frozen["candidateInvocationsBeforeFreeze"] == 0
        critical = scripts/"ci-critical-expectations.json"
        run("qualification", [scripts/"structural-replay.py", "--repo", repo,
                             "--evidence-dir", out/"qualification",
                             "--qualification-registration", registration/"registration.json",
                             "--reference-root", repo, "--critical-expectations", critical,
                             "--budget-ms", "20000"], 450)
        result = json.loads((out/"qualification/report.json").read_text())
        assert result["passed"] == 256 and result["failed"] == 0 and len(result["cases"]) == 256
        assert all(row["passed"] for row in result["cases"])
        assert result["structuralFamiliesQualified"] == 32 and result["sourceUnchanged"] is True
        assert result["usefulSupportedPositiveCount"] == result["usefulSupportedPositivePassed"] == 248
        assert len(result["negatives"]) == 254 and all(row["passed"] for row in result["negatives"])
        assert len(result["steps"]) == 1510 and all(row["exitCode"] == 0 and row["signal"] is None
                                                  for row in result["steps"])
        report = {**result, "status": "PASS_PUBLIC_SOURCE_REPLAY_ONLY",
                  "publicReplayNotNewIndependentAdmission": True,
                  "qualificationReportSha256": hashlib.sha256((out/"qualification/report.json").read_bytes()).hexdigest()}
        return 0
    except BaseException as error:
        report["failure"] = type(error).__name__
        return 1
    finally:
        stop()
        report["ciSteps"] = steps
        (out/"report.json").write_text(json.dumps(report, indent=2)+"\n")
        print(json.dumps({"status": report["status"], "passed": report["passed"], "failed": report["failed"]}))


if __name__ == "__main__":
    raise SystemExit(main())
