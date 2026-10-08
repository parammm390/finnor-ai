"""Original affected owner suites on one frozen local cut, never gate admission."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid

from closure import compare, save, snapshot

repo = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
names = ["p3", "m3", "m4", "s1", "queue-p4-ic", "completion"]
parser.add_argument("suites", nargs="*", choices=names)
parser.add_argument("--p3-cases", help="Explicit registered P3 case IDs, comma separated; omitted preserves the original run")
parser.add_argument("--m3-cases", help="Explicit original M3 case IDs, comma separated; omitted means full non-mounted run")
parser.add_argument("--completion-cases", help="Explicit registered completion case IDs, comma separated")
parser.add_argument("--cpu-profile", action="store_true", help="Diagnostic parent Node profiling for M3/completion only; clocks unchanged")
args = parser.parse_args()
selected = args.suites or names
if len(selected) != len(set(selected)):
    parser.error("Each original suite may be selected only once")
if args.m3_cases and "m3" not in selected:
    parser.error("--m3-cases requires the m3 suite")
if args.p3_cases and "p3" not in selected:
    parser.error("--p3-cases requires the p3 suite")
if args.completion_cases and "completion" not in selected:
    parser.error("--completion-cases requires the completion suite")
if args.cpu_profile and any(name not in ("m3", "completion") for name in selected):
    parser.error("--cpu-profile accepts only M3/completion diagnostic suites")
m3_cases = args.m3_cases.split(",") if args.m3_cases else None
p3_cases = args.p3_cases.split(",") if args.p3_cases else None
completion_cases = args.completion_cases.split(",") if args.completion_cases else None
for cases, label in ((p3_cases, "P3"), (m3_cases, "M3"), (completion_cases, "completion")):
    pattern = "[A-Za-z0-9-]{1,128}" if label == "P3" else "[a-z0-9-]{1,128}"
    if cases and (len(cases) != len(set(cases)) or any(not re.fullmatch(pattern, name) for name in cases)):
        parser.error(f"Original {label} selection must contain unique bounded case IDs")
output = repo / "scope-pm/completion-b/evidence/raw" / (
    "affected-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8])
output.mkdir()
env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "TMPDIR")}
python = str(repo / ".runtime/m4-numerics-312/bin/python")
env.update(
    NODE_ENV="test", CI="1", LOG_LEVEL="error", AUTH_DEV_BYPASS="1",
    FINNOR_TEST_MANAGED_EXTENSIONS="omit", RATE_LIMIT_PER_MINUTE="100000",
    P3_GOVERNORS="1", FINNOR_S3_PYTHON=python, FINNOR_S5_PYTHON=python,
    FINNOR_M4_PYTHON=python, FINNOR_M3_PROFILE="DISPOSABLE_NATIVE",
    FINNOR_M1_PROFILE="DISPOSABLE_NATIVE", FINNOR_P4_PROFILE="ordinary_disposable",
    FINNOR_M4_PROFILE="DISPOSABLE_NATIVE",
    FINNOR_M4_STORAGE_KEY=base64.b64encode(os.urandom(32)).decode(),
    FINNOR_M4_STORAGE_KEY_ID="disposable-affected-b",
    OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", PYTHONDONTWRITEBYTECODE="1",
)
scripts = {
    "p3": "scripts/p3/run-e2e.mts",
    "m3": "scripts/m3/run-owner-e2e.mts",
    "m4": "scripts/m4/run-e2e.mts",
    "s1": "scripts/s1/run-s1-e2e.mts",
    "queue-p4-ic": "scripts/m3/run-native-regressions.mts",
    "completion": "scripts/completion-b/run-e2e.mts",
}
save(output / "registration.json", {
    "contract": "Original affected suites, explicit exclusions, actual evidence and unchanged source/runtime code",
    "suites": selected, "suiteTimeoutSeconds": 1200,
    "m3Selection": m3_cases or "FULL_ORIGINAL_NON_MOUNTED",
    "p3Selection": p3_cases or "FULL_ORIGINAL_NON_MOUNTED",
    "completionSelection": completion_cases or "FULL_REGISTERED_COMPLETION_DEVELOPMENT",
    "diagnosticCPUProfile": args.cpu_profile,
    "profileQualification": "ACTUAL_PARENT_NODE_DIAGNOSTIC_OVERHEAD_NOT_PERFORMANCE_OR_GATE_PROOF",
    "idleSleepPrevention": "EXTERNAL_OWNED_CAFFEINATE_WHEN_LAUNCHED; APPLICATION_CLOCKS_UNCHANGED",
    "numericalPython": python, "usd": None,
    "qualification": "LOCAL_OWNER_REGRESSIONS_NOT_ORIGINAL_GATES_CUMULATIVE_INTEGRATION_OR_CLEAN_INSTALL",
    "knownPriorFailures": [
        "Missing P3 disposable M1 capacity prevented the intended missing-record guard",
        "Physical checked-out PostgreSQL connection loss crashed M4",
        "Strict earlier closure caught regenerable Vitest results metadata",
    ],
})
before = snapshot(env["PATH"])
save(output / "closure-before.json", before)
records = []
for name in selected:
    folder = output / name
    folder.mkdir()
    child_env = dict(env)
    child_env.update(
        FINNOR_M3_EVIDENCE_DIR=str(folder), FINNOR_M4_EVIDENCE_DIR=str(folder),
        FINNOR_S1_EVIDENCE_DIR=str(folder), FINNOR_COMPLETION_B_EVIDENCE_DIR=str(folder),
        FINNOR_M1_STORE=str(folder / "m1"), FINNOR_M3_STORE=str(folder / "m3"),
        FINNOR_P4_EVIDENCE_DIR=str(folder / "p4"),
        FINNOR_S4_POLICY_STORE=str(folder / "policies"), FINNOR_S3_MODEL_STORE=str(folder / "models"),
    )
    command = ["node", *(["--cpu-prof", "--cpu-prof-dir=" + str(folder)] if args.cpu_profile else []),
               "--import=tsx", scripts[name]]
    record = {"suite": name, "command": command, "startedAt": datetime.now(timezone.utc).isoformat(),
              "selection": "FULL_ORIGINAL_NON_MOUNTED", "usd": None}
    if name == "p3":
        record["excluded"] = ["--browser", "--join", "--performance", "authorized Linux host execution"]
        if p3_cases:
            command.append("--cases=" + ",".join(p3_cases))
            record["selection"] = p3_cases
    elif name == "m3":
        record["excluded"] = ["opt-in mounted-work-lifecycle"]
        record["wrapperConstraint"] = (
            "Absent old .m1-python/.m1-s5-python; actual original script uses available pinned Python, "
            "not unchanged-wrapper installation proof")
        if m3_cases:
            child_env["FINNOR_M3_CASE_FILTER"] = ",".join(m3_cases)
            record["selection"] = m3_cases
    elif name == "m4":
        files = ["run-e2e.mts", "owner-challenges.mts", "storage-challenges.mts", "p4-challenges.mts",
                 "recovery-challenges.mts", "boundary-challenges.mts", "liability-challenges.mts",
                 "partial-challenges.mts"]
        ids = [case for file in files for case in re.findall(
            r"await challenge\('([^']+)'", (repo / "finnor-os/scripts/m4" / file).read_text())]
        if len(ids) != len(set(ids)):
            raise RuntimeError("Original M4 case registration has duplicate IDs")
        child_env["FINNOR_M4_CASE_FILTER"] = ",".join(ids)
        record.update(selection=ids, excluded=["browser-exact-scope", "sealed-and-provider-comparison"])
    elif name == "queue-p4-ic":
        basename = "affected-native-" + uuid.uuid4().hex[:12]
        command.extend(["--evidence", basename])
        record["originalEvidence"] = str(
            repo / "scope-pm/phase-05-m3-capital-program/scope-evidence" / basename)
    elif name == "completion":
        record["selection"] = completion_cases or "FULL_REGISTERED_COMPLETION_DEVELOPMENT"
        if completion_cases:
            child_env["FINNOR_COMPLETION_B_CASE_FILTER"] = ",".join(completion_cases)
    with (folder / "runner.log").open("x") as log:
        child = subprocess.Popen(command, cwd=repo / "finnor-os", env=child_env,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            record["childExitCode"] = child.wait(timeout=1200)
        except subprocess.TimeoutExpired:
            record.update(childExitCode=1, failure="SUITE_TIMEOUT")
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(child.pid, sig)
                except ProcessLookupError:
                    pass
                time.sleep(1)
            child.wait()
            record["cleanup"] = "OWNED_PROCESS_GROUP_ONLY; detached orphan cleanup not inferred"
    result_path = folder / "results.json"
    if name == "p3":
        for line in (folder / "runner.log").read_text().splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("output") and "passed" in value:
                result_path = Path(value["output"]) / "results.json"
    if name == "queue-p4-ic":
        result_path = Path(record["originalEvidence"]) / "run-manifest.json"
    record["resultPath"] = str(result_path)
    if result_path.exists():
        result_bytes = result_path.read_bytes()
        result = json.loads(result_bytes)
        record["originalResultBytes"] = len(result_bytes)
        record["originalResultSHA256"] = hashlib.sha256(result_bytes).hexdigest()
        cases = result.get("cases", result.get("results", []))
        record["counts"] = {status: sum(case["status"] == status for case in cases)
                            for status in sorted({case["status"] for case in cases})}
        if name == "queue-p4-ic":
            record["counts"] = result["selection"]
        record["unmatchedSelection"] = result.get("unmatchedSelection", [])
        hashes = result.get("evidenceDigests", result.get("artifacts", {}))
        failures = [path for path, sha in hashes.items() if path != "results.json" and
                    hashlib.sha256((result_path.parent / path).read_bytes()).hexdigest() != sha]
        record.update(verifiedArtifactHashes=len(hashes) - int("results.json" in hashes),
                      evidenceHashFailures=failures)
        if name == "p3":
            manifest = json.loads((result_path.parent / "evidence-manifest.json").read_text())
            record["verifiedArtifactHashes"] = len(manifest["files"])
            for row in manifest["files"]:
                data = (result_path.parent / row["path"]).read_bytes()
                if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
                    failures.append(row["path"])
        if name == "queue-p4-ic":
            for row in result["files"]:
                if hashlib.sha256((repo / row["path"]).read_bytes()).hexdigest() != row["sha256"]:
                    failures.append(row["path"])
            record["verifiedSourceHashes"] = len(result["files"])
            native_results = result_path.parent / "vitest-results.json"
            native_bytes = native_results.read_bytes()
            native = json.loads(native_bytes)
            if native["numPassedTests"] != result["selection"]["passed"] or native["numFailedTests"] != result["selection"]["failed"]:
                failures.append("vitest-results.json")
            record["retainedNativeResults"] = {
                "path": str(native_results), "sha256": hashlib.sha256(native_bytes).hexdigest(),
                "bytes": len(native_bytes),
            }
            if result["selection"]["passed"] <= 0 or result["selection"]["failed"] or result["selection"]["pending"]:
                record["childExitCode"] = 1
        elif not cases:
            record["childExitCode"] = 1
        if failures or record["unmatchedSelection"] or any(case["status"] == "FAIL" for case in cases):
            record["childExitCode"] = 1
    else:
        record.update(childExitCode=1, failure="NO_ORIGINAL_RESULTS")
    if args.cpu_profile:
        profiles = sorted(folder.glob("CPU.*.cpuprofile"))
        record["diagnosticCPUProfiles"] = [
            {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size}
            for path in profiles]
        record["profileQualification"] = "ACTUAL_PARENT_NODE_DIAGNOSTIC_OVERHEAD_NOT_PERFORMANCE_OR_GATE_PROOF"
        if not profiles:
            record.update(childExitCode=1, profileFailure="NO_PARENT_CPU_PROFILE")
    record["finishedAt"] = datetime.now(timezone.utc).isoformat()
    records.append(record)
    save(folder / "execution.json", record)
    print(json.dumps({"output": str(output), "suite": name, "exitCode": record["childExitCode"],
                      "counts": record.get("counts")}), flush=True)
after = snapshot(env["PATH"])
save(output / "closure-after.json", after)
integrity = compare(before, after)
save(output / "closure-integrity.json", integrity)
save(output / "execution.json", {"suites": records, "closure": integrity,
                                "originalGates": "UNQUALIFIED", "usd": None})
status = 0 if integrity["status"] == "PASS" and all(r["childExitCode"] == 0 for r in records) else 1
print(json.dumps({"output": str(output), "exitCode": status, "closure": integrity["status"]}), flush=True)
sys.exit(status)
