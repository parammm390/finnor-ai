"""Finite real-process proof of W1 admission refusal, locks, and owned cleanup."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
args = parser.parse_args()
assert args.output.is_absolute() and not args.output.exists()
assert shutil.disk_usage(args.output.parent).free >= 1024 ** 3, "LIGHTWEIGHT_CHECK_REQUIRES_ONE_GIB_FREE"
args.output.mkdir(mode=0o700)
native = Path(__file__).resolve().parent
root = native.parents[2]
wrapper = native / "with-resources.py"
report = {"schema": "finnor.w1.portable-admission-verification.v1", "status": "FAIL",
    "startedAt": datetime.now(timezone.utc).isoformat(), "cases": [],
    "qualification": "REAL_LOCAL_RESOURCE_OWNER_PROCESSES_ONLY_NOT_FINNOR_FUNCTIONAL_OR_COLD_PROOF",
    "functionalOwnerStages": "NOT_RUN", "coldReconstruction": "NOT_RUN"}
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
paths = [wrapper, native / "disposable_cleanup.py", native / "portable-campaign-failure-contract-v1.md"]
report["sourcesBefore"] = {str(path): sha(path) for path in paths}
children = []
namespaces = []


def check(identity, action):
    row = {"id": identity, "status": "FAIL"}
    report["cases"].append(row)
    try:
        action(row)
        row["status"] = "PASS"
    except Exception as error:
        row.update(failure=str(error), failureType=type(error).__name__)


def refusal(row):
    policy = {"coordinationDirectory": str(args.output / "coordination"),
        "heavyLockPath": "/tmp/finnor-w123-local-heavy.lock" if sys.platform == "darwin" else
            "/home/factory-user/mission/evidence/locks/w123-heavy.lock",
        "globalDiskFloorBytes": 3 * 1024 ** 3,
        "laneNetNewBudgetBytes": max(4 * 1024 ** 3, shutil.disk_usage(root).free + 1),
        "lockWaitSeconds": 1200, "maximumLoadFraction": 0.5,
        "minimumAvailableMemoryBytes": 2 * 1024 ** 3}
    plan = args.output / "resource-plan.json"
    plan.write_text(json.dumps({"state": "FROZEN_EXECUTABLE_W1_SCOPED_NOT_COMPLETE", "resourcePolicy": policy}))
    receipt, sentinel = args.output / "refusal.json", args.output / "child-was-launched"
    command = [sys.executable, str(wrapper), "--plan", str(plan), "--forecast-bytes",
        str(shutil.disk_usage(root).free + 1), "--receipt", str(receipt), "--timeout", "5", "--",
        sys.executable, "-c", "from pathlib import Path; import sys; Path(sys.argv[1]).touch()", str(sentinel)]
    result = subprocess.run(command, cwd=root, text=True, capture_output=True, timeout=10)
    row.update(command=command, exitCode=result.returncode, stdout=result.stdout, stderr=result.stderr)
    assert receipt.is_file(), "RESOURCE_OWNER_MUST_RETAIN_A_REFUSAL_RECEIPT"
    observed = json.loads(receipt.read_text())
    row["receipt"] = observed
    assert result.returncode == 1 and observed["status"] == "NOT_RUN"
    assert observed["failure"] == "GLOBAL_DISK_FLOOR_PREFLIGHT"
    assert observed["childExitCode"] is None and not sentinel.exists()
    assert observed["lockReleases"] == []


def locks(row):
    subject = runpy.run_path(str(wrapper), run_name="w1_resource_owner")
    lock_path = args.output / "owned-probe.lock"
    held = subject["FileLock"](lock_path)
    assert held.acquire() is True
    child_code = ("import json,pathlib,runpy,sys; sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent)); "
        "owner=runpy.run_path(sys.argv[1],run_name='w1_resource_owner'); "
        "lock=owner['FileLock'](__import__('pathlib').Path(sys.argv[2])); "
        "acquired=lock.acquire(); print(json.dumps({'acquired':acquired})); "
        "lock.release() if acquired else None")
    command = [sys.executable, "-B", "-c", child_code, str(wrapper), str(lock_path)]
    try:
        first = subprocess.run(command, text=True, capture_output=True, timeout=5)
        row["whileHeldProcess"] = {"exitCode": first.returncode, "stdout": first.stdout, "stderr": first.stderr}
        assert first.returncode == 0, "LOCK_OWNER_CHILD_FAILED"
        assert json.loads(first.stdout) == {"acquired": False}, "ACTUAL_SECOND_PROCESS_MUST_BE_EXCLUDED"
    finally:
        release = held.release()
    second = subprocess.run(command, text=True, capture_output=True, timeout=5)
    row["afterReleaseProcess"] = {"exitCode": second.returncode, "stdout": second.stdout, "stderr": second.stderr}
    assert second.returncode == 0, "LOCK_OWNER_CHILD_FAILED_AFTER_RELEASE"
    assert json.loads(second.stdout) == {"acquired": True}, "RELEASE_MUST_ADMIT_NEXT_PROCESS"
    assert lock_path.is_file(), "LOCK_INODE_MUST_NOT_BE_UNLINKED"
    row.update(command=command, whileHeld=json.loads(first.stdout), afterRelease=json.loads(second.stdout),
        release=release, inodeRetained=True)


def cleanup(row):
    subject = runpy.run_path(str(native / "disposable_cleanup.py"), run_name="w1_cleanup_owner")
    directory = Path(tempfile.mkdtemp(prefix="finnor-w1-run-", dir="/tmp")).resolve(strict=True)
    stat = directory.stat()
    namespaces.append((directory, (stat.st_dev, stat.st_ino)))
    ready = args.output / "open-file-ready"
    command = [sys.executable, "-B", "-c",
        "import pathlib,sys,time; stream=open(sys.argv[1],'w'); pathlib.Path(sys.argv[2]).touch(); time.sleep(20)",
        str(directory / "owned-open-file"), str(ready)]
    child = subprocess.Popen(command, start_new_session=True)
    children.append(child)
    deadline = time.monotonic() + 5
    while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
        time.sleep(0.02)
    assert ready.exists(), "REAL_FILE_HOLDER_READY_REQUIRED"
    try:
        subject["cleanup_namespace"](directory, identity=(stat.st_dev, stat.st_ino))
    except AssertionError as error:
        assert str(error) == "OWNED_TMPDIR_OPEN_FILES_RETAINED"
        row["whileOpen"] = str(error)
    else:
        raise AssertionError("OPEN_NAMESPACE_MUST_NOT_BE_REMOVED")
    assert directory.is_dir() and child.poll() is None
    child.terminate()
    child.wait(timeout=5)
    row.update(command=command, afterStop=subject["cleanup_namespace"](directory,
        identity=(stat.st_dev, stat.st_ino)))
    assert row["afterStop"]["status"] == "PASS" and not directory.exists()


try:
    check("disk-refusal-before-child", refusal)
    check("real-process-exclusive-lock-and-release", locks)
    check("open-owned-file-blocks-cleanup-then-stops", cleanup)
    report["sourcesAfter"] = {str(path): sha(path) for path in paths}
    assert report["sourcesAfter"] == report["sourcesBefore"], "SOURCE_DRIFT_DURING_VERIFICATION"
    if all(row["status"] == "PASS" for row in report["cases"]):
        report["status"] = "PASS_LOCAL_PORTABLE_RESOURCE_OWNER_ONLY"
finally:
    for child in children:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
    for directory, identity in namespaces:
        if directory.exists():
            try:
                runpy.run_path(str(native / "disposable_cleanup.py"))["cleanup_namespace"](directory, identity=identity)
            except Exception as error:
                report.update(status="FAIL", cleanupFailure=str(error))
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "cases": [
        {key: row.get(key) for key in ("id", "status", "failure")} for row in report["cases"]]}))
raise SystemExit(0 if report["status"] == "PASS_LOCAL_PORTABLE_RESOURCE_OWNER_ONLY" else 1)
