"""Bound and retain one unchanged actual W1 owning driver on ordinary Linux."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
GIB = 1024 ** 3
MODES = ("native", "abc", "internal-read-standing", "internal-pressure",
         "internal-revocation", "internal-sequential", "internal-drift")


def census():
    rows = {}
    for line in subprocess.check_output(["ps", "-eo", "pid=,ppid=,lstart=,args="], text=True).splitlines():
        parts = line.split(None, 7)
        if len(parts) == 8:
            rows[int(parts[0])] = (int(parts[1]), " ".join(parts[2:7]))
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=MODES)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    assert sys.platform == "linux", "ORDINARY_LINUX_REQUIRED"
    assert args.output.is_absolute() and not args.output.exists(), "NEW_ABSOLUTE_OUTPUT_REQUIRED"
    os.umask(0o077)
    args.output.mkdir(parents=True)
    report = args.output / "report"
    report.mkdir()
    temporary = args.output / "private-temporary"
    temporary.mkdir()
    owner = args.output / "owner"
    node = shutil.which("node")
    scientific = Path(os.environ["FINNOR_TEST_PYTHON"]).absolute()
    assert node and scientific.is_file()
    env = {**os.environ, "FINNOR_TEST_NODE": str(Path(node).resolve()),
           "FINNOR_TEST_PYTHON": str(scientific), "TMPDIR": str(temporary)}
    native = args.mode == "native"
    body_limit = 300 if native else 1200
    script = "native-run.py" if native else "owning-suite-run.py"
    command = [sys.executable, str(ROOT / "finnor-os/scripts/postz-w1" / script), str(owner)]
    if not native:
        command += ["--mode", args.mode]
    record = {"schema": "finnor.w1.linux-owning-episode.v1", "status": "RUNNING",
              "mode": args.mode, "command": command, "startedAt": time.time(),
              "limits": {"originalBodySeconds": body_limit, "cleanupSeconds": 60,
                         "initialDiskBytes": 4 * GIB, "continuousDiskBytes": 3 * GIB,
                         "additionalDiskBytes": 4 * GIB, "initialMemoryBytes": 4 * GIB},
              "qualification": "ACTUAL_SOURCE_OWNER_NOT_EMITTED_COLD_HEADED_OR_PROTECTED"}
    child = None
    owned = {}

    def save():
        (report / "receipt.json").write_text(json.dumps(record, indent=2) + "\n")

    def interrupted(number, _frame):
        raise InterruptedError("OWNED_W1_EPISODE_INTERRUPTED_" + str(number))

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    save()
    try:
        with open("/tmp/finnor-w123-local-heavy.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            assert subprocess.check_output([node, "--version"], text=True).strip() == "v22.22.3"
            assert subprocess.check_output([str(scientific), "--version"], text=True).strip() == "Python 3.12.13"
            assert not subprocess.check_output(["git", "status", "--porcelain=v1"], cwd=ROOT).strip()
            record["sourceCommit"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
            record["sourceTree"] = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=ROOT, text=True).strip()
            record["inputSources"] = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in (
                "package-lock.json", "finnor-os/package-lock.json", "finnor-os/scripts/p2/run-e2e.mts",
                "finnor-os/scripts/postz-w1/requirements-native.txt", "finnor-os/scripts/postz-w1/" + script)}
            initial = shutil.disk_usage(args.output).free
            available = int(re.search(r"^MemAvailable:\s+(\d+)", Path("/proc/meminfo").read_text(), re.M)[1]) * 1024
            assert initial >= 4 * GIB and available >= 4 * GIB, "ORIGINAL_RESOURCE_FLOOR_UNAVAILABLE"
            record["initialDiskBytes"] = initial
            record["initialAvailableMemoryBytes"] = available
            deadline = time.monotonic() + body_limit + 60
            with (args.output / "private-runner.log").open("x") as log:
                child = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log,
                                         stderr=subprocess.STDOUT, start_new_session=True)
                while child.poll() is None:
                    rows = census()
                    current = {child.pid}
                    while True:
                        more = {pid for pid, (parent, _) in rows.items() if parent in current}
                        if more <= current:
                            break
                        current |= more
                    owned.update({pid: rows[pid][1] for pid in current if pid in rows})
                    free = shutil.disk_usage(args.output).free
                    assert free >= 3 * GIB and initial - free <= 4 * GIB, "ORIGINAL_CONTINUOUS_DISK_BOUND"
                    assert time.monotonic() < deadline, "ORIGINAL_OWNING_AND_CLEANUP_BOUND"
                    time.sleep(0.5)
            record["childExitCode"] = child.returncode
            name = "w1-runner-receipt.json" if native else "owning-suite-runner-receipt.json"
            receipt = json.loads((owner / name).read_text())
            (report / name).write_text(json.dumps(receipt, indent=2) + "\n")
            owning = json.loads((owner / "results.json").read_text())
            pressure_preparation = owner / "internal-pressure/source-preparation.json"
            if args.mode == "internal-pressure" and pressure_preparation.exists():
                shutil.copyfile(pressure_preparation, report / "pressure-source-preparation.json")
            cases = []
            for row in owning["results"]:
                observed = row.get("observed", {})
                message = observed.get("message", "") if isinstance(observed, dict) else ""
                stack = observed.get("stack", "") if isinstance(observed, dict) else ""
                cases.append({"id": row["id"], "status": row["status"], "input": row.get("input"),
                              "predicate": row.get("predicate"),
                              "failureCodes": sorted(set(re.findall(r"\b[A-Z][A-Z0-9_]{4,127}\b", str(message)))),
                              "frames": [line for line in str(stack).splitlines()[1:]
                                         if re.match(r"^\s+at [A-Za-z0-9_.$<> /:@()\[\]-]+:\d+:\d+\)?$", line)]})
            (report / "owning-observations.json").write_text(json.dumps({
                "status": owning["status"], "migrationNames": owning["migrationNames"],
                "observedMigrationNames": owning["observedMigrationNames"], "cases": cases,
                "shutdown": owning["shutdown"], "rawRuntimeUploaded": False}, indent=2) + "\n")
            internal_diagnostics = []
            for group, key in (("internal-revocation", "boundary"), ("internal-drift", "facet")):
                for path in sorted((owner / group).glob("*.json")):
                    observed = json.loads(path.read_text())
                    if not isinstance(observed, dict) or key not in observed:
                        continue
                    failure = str(observed.get("failure", ""))
                    stack = str(observed.get("stack", ""))
                    internal_diagnostics.append({key: observed[key], "status": observed.get("status"),
                        "failureCodes": sorted(set(re.findall(r"\b[A-Z][A-Z0-9_]{4,127}\b", failure))),
                        "frames": [line for line in stack.splitlines()[1:]
                                   if re.match(r"^\s+at [A-Za-z0-9_.$<> /:@()\[\]-]+:\d+:\d+\)?$", line)]})
            if internal_diagnostics:
                (report / "internal-boundary-diagnostics.json").write_text(
                    json.dumps(internal_diagnostics, indent=2) + "\n")
            assert child.returncode == 0, "ORIGINAL_DRIVER_FAILED"
            assert receipt["status"] == ("PASS_LOCAL_NATIVE_BOOTSTRAP" if native else
                "PASS_LOCAL_OWNING_SOURCE_SUITE" if args.mode == "abc" else "PASS_LOCAL_INTERNAL_OWNING_GROUP")
            assert owning["status"] == "PASS_LOCAL" and owning["shutdown"]["complete"] is True
            assert not subprocess.check_output(["git", "diff", "--name-only"], cwd=ROOT).strip(), "SOURCE_DRIFT"
            record["status"] = "PASS"
    except Exception as error:
        record.update(status="FAIL", failureType=type(error).__name__,
                      failureCodes=sorted(set(re.findall(r"\b[A-Z][A-Z0-9_]{4,127}\b", str(error)))))
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        rows = census()
        lingering_before = [pid for pid, identity in owned.items() if pid in rows and rows[pid][1] == identity]
        if lingering_before:
            record.update(status="FAIL", cleanupRequiredAfterDriver=len(lingering_before))
            for number in (signal.SIGTERM, signal.SIGKILL):
                rows = census()
                for pid, identity in owned.items():
                    if pid in rows and rows[pid][1] == identity:
                        try:
                            os.kill(pid, number)
                        except ProcessLookupError:
                            pass
                if number == signal.SIGTERM:
                    time.sleep(2)
            if child:
                child.wait(timeout=10)
        rows = census()
        lingering = [pid for pid, identity in owned.items() if pid in rows and rows[pid][1] == identity]
        if lingering:
            record.update(status="FAIL", ownedProcessesStillPresent=len(lingering))
        record["finishedAt"] = time.time()
        save()
    print(json.dumps(record))
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
