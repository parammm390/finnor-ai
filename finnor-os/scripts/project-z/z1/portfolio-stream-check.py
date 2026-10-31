"""Finite affected checks. Invoke only under the recorded shared flock envelope."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[4]
evidence = Path(sys.argv[2])
kind, attempt = sys.argv[1], sys.argv[3]
if not evidence.is_absolute() or not evidence.is_dir() or not attempt.isdigit():
    raise ValueError("ABSOLUTE_EXISTING_EVIDENCE_AND_NEW_NUMERIC_ATTEMPT_REQUIRED")
node = "/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node"
owned = root / "finnor-os/scripts/project-z/z1"
label = {"types": "types", "data": "process-check", "sql": "sql-check", "syntax": "native-syntax"}[kind] + "-" + attempt
if (evidence / (label + ".json")).exists() or (evidence / (label + ".log")).exists():
    raise ValueError("IMMUTABLE_CHECK_ATTEMPT_ALREADY_EXISTS")
commands = {
    "types": [node, "--max-old-space-size=4096", str(root / "finnor-os/node_modules/typescript/bin/tsc"),
              "--noEmit", "--incremental", "false", "-p", str(owned / "typecheck.json")],
    "data": [node, "--max-old-space-size=1536", "--import", str(root / "finnor-os/node_modules/tsx/dist/loader.mjs"),
             str(owned / "portfolio-stream-replay.mjs"), str(evidence / ("stream-" + attempt))],
    "sql": ["python3", str(owned / "parse-sql.py"), str(evidence / ("sql-grammar-" + attempt + ".json")),
            str(owned / "portfolio-stream.sql"), "z1-data-path"],
    "syntax": [node, "--max-old-space-size=512", "--check", str(owned / "native-e2e-run.mjs")],
}
minimum = 4294967296
memory = next(int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines()
              if line.startswith("MemAvailable:"))
report = {"schema": "finnor.z1.bounded-affected-source-check.v1", "check": kind, "command": commands[kind],
          "cwd": str(root), "status": "IN_PROGRESS", "databaseActions": 0, "nativeOwnerFlow": "NOT_RUN",
          "proofAdmissionRenewed": False, "guards": {"diskFreeBytes": shutil.disk_usage(root).free,
            "memoryAvailableBytes": memory, "affinity": sorted(os.sched_getaffinity(0)),
            "diskMinimumBytes": minimum, "memoryMinimumBytes": minimum, "maximumChildSeconds": 540},
          "controllerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
paths = []
for relative in ["finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work",
                 "finnor-os/packages/private-equity/src/project-z/z1-shared-work",
                 "finnor-os/packages/orchestration/src/project-z/z1-shared-work"]:
    paths.extend(sorted((root / relative).glob("*.ts")))
paths.extend(owned / name for name in ["portfolio-stream.sql", "portfolio-stream-original.py",
                                     "portfolio-stream-replay.mjs", "parse-sql.py", "native-e2e-run.mjs"])
report["sources"] = [{"path": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                     for path in paths]
code = 2
if report["guards"]["diskFreeBytes"] < minimum or memory < minimum or set(os.sched_getaffinity(0)) != {0, 1}:
    report.update(status="NOT_RUN", reason="UNCHANGED_DISK_MEMORY_OR_CPU_GUARD_CHILD_NOT_STARTED", exitCode=2)
else:
    env = {"PATH": str(Path(node).parent) + ":/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
           "TSX_DISABLE_CACHE": "1", "TSX_TSCONFIG_PATH": str(root / "finnor-os/tsconfig.json")}
    if kind == "sql":
        env["PYTHONPATH"] = "/home/factory-user/repos/finnor-z-toolchains/pglast-8.7"
    start = time.monotonic()
    log = evidence / (label + ".log")
    with log.open("xb") as output:
        child = subprocess.Popen(commands[kind], cwd=root, env=env, stdout=output,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait(timeout=540)
            report.update(status="PASSED" if code == 0 else "FAILED", exitCode=code)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            code = 124
            report.update(status="FAILED", exitCode=code, reason="UNCHANGED_540_SECOND_CHILD_TIMEOUT")
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    report.update(wallMs=round((time.monotonic() - start) * 1000), logSha256=hashlib.sha256(log.read_bytes()).hexdigest())
with (evidence / (label + ".json")).open("x") as output:
    json.dump(report, output, indent=2)
    output.write("\n")
print(json.dumps({"check": kind, "status": report["status"], "exitCode": code,
                  "memoryAvailableBytes": memory, "diskFreeBytes": report["guards"]["diskFreeBytes"]}))
sys.exit(code)
