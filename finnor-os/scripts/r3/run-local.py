"""Finite disposable run. Never inherit production credentials or runtime profiles."""
import json
import os
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

repo = pathlib.Path(__file__).resolve().parents[3]
out = repo / "scope-r/r3-incentive-rule-synthesis/evidence" / (
    "owner-" + datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S"))
out.mkdir(parents=True, exist_ok=False)
scratch = repo / ".r3-scratch"
scratch.mkdir(exist_ok=True)
env = {k: v for k, v in os.environ.items() if k in (
    "PATH", "HOME", "FACTORY_DESKTOP_CDP_PORT", "AGENT_BROWSER_CDP", "AGENT_BROWSER_SESSION")}
env.update(NODE_ENV="test", CI="1", LOG_LEVEL="warn", AUTH_DEV_BYPASS="0",
           FINNOR_TEST_MANAGED_EXTENSIONS="omit", FINNOR_R3_PROFILE="ordinary_disposable",
           RATE_LIMIT_PER_MINUTE="100000", RATE_LIMIT_IP_PER_MINUTE="100000",
           FINNOR_R3_EVIDENCE_DIR=str(out), TMPDIR=str(scratch),
           FINNOR_R3_RUNTIME_MANIFEST=str(repo / ".r3-runtime/manifest.json"),
           FINNOR_S3_PYTHON=str(repo / ".r3-upstream-runtime/bin/python"),
           FINNOR_S5_PYTHON=str(repo / ".r3-upstream-runtime/bin/python"),
           FINNOR_S3_MODEL_STORE=str(scratch / "models"),
           FINNOR_S4_POLICY_STORE=str(scratch / "policies"),
           WORKER_JOB_LEASE_SECONDS="3", OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
if len(sys.argv) > 1:
    env["FINNOR_R3_CASES"] = sys.argv[1]
start = datetime.now(timezone.utc)
with (out / "runner.log").open("w") as log:
    run = subprocess.run(["node", "--import=tsx", "scripts/r3/run-owner-e2e.mts"],
                         cwd=repo / "finnor-os", env=env, stdout=log, stderr=subprocess.STDOUT,
                         timeout=3600)
status = run.returncode
if (out / "results.json").exists():
    observed = json.loads((out / "results.json").read_text())
    if not observed.get("cases") or any(c["status"] != "PASS" for c in observed["cases"]):
        status = 1
else:
    status = 1
if (out / "failure.json").exists():
    status = 1
(out / "run-command.json").write_text(json.dumps({
    "command": "python3 finnor-os/scripts/r3/run-local.py" + (" " + sys.argv[1] if len(sys.argv) > 1 else ""),
    "exitCode": status, "processExitCode": run.returncode, "startedAt": start.isoformat(),
    "finishedAt": datetime.now(timezone.utc).isoformat(),
    "env": {k: v for k, v in env.items() if k not in (
        "PATH", "HOME", "FACTORY_DESKTOP_CDP_PORT", "AGENT_BROWSER_CDP", "AGENT_BROWSER_SESSION")},
    "usd": None, "aggregateSimultaneousPeakMemoryBytes": None,
    "qualification": "ACTUAL_DISPOSABLE_HTTP_DATABASE_WORKER_NOT_PROTECTED_ADMISSION"
}, indent=2) + "\n")
print(json.dumps({"output": str(out), "exitCode": status}))
sys.exit(status)
