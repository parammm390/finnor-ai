"""Run unchanged original owner regressions with explicit M3 evidence and bounds."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone

repo = Path(__file__).resolve().parents[3]
scripts = {
    "s1": "scripts/s1/run-s1-e2e.mts",
    "s2": "scripts/s2/run-s2-e2e.mts",
    "s3": "scripts/s3/run-s3-e2e.mts",
    "s4": "scripts/s4/run-s4-e2e.mts",
    "s5": "scripts/s5/run-s5-e2e.mts",
    "m1": "scripts/m1/run-e2e.mts",
    "p4": "scripts/m3/run-native-regressions.mts",
}
if len(sys.argv) != 2 or sys.argv[1] not in scripts:
    raise SystemExit("Use one of: s1 s2 s3 s4 s5 m1 p4")
owner = sys.argv[1]
name = "original-" + owner + "-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
root = repo / "scope-pm/phase-05-m3-capital-program/scope-evidence"
output = root / name
output.mkdir()
env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "TMPDIR")}
env.update(
    NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1",
    FINNOR_TEST_MANAGED_EXTENSIONS="omit", RATE_LIMIT_PER_MINUTE="100000",
    FINNOR_S3_PYTHON=str(repo / ".m1-python/bin/python3.11"),
    FINNOR_S5_PYTHON=str(repo / ".m1-s5-python/bin/python"), P3_GOVERNORS="1",
    FINNOR_S3_MODEL_STORE=str(output / "models"), FINNOR_S4_POLICY_STORE=str(output / "policies"),
    FINNOR_M1_PROFILE="DISPOSABLE_NATIVE", FINNOR_M1_STORE=str(output / "m1"),
    FINNOR_P4_PROFILE="ordinary_disposable", FINNOR_P4_EVIDENCE_DIR=str(output / "p4"),
)
env["FINNOR_" + owner.upper() + "_EVIDENCE_DIR"] = str(output)
selection = None
excluded = []
if owner == "m1":
    source = (repo / "finnor-os" / scripts[owner]).read_text()
    ids = re.findall(r"await challenge\('([^']+)'", source)
    excluded = ["authenticated-ui-witness-keyboard-reload-refusal"]
    assert all(case in ids for case in excluded) and len(ids) == len(set(ids))
    selection = [case for case in ids if case not in excluded]
    assert selection
    env["FINNOR_M1_CASE_FILTER"] = ",".join(selection)
command = ["node", "--import=tsx", scripts[owner]]
result_path = output / "results.json"
if owner == "p4":
    command += ["--evidence", name.lower() + "-child"]
    result_path = root / (name.lower() + "-child") / "vitest-results.json"


def source_identity():
    files = set()
    for relative in ("finnor-os/packages", "finnor-os/apps", "finnor-os/scripts", "scripts/centropy",
                     "src/components/centropy/canvas", "src/lib/centropy"):
        for path in (repo / relative).rglob("*"):
            if path.is_file() and not path.is_symlink() and not any(
                    part in ("node_modules", ".next", "dist", "__pycache__") for part in path.parts):
                files.add(path)
    for relative in ("package-lock.json", "finnor-os/package-lock.json", "finnor-os/openapi.json"):
        files.add(repo / relative)
    return [{"path": str(path.relative_to(repo)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in sorted(files)]


before = source_identity()
receipt = {
    "schema": "finnor.m3.original-owner-regression.v1", "owner": owner,
    "startedAt": datetime.now(timezone.utc).isoformat(), "command": command, "cwd": str(repo / "finnor-os"),
    "selection": selection or "FULL_ORIGINAL_RUN", "excludedCases": excluded,
    "sourceIdentity": before, "environmentNames": sorted(env), "result": str(result_path),
    "qualification": "UNCHANGED_ORIGINAL_OWNER_H0_H1_NOT_BROWSER_HELD_OUT_ADMISSION_OR_H2",
    "costs": {"money": None, "status": "UNMETERED", "externalModelCalls": 0},
    "rerun": "python3 finnor-os/scripts/m3/run-affected-regressions.py " + owner,
}
try:
    with (output / "runner.log").open("x") as log:
        run = subprocess.run(command, cwd=repo / "finnor-os", env=env,
                             stdout=log, stderr=subprocess.STDOUT, timeout=1200)
    receipt["childExitCode"] = run.returncode
    result = json.loads(result_path.read_text())
    if owner == "p4":
        counts = {"total": result["numTotalTests"], "passed": result["numPassedTests"],
                  "failed": result["numFailedTests"], "pending": result["numPendingTests"]}
        passed = run.returncode == 0 and result["success"] and counts["total"] > 0 and counts["failed"] == counts["pending"] == 0
    else:
        cases = result.get("cases", result.get("results", []))
        counts = {"total": len(cases), "passed": sum(c["status"] == "PASS" for c in cases),
                  "failed": sum(c["status"] != "PASS" for c in cases)}
        unmatched = result.get("unmatchedSelection", []) or (
            sorted(set(selection) - {c["id"] for c in cases}) if selection else [])
        passed = run.returncode == 0 and bool(cases) and counts["failed"] == 0 and not unmatched
        receipt["unmatchedSelection"] = unmatched
    receipt["counts"] = counts
    receipt["sourceUnchanged"] = before == source_identity()
    receipt["status"] = "PASS" if passed and receipt["sourceUnchanged"] else "FAIL"
except Exception as error:
    receipt["status"] = "FAIL"
    receipt["failure"] = {"kind": type(error).__name__, "message": str(error)}
receipt["finishedAt"] = datetime.now(timezone.utc).isoformat()
with (output / "receipt.json").open("x") as file:
    json.dump(receipt, file, indent=2)
    file.write("\n")
print(json.dumps({"output": str(output), "status": receipt["status"], "counts": receipt.get("counts")}))
raise SystemExit(0 if receipt["status"] == "PASS" else 1)
