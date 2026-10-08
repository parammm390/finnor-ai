"""Real disposable owner-runner output contract, authored before its repair.

Failures: ignored output argument, empty/skipped selection, masked child failure,
evidence overwrite, traversal/symlink escape. Oracle: child JSON and immutable
file hashes, not runner stdout. Each run keeps its own source and red/green log.
"""
import hashlib
import json
import pathlib
import subprocess
import uuid

repo = pathlib.Path(__file__).resolve().parents[3]
root = repo / "scope-pm/phase-05-m3-capital-program/scope-evidence"
output = root / ("owner-contract-" + uuid.uuid4().hex)
output.mkdir()
runner = repo / "finnor-os/scripts/p4/run-owner-regressions.mts"
name = "owner-cases-" + uuid.uuid4().hex
target = root / name
command = ["node", "--import=tsx", "scripts/p4/run-owner-regressions.mts", "--evidence", name]
checks = []


def run(args):
    return subprocess.run(args, cwd=repo / "finnor-os", capture_output=True, text=True)


try:
    result = run(command)
    (output / "runner.log").write_text(result.stdout + result.stderr)
    checks.append({"id": "requested-output", "pass": (target / "run-manifest.json").is_file(),
                   "exitCode": result.returncode})
    assert checks[-1]["pass"], "Runner ignored unique --evidence output"
    manifest = json.loads((target / "run-manifest.json").read_text())
    tests = json.loads((target / "vitest-results.json").read_text())
    checks.append({"id": "nonempty-real-selection-and-exit", "pass":
                   tests["numTotalTests"] > 0 and tests["numPendingTests"] == 0 and
                   manifest["exitCode"] == result.returncode == 0 and tests["success"],
                   "total": tests["numTotalTests"], "passed": tests["numPassedTests"]})
    assert checks[-1]["pass"], "Actual selected owner tests failed or were empty"
    before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in target.iterdir()}
    reused = run(command)
    checks.append({"id": "reuse-refused-without-overwrite", "pass": reused.returncode != 0 and
                   before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in target.iterdir()}})
    assert checks[-1]["pass"], "Existing evidence changed"
    for unsafe in ["../escape", "/tmp/escape", "has space"]:
        refused = run(command[:-1] + [unsafe])
        checks.append({"id": "unsafe-path-refused", "path": unsafe, "pass": refused.returncode != 0})
        assert checks[-1]["pass"], "Unsafe evidence path accepted"
except Exception as error:
    checks.append({"id": "contract", "pass": False, "error": str(error)})
finally:
    receipt = {"schema": "finnor.m3.owner-evidence-contract.v1", "command": command,
               "runnerSha256": hashlib.sha256(runner.read_bytes()).hexdigest(),
               "output": str(output), "target": str(target), "checks": checks}
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
raise SystemExit(0 if all(c["pass"] for c in checks) else 1)
