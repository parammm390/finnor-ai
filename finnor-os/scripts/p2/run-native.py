"""Replay real owner E2Es in scrubbed disposable infrastructure; no provider calls.

Usage: python3 scripts/p1/run-native.py OWNER EVIDENCE_DIR [CASE_FILTER]
Set FINNOR_TEST_NODE and FINNOR_TEST_PYTHON to verified installed executables.
Every NOT_RUN case remains in the owner's receipt. Empty runs fail this driver.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

backend = pathlib.Path(__file__).resolve().parents[2]
owner, output_arg, *case_filter = sys.argv[1:]
scripts = {"p2": "scripts/p2/run-e2e.mts"}
if owner not in scripts or len(case_filter) > 1:
    raise SystemExit("Expected owner p2, evidence directory and optional exact filter")
output = pathlib.Path(output_arg).resolve()
output.mkdir(parents=True, exist_ok=True)
if (output / "driver-receipt.json").exists():
    raise SystemExit("Immutable evidence directory already has a run receipt")
node = pathlib.Path(os.environ.get("FINNOR_TEST_NODE", "/Users/paramdave/.hermes/node/bin/node")).resolve(strict=True)
python = pathlib.Path(os.environ.get("FINNOR_TEST_PYTHON", "/tmp/finnor-s3-python/bin/python")).absolute()
python.resolve(strict=True)  # Verify the target while preserving virtualenv identity at invocation.
env = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "TMPDIR")}
env.update(NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1",
           FINNOR_TEST_MANAGED_EXTENSIONS="omit", FINNOR_M1_PROFILE="DISPOSABLE_NATIVE",
           FINNOR_M1_STORE=str(output / "producer-store"), FINNOR_S3_MODEL_STORE=str(output / "models"),
           FINNOR_S4_POLICY_STORE=str(output / "policies"), FINNOR_S3_PYTHON=str(python),
           FINNOR_S5_PYTHON=str(python), P3_GOVERNORS="1", RATE_LIMIT_PER_MINUTE="100000")
env[f"FINNOR_{owner.upper()}_EVIDENCE_DIR"] = str(output)
if case_filter:
    env[f"FINNOR_{owner.upper()}_CASE_FILTER"] = case_filter[0]
command = [str(node), "--import=tsx", scripts[owner]]
receipt = {"schema": "finnor.p2.native-rerun.v1", "startedAt": datetime.now(timezone.utc).isoformat(),
           "command": command, "cwd": str(backend), "environmentNames": sorted(env),
           "caseFilter": case_filter[0] if case_filter else None,
           "executables": [{"path": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in (node, python)],
           "driverSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
           "sourceScriptSha256": hashlib.sha256((backend / scripts[owner]).read_bytes()).hexdigest(),
           "qualification": "Real disposable native owner E2E; local unmetered development, not sealed admission/frontier/economic qualification"}
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
    receipt["counts"] = {s: sum(c.get("status") == s for c in cases) for s in ("PASS", "FAIL", "NOT_RUN")}
    if not receipt["counts"]["PASS"] or receipt["counts"]["FAIL"]:
        receipt["exitCode"] = receipt["exitCode"] or 1
else:
    receipt["exitCode"] = receipt["exitCode"] or 1
    receipt["failure"] = "MISSING_NATIVE_OWNER_RECEIPT"
receipt["finishedAt"] = datetime.now(timezone.utc).isoformat()
(output / "driver-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"output": str(output), **receipt}))
raise SystemExit(receipt["exitCode"])
