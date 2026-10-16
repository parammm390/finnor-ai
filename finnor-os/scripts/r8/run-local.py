"""Registered disposable R8 owner campaign. No paid calls, protected credentials,
provisioning or receipts supplied by this driver."""
import datetime
import json
import os
import pathlib
import subprocess
import sys
import uuid

repo = pathlib.Path(__file__).resolve().parents[3]
output = pathlib.Path(os.environ.get("FINNOR_R8_EVIDENCE_DIR", str(
    pathlib.Path.home() / ".cache/finnor-r8-repaired-adoption-2026-10-11" /
    ("owner-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%S") + "-" + str(uuid.uuid4())[:8]))))
output.mkdir(mode=0o700, parents=True, exist_ok=True)
env = {key: value for key, value in os.environ.items() if key in
       ("PATH", "HOME", "TMPDIR", "FINNOR_R8_RUNTIME_MANIFEST", "FINNOR_S3_PYTHON", "FINNOR_S5_PYTHON",
        "FINNOR_R8_ORIGINAL_DEADLINE_CAP")}
env.update(NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1",
           RATE_LIMIT_PER_MINUTE="100000", FINNOR_TEST_MANAGED_EXTENSIONS="omit",
           FINNOR_R8_EVIDENCE_DIR=str(output), FINNOR_S4_POLICY_STORE=str(output / "policies"),
           FINNOR_S3_MODEL_STORE=str(output / "models"), P3_GOVERNORS="1")
if len(sys.argv) > 1:
    env["FINNOR_R8_CASE_FILTER"] = sys.argv[1]
if not env.get("FINNOR_R8_RUNTIME_MANIFEST"):
    raise SystemExit("Actual sealed FINNOR_R8_RUNTIME_MANIFEST is required")
with (output / "runner.log").open("w") as log:
    result = subprocess.run(["node", "--import=tsx", "scripts/r8/run-owner.mts"],
                            cwd=repo / "finnor-os", env=env, stdout=log,
                            stderr=subprocess.STDOUT, timeout=2400)
status = result.returncode
if (output / "results.json").exists():
    observed = json.loads((output / "results.json").read_text())
    if (not observed["cases"] or observed.get("unmatchedSelection")
            or any(case["status"] != "PASS" for case in observed["cases"])):
        status = 1
else:
    status = 1
print(json.dumps({"output": str(output), "exitCode": status}))
sys.exit(status)
