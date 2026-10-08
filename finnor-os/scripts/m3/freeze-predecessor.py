"""Freeze local committed inputs. Never imports or writes in a peer checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from datetime import datetime, timezone

repo = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
args = parser.parse_args()
output = Path(args.output).resolve()
phase = repo / "scope-pm/phase-05-m3-capital-program/scope-evidence"
if output.parent != phase or output.exists():
    raise SystemExit("A new, phase-owned receipt filename is required")


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


paths = subprocess.check_output(["git", "-C", str(repo), "ls-files", "-z"]).decode().split("\0")
closure = []
for name in paths:
    if not name or any(part in name.lower() for part in (".env", "credentials", "secret", ".pem", ".key")):
        continue
    path = repo / name
    if path.is_file() and (name.startswith(("finnor-os/", "src/", "scripts/", "e2e/", "scope-pm/phase-05-"))
                           or path.name in ("AGENTS.md", "package.json", "package-lock.json",
                                            "tsconfig.json", "postcss.config.mjs", "tailwind.config.ts")):
        closure.append({"path": name, "sha256": sha(path), "bytes": path.stat().st_size})

m1 = Path("/Users/paramdave/.factory/worktrees/pm-m1-decision-slice/FINNOR")
m1_status = git(m1, "status", "--porcelain", "--untracked-files=no")
head = git(repo, "rev-parse", "HEAD")
receipt = {
    "schema": "finnor.m3.predecessor-receipt.v2",
    "capturedAt": datetime.now(timezone.utc).isoformat(),
    "workspace": str(repo),
    "branch": git(repo, "branch", "--show-current"),
    "head": head,
    "tree": git(repo, "rev-parse", "HEAD^{tree}"),
    "parents": git(repo, "show", "-s", "--format=%P", "HEAD").split(),
    "gitCommonDirectory": git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    "remotes": git(repo, "remote", "-v").splitlines(),
    "m1": {
        "committedHead": git(m1, "rev-parse", "HEAD"),
        "committedTree": git(m1, "rev-parse", "HEAD^{tree}"),
        "modifiedTrackedPaths": [line[3:] for line in m1_status.splitlines()],
        "join": "FINAL_NATIVE_HANDOFF_UNCOMMITTED" if m1_status else "REQUIRES_OWNER_RECEIPT_VERIFICATION",
        "importedMovingFiles": False,
    },
    "p4Import": "32d7d6ba6e8bfe344a04a63ffee34e4904df654e",
    "p1": {
        "commit": "fb003abd3fc0c99c9cc25db0d153f2580e097de9",
        "tree": "e625ead88b69962371f590a5b2480b6309f9589c",
        "join": "M3_ECONOMIC_MODULE_DOMAIN_AND_AUTHENTICATED_PORT_NOT_IMPLEMENTED",
        "imported": False,
    },
    "p3": {
        "commit": "684c4f48c93d5f5e8071d3b5c344b9b1668921e1",
        "tree": "0970870361781d091d2f53663a7cc4ab6372cccd",
        "join": "P1_M3_MODULE_TRANSPORT_PENDING_REGISTERED_NATIVE_IS_NOT_ISOLATION",
        "imported": False,
    },
    "node": subprocess.check_output(["node", "--version"], text=True).strip(),
    "packages": [{
        "package": name,
        "realpath": os.path.realpath(repo / "finnor-os/node_modules/@finnor" / name),
    } for name in ("private-equity", "underwriting", "epistemic-runtime", "db", "shared-types")],
    "sourceConfigFixtureLockMigrationClosure": closure,
    "closureDigest": hashlib.sha256(json.dumps(closure, sort_keys=True).encode()).hexdigest(),
    "preexistingLocalChanges": git(repo, "status", "--porcelain").splitlines(),
    "publicPRBase": "PR_PUBLIC_BASE_UNRESOLVED_PRIVATE_CUMULATIVE_PREDECESSOR",
    "qualifications": [
        "Native baseline 9/9 is a separate immutable development receipt, not owner/product or GateM3.",
        "No peer working files, environment credentials, or private source contents are included.",
        "Darwin Seatbelt is nonconsequential and unadmitted; aggregate CPU/RSS/thread/disk quotas are absent.",
        "Actual dollars, protected admission, hosted authentication and independent comparisons are unqualified.",
    ],
}
phase.mkdir(parents=True, exist_ok=True)
with output.open("x") as file:
    json.dump(receipt, file, indent=2)
    file.write("\n")
print(json.dumps({"receipt": str(output), "sha256": sha(output), "files": len(closure),
                  "m1Join": receipt["m1"]["join"]}))
