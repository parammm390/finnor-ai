"""Replay real owner E2Es in scrubbed disposable infrastructure; no provider calls.

Usage: python3 scripts/p1/run-native.py OWNER EVIDENCE_DIR [CASE_FILTER]
Set FINNOR_TEST_NODE and FINNOR_TEST_PYTHON to verified installed executables.
Every NOT_RUN case remains in the owner's receipt. Empty runs fail this driver.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
from datetime import datetime, timezone

backend = pathlib.Path(__file__).resolve().parents[2]
freeze_path = backend / "scripts/m2/source_freeze.py"
freeze_spec = importlib.util.spec_from_file_location("finnor_complete_source_freeze", freeze_path)
freeze_module = importlib.util.module_from_spec(freeze_spec)
freeze_spec.loader.exec_module(freeze_module)
owner, output_arg, *case_filter = sys.argv[1:]
scripts = {"p1": "scripts/p1/run-program-e2e.mts", "m1": "scripts/m1/run-e2e.mts", "p4": "scripts/p4/run-evidence-e2e.mts"}
if owner not in scripts or len(case_filter) > 1:
    raise SystemExit("Expected owner p1/m1/p4, evidence directory and optional exact filter")
output = pathlib.Path(output_arg).resolve()
if output == backend.parent or backend.parent in output.parents:
    raise SystemExit("Evidence must be outside the complete source checkout")
output.mkdir(parents=True, exist_ok=False)
source_script = backend / scripts[owner]
registered = re.findall(r"await challenge\('([^']+)'", source_script.read_text()) if owner == "m1" else []
if owner == "m1":
    if not registered or len(registered) != len(set(registered)):
        raise SystemExit("M1 original challenge denominator is absent or ambiguous")
    if case_filter and any(case not in registered for case in case_filter[0].split(",")):
        raise SystemExit("M1 selection must use exact original registered challenge IDs")
node = pathlib.Path(os.environ.get("FINNOR_TEST_NODE", "/Users/paramdave/.hermes/node/bin/node")).resolve(strict=True)
python = pathlib.Path(os.environ.get("FINNOR_TEST_PYTHON", "/tmp/finnor-s3-python/bin/python")).absolute()
python.resolve(strict=True)  # Verify the target while preserving virtualenv identity at invocation.
env = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "TMPDIR")}
browser_tools = []
for key in ("FINNOR_AGENT_BROWSER", "FINNOR_BROWSER_EXECUTABLE"):
    if key in os.environ:
        executable = pathlib.Path(os.environ[key]).resolve(strict=True)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise SystemExit("Browser runtime must be an installed executable")
        env[key] = str(executable)
        browser_tools.append(executable)
env.update(NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1",
           FINNOR_TEST_MANAGED_EXTENSIONS="omit", FINNOR_M1_PROFILE="DISPOSABLE_NATIVE",
           FINNOR_M1_STORE=str(output / "producer-store"), FINNOR_S3_MODEL_STORE=str(output / "models"),
           FINNOR_S4_POLICY_STORE=str(output / "policies"), FINNOR_S3_PYTHON=str(python),
           FINNOR_S5_PYTHON=str(python), P3_GOVERNORS="1", RATE_LIMIT_PER_MINUTE="100000")
env[f"FINNOR_{owner.upper()}_EVIDENCE_DIR"] = str(output)
if case_filter:
    env[f"FINNOR_{owner.upper()}_CASE_FILTER"] = case_filter[0]
command = [str(node), "--import=tsx", scripts[owner]]
receipt = {"schema": "finnor.p1.native-rerun.v1", "startedAt": datetime.now(timezone.utc).isoformat(),
           "command": command, "cwd": str(backend), "environmentNames": sorted(env),
           "caseFilter": case_filter[0] if case_filter else None,
           "executables": [{"path": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in (node, python, *browser_tools)],
           "driverSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
           "sourceScriptSha256": hashlib.sha256(source_script.read_bytes()).hexdigest(),
           "sourceObserverSha256": hashlib.sha256(freeze_path.read_bytes()).hexdigest(),
           "qualification": "Real disposable native owner E2E; local unmetered development, not sealed admission/frontier/economic qualification"}
source_before = freeze_module.freeze(backend.parent, output)
receipt["completeSourceDigest"] = source_before["sourceDigest"]
with (output / "runner.log").open("w") as log:
    try:
        run = subprocess.run(command, cwd=backend, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
        receipt["exitCode"] = run.returncode
    except subprocess.TimeoutExpired:
        receipt.update(exitCode=124, failure="DRIVER_TIMEOUT")
result_path = output / "results.json"
if result_path.exists():
    result = json.loads(result_path.read_text())
    cases = result.get("results", result.get("cases", []))
    if registered:
        actual = {case["id"]: case for case in cases}
        if len(actual) != len(cases) or any(case not in registered for case in actual):
            receipt.update(exitCode=receipt["exitCode"] or 1, failure="M1_UNKNOWN_OR_DUPLICATE_OWNER_CASE")
        denominator = [{"id": case, "status": actual.get(case, {}).get("status", "NOT_RUN")}
                       for case in registered]
        denominator_path = output / "owner-case-denominator.json"
        denominator_path.write_text(json.dumps({"schema": "finnor.owner-case-denominator.v1",
            "owner": owner, "authority": scripts[owner], "authoritySha256": receipt["sourceScriptSha256"],
            "selection": case_filter[0].split(",") if case_filter else "FULL_REGISTERED_RUN",
            "cases": denominator, "qualification": "Original challenge calls retained; missing cases are NOT_RUN, never PASS"}, indent=2) + "\n")
        receipt["registeredCaseCount"] = len(registered)
        receipt["caseDenominatorSha256"] = hashlib.sha256(denominator_path.read_bytes()).hexdigest()
        selected = case_filter[0].split(",") if case_filter else registered
        if any(actual.get(case, {}).get("status") != "PASS" for case in selected):
            receipt["exitCode"] = receipt["exitCode"] or 1
        cases = denominator
    receipt["counts"] = {s: sum(c.get("status") == s for c in cases) for s in ("PASS", "FAIL", "NOT_RUN")}
    if not receipt["counts"]["PASS"] or any(c.get("status") not in ("PASS", "NOT_RUN") for c in cases):
        receipt["exitCode"] = receipt["exitCode"] or 1
else:
    receipt["exitCode"] = receipt["exitCode"] or 1
    receipt["failure"] = "MISSING_NATIVE_OWNER_RECEIPT"
receipt["finishedAt"] = datetime.now(timezone.utc).isoformat()
receipt["sourceStability"] = freeze_module.verify(backend.parent, output, source_before)
if receipt["sourceStability"]["status"] != "PASS":
    receipt["exitCode"] = receipt["exitCode"] or 1
(output / "driver-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"output": str(output), **receipt}))
raise SystemExit(receipt["exitCode"])
