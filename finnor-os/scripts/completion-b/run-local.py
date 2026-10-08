"""Disposable Track B runtime. No inherited credentials or live service writes."""
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from closure import snapshot, save, compare

repo = Path(__file__).resolve().parents[3]
output = repo / "scope-pm/completion-b/evidence/raw" / (
    "run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8])
output.mkdir(parents=True)
env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "TMPDIR")}
python = str(repo / ".runtime/m4-numerics-312/bin/python")
env.update(
    NODE_ENV="test", CI="1", LOG_LEVEL="error", AUTH_DEV_BYPASS="1",
    FINNOR_TEST_MANAGED_EXTENSIONS="omit", RATE_LIMIT_PER_MINUTE="100000", P3_GOVERNORS="1",
    FINNOR_M3_PROFILE="DISPOSABLE_NATIVE", FINNOR_M3_STORE=str(output / "m3"),
    FINNOR_M1_PROFILE="DISPOSABLE_NATIVE", FINNOR_M1_STORE=str(output / "m1"),
    FINNOR_P4_PROFILE="ordinary_disposable", FINNOR_P4_EVIDENCE_DIR=str(output / "p4"),
    FINNOR_S4_POLICY_STORE=str(output / "policies"), FINNOR_S3_MODEL_STORE=str(output / "models"),
    FINNOR_S3_PYTHON=python, FINNOR_S5_PYTHON=python, FINNOR_M4_PYTHON=python,
    FINNOR_M4_PROFILE="DISPOSABLE_NATIVE", FINNOR_M4_STORAGE_KEY=base64.b64encode(os.urandom(32)).decode(),
    FINNOR_M4_STORAGE_KEY_ID="disposable-b-ephemeral", FINNOR_COMPLETION_B_EVIDENCE_DIR=str(output),
    OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1",
    PYTHONDONTWRITEBYTECODE="1",
)
if len(sys.argv) > 1:
    env["FINNOR_COMPLETION_B_CASE_FILTER"] = ",".join(sys.argv[1:])
if "mounted-original-challenge-repair-loop" in sys.argv[1:]:
    for key in ("AGENT_BROWSER_CDP", "AGENT_BROWSER_SESSION", "FACTORY_DESKTOP_CDP_PORT"):
        if key in os.environ:
            env[key] = os.environ[key]
node_flags = ["--cpu-prof", "--cpu-prof-dir=" + str(output)] if os.environ.get(
    "FINNOR_COMPLETION_B_CPU_PROFILE") == "1" else []
before = snapshot(env["PATH"])
save(output / "closure-before.json", before)
with (output / "runner.log").open("x") as log:
    run = subprocess.Popen(
        ["node", *node_flags, "--import=tsx", "scripts/completion-b/run-e2e.mts"],
        cwd=repo / "finnor-os", env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
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
            "status": "FAIL", "reason": "SUITE_TIMEOUT", "ownedProcessGroupStopped": True,
            "detachedDescendantReconciliation": "NOT_QUALIFIED",
        }))
result_path = output / "results.json"
if result_path.exists():
    try:
        result = json.loads(result_path.read_text())
        if not result["cases"] or result.get("unmatchedSelection") or any(c["status"] != "PASS" for c in result["cases"]):
            status = 1
    except (OSError, ValueError, KeyError, TypeError):
        status = 1
else:
    status = 1
after = snapshot(env["PATH"])
save(output / "closure-after.json", after)
integrity = compare(before, after)
save(output / "closure-integrity.json", integrity)
if integrity["status"] != "PASS":
    status = 1
print(json.dumps({"output": str(output), "exitCode": status}))
sys.exit(status)
