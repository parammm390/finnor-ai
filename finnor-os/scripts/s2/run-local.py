"""Run S2 without production/cloud credentials, preserving the caller's HOME.
Uses installed local dependencies and disposable PostgreSQL only.
"""
import json
import os
import pathlib
import subprocess
import sys
import uuid
from datetime import datetime, timezone

repo = pathlib.Path(__file__).resolve().parents[3]
environment = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR")}
environment.update(NODE_ENV="test", CI="1", LOG_LEVEL="silent",
                   FINNOR_TEST_MANAGED_EXTENSIONS="omit", AUTH_DEV_BYPASS="1",
                   RATE_LIMIT_PER_MINUTE="100000")
output = repo / "scope-2/scope-evidence" / ("run-" + datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S") + "-" + str(uuid.uuid4())[:8])
output.mkdir(parents=True)
environment["FINNOR_S2_EVIDENCE_DIR"] = str(output)
with (output / "runner.log").open("w") as log:
    completed = subprocess.run(["node_modules/.bin/tsx", "scripts/s2/run-s2-e2e.mts"],
                               cwd=repo / "finnor-os", env=environment, stdout=log,
                               stderr=subprocess.STDOUT)
status = completed.returncode
if (output / "results.json").exists():
    results = json.loads((output / "results.json").read_text())
    if any(c["status"] != "PASS" for c in results["cases"]):
        status = 1
else:
    status = 1
print(json.dumps({"output": str(output), "exitCode": status}))
sys.exit(status)
