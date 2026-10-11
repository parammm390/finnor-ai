"""Finite exact-source release validation, preserving every command and failure."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / "finnor-os"
parser = argparse.ArgumentParser()
parser.add_argument("--checks", help="Comma-separated registered checks, for affected reruns only")
args = parser.parse_args()
OUTPUT = ROOT / "scope-r/r2-robust-programme-search/evidence/final" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8])
OUTPUT.mkdir(parents=True, mode=0o700)
ENV = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR")}
ENV.update(CI="1", NEXT_TELEMETRY_DISABLED="1", FINNOR_BUILD_ID="r2-local-source-validation")
commands = [
 ("backend-types", ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--incremental", "false"], BACKEND, 240),
 ("root-types", ["node", "node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"], ROOT, 180),
 ("lint", ["npm", "run", "lint"], ROOT, 120),
 ("workspace-contract", ["npm", "run", "workspace:check"], ROOT, 60),
 ("capability-manifest", ["npm", "run", "centropy:manifest:check"], ROOT, 60),
 ("generated-client", ["npm", "run", "centropy:client:check"], ROOT, 60),
 ("generated-forms", ["npm", "run", "centropy:forms:check"], ROOT, 60),
 ("release-truth", ["npm", "run", "release:truth"], ROOT, 60),
 ("mandatory-release-security", ["npm", "run", "test:release"], ROOT, 120),
 ("api-production-build", ["npm", "run", "build", "--workspace", "@finnor/api"], BACKEND, 360),
 ("root-production-build", ["npm", "run", "build", "--", "--webpack"], ROOT, 360),
 ("root-types-after-build", ["node", "node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"], ROOT, 180),
]
selected = set(args.checks.split(",")) if args.checks else {row[0] for row in commands}
if not selected or selected - {row[0] for row in commands}:
 raise SystemExit("Unknown registered check")
def identity():
 names = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT).decode().split("\0")
 return [{"path": name, "sha256": hashlib.sha256((ROOT/name).read_bytes()).hexdigest()} for name in sorted(set(names)) if name and (ROOT/name).is_file() and (name.startswith(("finnor-os/packages/", "finnor-os/apps/", "src/", "infra/")) or name in ("package-lock.json", "finnor-os/package-lock.json", "next.config.mjs"))]
before = identity()
checks = []
for name, argv, cwd, timeout in commands:
 if name not in selected: continue
 started = datetime.now(timezone.utc).isoformat(); wall = time.monotonic(); usage = resource.getrusage(resource.RUSAGE_CHILDREN)
 log = OUTPUT/(name+".log"); failure = None
 with log.open("x") as stream:
  try: code = subprocess.run(argv, cwd=cwd, env=ENV, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout).returncode
  except subprocess.TimeoutExpired: code = None; failure = "REGISTERED_TIMEOUT"
 after_usage = resource.getrusage(resource.RUSAGE_CHILDREN)
 checks.append({"id": name, "status": "PASS" if code == 0 else "FAIL", "command": argv, "cwd": str(cwd), "exitCode": code, "failure": failure, "startedAt": started, "finishedAt": datetime.now(timezone.utc).isoformat(), "wallMs": (time.monotonic()-wall)*1000, "childCpuMs": ((after_usage.ru_utime+after_usage.ru_stime)-(usage.ru_utime+usage.ru_stime))*1000, "log": str(log), "logSha256": hashlib.sha256(log.read_bytes()).hexdigest()})
 print(json.dumps({"id": name, "status": checks[-1]["status"]}), flush=True)
 if code != 0: break
same = before == identity()
receipt = {"schema": "finnor.r2.final-source-validation.v1", "checks": checks, "selected": sorted(selected), "sourceIdentity": before, "sourceUnchanged": same, "status": "PASS" if same and len(checks) == len(selected) and all(c["status"] == "PASS" for c in checks) else "FAIL", "money": None, "moneyStatus": "UNMETERED_LOCAL_NO_CLOUD", "qualification": "Local locked installed dependencies and built API/root. Native packaging, reconstructed source, mounted Work and protected gates are separately evidenced.", "failedCommandsRetained": True}
(OUTPUT/"receipt.json").write_text(json.dumps(receipt, indent=2)+"\n")
print(json.dumps({"output": str(OUTPUT), "status": receipt["status"]}), flush=True)
sys.exit(0 if receipt["status"] == "PASS" else 1)
