"""Run the unchanged owner integration suites serially in disposable fixtures."""
import json
import os
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

repo = pathlib.Path(sys.argv[1]).resolve(strict=True)
output = pathlib.Path(sys.argv[2])
if not pathlib.Path(sys.argv[1]).is_absolute() or not output.is_absolute():
    raise SystemExit("Absolute checkout and fresh evidence directory required")
output.mkdir()
cases = [
    "tests/integration/phase6-plan-graph-runtime.test.ts",
    "tests/integration/phase6-plan-concurrency.test.ts",
    "tests/integration/queue.test.ts",
    "tests/integration/artifact-os.test.ts",
    "tests/integration/private-equity-p4-underwriting.test.ts",
    "tests/integration/private-equity-p5-ic-runtime.test.ts",
    "tests/integration/private-equity-p1-world-truth.test.ts",
    "tests/planner-evals/replay.test.ts",
]
env = {k: os.environ[k] for k in ["PATH", "HOME", "TMPDIR"] if k in os.environ}
receipt = {
    "schema": "finnor.p6.serial-unchanged-owner-regressions.v1",
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "cases": [],
    "originalTestsModified": False,
    "qualification": "LOCAL_UNCHANGED_OWNER_INTEGRATION_NOT_ORIGINAL_GATES",
}
for index, case in enumerate(cases):
    target = output / str(index + 1)
    command = ["node", "--import=tsx", str(repo / "finnor-os/scripts/p1/run-regressions.mts"),
               str(target), case]
    result = subprocess.run(command, cwd=repo / "finnor-os", env=env)
    record = json.loads((target / "run-manifest.json").read_text())
    receipt["cases"].append({
        "test": case, "exitCode": result.returncode,
        "counts": record.get("counts"), "manifest": str(target / "run-manifest.json"),
        "sourceUnchanged": record.get("productionUnchanged"),
    })
    with (output / "summary.json").open("w") as file:
        json.dump(receipt, file, indent=2)
        file.write("\n")
receipt["finishedAt"] = datetime.now(timezone.utc).isoformat()
receipt["exitCode"] = int(any(c["exitCode"] or not c["sourceUnchanged"] for c in receipt["cases"]))
with (output / "summary.json").open("w") as file:
    json.dump(receipt, file, indent=2)
    file.write("\n")
print(json.dumps({"exitCode": receipt["exitCode"], "suites": len(receipt["cases"])}))
raise SystemExit(receipt["exitCode"])
