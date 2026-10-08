"""Run preserved P3 stories against the independent local numerical closure."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

repo = Path(__file__).resolve().parents[3]
output = repo / "scope-pm/completion-b/evidence" / (
    "p3-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8] + ".log")
env = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "TMPDIR")}
python = str(repo / ".runtime/m4-numerics-312/bin/python")
env.update(NODE_ENV="test", CI="1", AUTH_DEV_BYPASS="0",
           FINNOR_S3_PYTHON=python, FINNOR_S5_PYTHON=python,
           OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1")
with output.open("x") as log:
    run = subprocess.Popen(
        ["node", "--import=tsx", "scripts/p3/run-e2e.mts", *sys.argv[1:]],
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
print(f"P3 exit={status}; log={output}")
sys.exit(status)
