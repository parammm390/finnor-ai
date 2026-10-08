"""M1 E2E in scrubbed, disposable local infrastructure. No paid/provider calls."""
import json
import os
import pathlib
import subprocess
import sys
import uuid
from datetime import datetime, timezone

repo = pathlib.Path(__file__).resolve().parents[3]
output = repo / "scope-pm/phase-02-m1-decision-slice/scope-evidence" / (
    "run-" + datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S") + "-" + str(uuid.uuid4())[:8]
)
output.mkdir(parents=True)
env = {k: v for k, v in os.environ.items() if k in (
    "PATH", "HOME", "TMPDIR", "AGENT_BROWSER_SESSION", "AGENT_BROWSER_CDP",
    "FACTORY_DESKTOP_CDP_PORT",
)}
env.update(
    NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1",
    RATE_LIMIT_PER_MINUTE="100000", FINNOR_TEST_MANAGED_EXTENSIONS="omit",
    FINNOR_M1_PROFILE="DISPOSABLE_NATIVE", FINNOR_M1_STORE=str(output / "producer-store"),
    FINNOR_M1_EVIDENCE_DIR=str(output), FINNOR_S4_POLICY_STORE=str(output / "policies"),
    FINNOR_S3_MODEL_STORE=str(output / "models"),
    FINNOR_S3_PYTHON=str(repo / ".m1-python/bin/python3.11"),
    FINNOR_S5_PYTHON=str(repo / ".m1-s5-python/bin/python"),
    P3_GOVERNORS="1",
)
if len(sys.argv) > 1:
    env["FINNOR_M1_CASE_FILTER"] = ",".join(sys.argv[1:])
with (output / "runner.log").open("w") as log:
    run = subprocess.run(
        ["node", "--import=tsx", "scripts/m1/run-e2e.mts"],
        cwd=repo / "finnor-os", env=env, stdout=log, stderr=subprocess.STDOUT,
        timeout=1200,
    )
status = run.returncode
if (output / "results.json").exists():
    result = json.loads((output / "results.json").read_text())
    if not result["cases"] or any(c["status"] != "PASS" for c in result["cases"]):
        status = 1
else:
    status = 1
print(json.dumps({"output": str(output), "exitCode": status}))
sys.exit(status)
