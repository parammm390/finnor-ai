"""Scrubbed one-lane M3 E2E. Receipts are append-only and failed runs stay failed."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid
from datetime import datetime, timezone

repo = Path(__file__).resolve().parents[3]
output = repo / "scope-pm/phase-05-m3-capital-program/scope-evidence" / (
    "owner-workflow-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8])
output.mkdir(parents=True)
env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "TMPDIR")}
env.update(
    NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1",
    FINNOR_TEST_MANAGED_EXTENSIONS="omit", RATE_LIMIT_PER_MINUTE="100000",
    FINNOR_M3_PROFILE="DISPOSABLE_NATIVE", FINNOR_M3_STORE=str(output / "store"),
    FINNOR_M3_EVIDENCE_DIR=str(output),
    FINNOR_M1_PROFILE="DISPOSABLE_NATIVE", FINNOR_M1_STORE=str(output / "m1"),
    FINNOR_P4_PROFILE="ordinary_disposable", FINNOR_P4_EVIDENCE_DIR=str(output / "p4"),
    FINNOR_S4_POLICY_STORE=str(output / "policies"), FINNOR_S3_MODEL_STORE=str(output / "models"),
    FINNOR_S3_PYTHON=str(repo / ".m1-python/bin/python"),
    FINNOR_S5_PYTHON=str(repo / ".m1-s5-python/bin/python"), P3_GOVERNORS="1",
)
install = "--install" in sys.argv[1:]
if len(sys.argv) > 1 and not install:
    env["FINNOR_M3_CASE_FILTER"] = ",".join(sys.argv[1:])
if "mounted-work-lifecycle" in sys.argv[1:]:
    for key in ("AGENT_BROWSER_CDP", "AGENT_BROWSER_SESSION", "FACTORY_DESKTOP_CDP_PORT"):
        if key in os.environ:
            env[key] = os.environ[key]
with (output / "runner.log").open("x") as log:
    script = "scripts/m3/run-install-e2e.mts" if install else "scripts/m3/run-owner-e2e.mts"
    flags = ["--verify-generators"] if install and "--verify-generators" in sys.argv[1:] else []
    run = subprocess.run(["node", "--import=tsx", script, *flags],
                         cwd=repo / "finnor-os", env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
result_path = output / "results.json"
status = run.returncode
if result_path.exists():
    result = json.loads(result_path.read_text())
    if not result["cases"] or result.get("unmatchedSelection") or any(row["status"] != "PASS" for row in result["cases"]):
        status = 1
else:
    status = 1
print(json.dumps({"output": str(output), "exitCode": status}))
sys.exit(status)
