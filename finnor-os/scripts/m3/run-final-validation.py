"""Serial, scrubbed final validation; preserve every failed command and source cut."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / "finnor-os"
OUTPUT = ROOT / "scope-pm/phase-05-m3-capital-program/scope-evidence" / (
    "final-static-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
)
OUTPUT.mkdir()
ENV = {key: value for key, value in os.environ.items() if key in ("PATH", "HOME", "TMPDIR")}
ENV.update(CI="1", NEXT_TELEMETRY_DISABLED="1", FINNOR_BUILD_ID="m3-final-local")
checks = []


def identity():
    files = set()
    for directory in (
        "finnor-os/packages", "finnor-os/apps", "finnor-os/scripts/m3",
        "scripts/centropy", "src/components/centropy/canvas", "src/lib/centropy",
    ):
        for path in (ROOT / directory).rglob("*"):
            if path.is_file() and not path.is_symlink() and not any(
                part in ("node_modules", ".next", "dist", "__pycache__", ".vercel") for part in path.parts
            ):
                files.add(path)
    for relative in ("package-lock.json", "finnor-os/package-lock.json", "finnor-os/openapi.json"):
        files.add(ROOT / relative)
    return [
        {"path": str(path.relative_to(ROOT)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in sorted(files)
    ]


before = identity()
commands = [
    ("full-m3-owner", ["python3", str(BACKEND / "scripts/m3/run-owner-local.py")], ROOT, 1250),
    ("native-queue-underwriting-ic", ["python3", str(BACKEND / "scripts/m3/run-affected-regressions.py"), "p4"], ROOT, 1250),
    ("m3-script-types", ["node", "node_modules/typescript/bin/tsc", "-p", "scripts/m3/tsconfig.json", "--incremental", "false"], BACKEND, 180),
    ("backend-types", ["node", "node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"], BACKEND, 240),
    ("root-types-before-build", ["node", "node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"], ROOT, 180),
    ("scoped-ui-discovery-lint", [
        "node", "node_modules/eslint/bin/eslint.js",
        "src/components/centropy/canvas/CapitalProgramPanel.tsx",
        "src/components/centropy/canvas/capital-program-view.ts",
        "src/components/centropy/canvas/CanvasDocument.tsx",
        "src/components/centropy/canvas/canvas-compose.ts",
        "src/components/centropy/canvas/canvas-contract.ts",
        "scripts/centropy/generate-capability-manifest.mjs",
    ], ROOT, 180),
    ("root-production-build", ["node", "node_modules/next/dist/bin/next", "build"], ROOT, 300),
    ("root-types-after-build", ["node", "node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"], ROOT, 180),
]
for name, command, cwd, timeout in commands:
    started = datetime.now(timezone.utc).isoformat()
    log = OUTPUT / (name + ".log")
    with log.open("x") as stream:
        try:
            run = subprocess.run(command, cwd=cwd, env=ENV, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
            exit_code = run.returncode
            failure = None
        except subprocess.TimeoutExpired:
            exit_code = None
            failure = "SUPERVISOR_TIMEOUT"
    checks.append({
        "id": name, "command": command, "cwd": str(cwd),
        "startedAt": started, "finishedAt": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if exit_code == 0 else "FAIL", "exitCode": exit_code,
        "failure": failure, "log": str(log.relative_to(ROOT)),
        "logSha256": hashlib.sha256(log.read_bytes()).hexdigest(),
    })
    print(json.dumps({"id": name, "status": checks[-1]["status"]}), flush=True)
    if exit_code != 0:
        break
unchanged = before == identity()
receipt = {
    "schema": "finnor.m3.final-source-validation.v1",
    "checks": checks, "sourceIdentity": before, "sourceUnchanged": unchanged,
    "environmentNames": sorted(ENV),
    "status": "PASS" if unchanged and len(checks) == len(commands) and all(row["status"] == "PASS" for row in checks) else "FAIL",
    "qualification": "LOCAL_INSTALLED_SOURCE_CLOSURE_NOT_CLEAN_INSTALL_BROWSER_HOSTED_AUTH_ADMISSION_OR_ECONOMICS",
    "allFailedCommandsRetained": True,
    "money": None,
}
with (OUTPUT / "receipt.json").open("x") as stream:
    json.dump(receipt, stream, indent=2)
    stream.write("\n")
print(json.dumps({"output": str(OUTPUT), "status": receipt["status"]}), flush=True)
sys.exit(0 if receipt["status"] == "PASS" else 1)
