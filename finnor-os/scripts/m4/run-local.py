"""Scrubbed disposable M4 E2E, no provider credentials or paid calls."""
import json
import base64
import os
import pathlib
import subprocess
import sys
import uuid
import signal
import time
from datetime import datetime, timezone

repo = pathlib.Path(__file__).resolve().parents[3]
output = repo / "scope-pm/phase-06-m4-counterexample-search/scope-evidence" / (
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
    FINNOR_M4_PROFILE="DISPOSABLE_NATIVE", FINNOR_M4_PYTHON="/usr/bin/python3",
    FINNOR_M4_STORAGE_KEY=base64.b64encode(os.urandom(32)).decode(),
    FINNOR_M4_STORAGE_KEY_ID="disposable-e2e-ephemeral",
    FINNOR_M4_EVIDENCE_DIR=str(output),
    FINNOR_M1_PROFILE="DISPOSABLE_NATIVE", FINNOR_M1_STORE=str(output / "m1-store"),
    FINNOR_P4_PROFILE="ordinary_disposable",
    FINNOR_S4_POLICY_STORE=str(output / "policies"),
    FINNOR_S3_MODEL_STORE=str(output / "models"),
    FINNOR_S3_PYTHON=str(repo / ".runtime/m4-numerics-312/bin/python"),
    FINNOR_S5_PYTHON=str(repo / ".runtime/m4-numerics-312/bin/python"),
    OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", P3_GOVERNORS="1",
)
if len(sys.argv) > 1:
    env["FINNOR_M4_CASE_FILTER"] = ",".join(sys.argv[1:])
with (output / "runner.log").open("w") as log:
    try:
        run = subprocess.Popen(
            ["node", "--import=tsx", "scripts/m4/run-e2e.mts"],
            cwd=repo / "finnor-os", env=env, stdout=log,
            stderr=subprocess.STDOUT, start_new_session=True,
        )
        status = run.wait(timeout=1200)
    except subprocess.TimeoutExpired:
        status = 1
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(run.pid, sig)
            except ProcessLookupError:
                pass
            time.sleep(1)
        run.wait()
        (output / "timeout.json").write_text(json.dumps({
            "status": "FAIL", "reason": "RUNNER_TIMEOUT", "suiteTimeoutSeconds": 1200,
            "cleanup": "OWNED_SUITE_PROCESS_GROUP_TERM_KILL_SENT",
            "detachedReferenceDescendants": "AGGREGATE_ORPHAN_CONFINEMENT_UNQUALIFIED"
        }))
if (output / "results.json").exists():
    result = json.loads((output / "results.json").read_text())
    if not result["cases"] or any(c["status"] == "FAIL" for c in result["cases"]) or result.get("unmatchedSelection"):
        status = 1
else:
    status = 1
print(json.dumps({"output": str(output), "exitCode": status}))
sys.exit(status)
